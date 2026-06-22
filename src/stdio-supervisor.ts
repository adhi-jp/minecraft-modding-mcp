import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";

import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse
} from "@modelcontextprotocol/sdk/types.js";

import { encodeJsonRpcMessage, JsonRpcFrameReader, type ConcreteFramingMode } from "./json-rpc-framing.js";
import { log } from "./logger.js";
import { buildSuggestedCall } from "./build-suggested-call.js";
import { getToolSchema } from "./tool-schema-registry.js";

const DEFAULT_CLIENT_MODE: ConcreteFramingMode = "line";
const WORKER_MODE_ENV = "MCP_STDIO_WORKER_MODE";
const WORKER_READY_MARKER = "__MCP_STDIO_WORKER_READY__";
const SUPERVISOR_DEBUG_ENABLED = process.env.MCP_SUPERVISOR_DEBUG === "1";
const STRUCTURED_RESTART_DISABLED = process.env.SUPERVISOR_STRUCTURED_RESTART_OFF === "1";

const RESTART_WINDOW_MS = 60_000;
const RESTART_REPEAT_THRESHOLD = 3;
const REDACT_KEY_PATTERNS = [/secret/i, /token/i, /apikey/i, /password/i];
const PRESERVED_PATH_KEYS = new Set(["projectPath", "sourcePath", "mixinConfigPath"]);
const MAX_STRING_BYTES = 256;
const MAX_ARRAY_LENGTH = 8;
const MAX_OBJECT_KEYS = 16;

type SupervisorOptions = {
  entryFile: string;
};

type RequestId = string | number;

export type ExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type RetryRecommendation = "narrow-query" | "clear-cache" | "report-bug" | "same-request";

export type RestartContext = {
  toolName: string | undefined;
  durationMs: number;
  lastStage: string | undefined;
  lastStageElapsedMs: number | undefined;
  lastStageMeta: unknown;
  exit: ExitInfo;
  toolArgsRedacted: Record<string, unknown> | undefined;
  /** `true` when redaction replaced any value with a sentinel placeholder; the synthetic envelope omits `suggestedCall` in that case. */
  toolArgsRedactedModified: boolean;
  retryRecommendation: RetryRecommendation;
};

export type PendingRequestSnapshot = {
  id: RequestId;
  method?: string;
  toolName?: string;
  toolArgsRedacted?: Record<string, unknown>;
  /** `true` when toolArgsRedacted contains sentinel placeholders (truncate/redact/overflow). */
  toolArgsRedactedModified?: boolean;
  startedAt: number;
  lastStage?: string;
  lastStageStartedAt?: number;
  lastStageMeta?: unknown;
};

type PendingRequest = PendingRequestSnapshot;

function isRequest(message: JSONRPCMessage): message is JSONRPCRequest {
  return "method" in message && "id" in message;
}

function isNotification(message: JSONRPCMessage): message is JSONRPCNotification {
  return "method" in message && !("id" in message);
}

function isResponse(message: JSONRPCMessage): message is JSONRPCResponse {
  return !("method" in message) && "id" in message;
}

function getTrackedRequestId(message: { id?: unknown }): RequestId | undefined {
  return typeof message.id === "string" || typeof message.id === "number"
    ? message.id
    : undefined;
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

export function buildLegacyJsonRpcError(id: RequestId): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: "MCP worker restarted while handling the request. Retry the request."
    }
  } as JSONRPCResponse;
}

function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRedactKey(key: string): boolean {
  return REDACT_KEY_PATTERNS.some((re) => re.test(key));
}

type RedactCounter = { modified: boolean };

function redactValue(value: unknown, counter: RedactCounter, keyName?: string): unknown {
  if (keyName !== undefined && !PRESERVED_PATH_KEYS.has(keyName) && isRedactKey(keyName)) {
    counter.modified = true;
    return "<redacted>";
  }

  if (value === null || value === undefined) {
    return value;
  }

  const valueType = typeof value;

  if (valueType === "string") {
    const str = value as string;
    if (keyName !== undefined && PRESERVED_PATH_KEYS.has(keyName)) {
      return str;
    }
    const byteLen = byteLengthUtf8(str);
    if (byteLen > MAX_STRING_BYTES) {
      counter.modified = true;
      return `<truncated:${byteLen} bytes>`;
    }
    return str;
  }

  if (valueType === "number" || valueType === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      counter.modified = true;
      const head = value
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => redactValue(item, counter));
      head.push(`<+${value.length - MAX_ARRAY_LENGTH} more>`);
      return head;
    }
    return value.map((item) => redactValue(item, counter));
  }

  if (valueType === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const limited = entries.slice(0, MAX_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    for (const [key, child] of limited) {
      result[key] = redactValue(child, counter, key);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      counter.modified = true;
      result["<+more>"] = `<+${entries.length - MAX_OBJECT_KEYS} more keys>`;
    }
    return result;
  }

  return undefined;
}

export type RedactedToolArgs = {
  args: Record<string, unknown>;
  /** `true` when redaction replaced any value with a sentinel; supervisor uses this to decide whether to surface `suggestedCall`. */
  modified: boolean;
};

export function redactToolArgs(args: unknown): RedactedToolArgs {
  if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) {
    return { args: {}, modified: false };
  }
  const counter: RedactCounter = { modified: false };
  const redacted = redactValue(args, counter);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return { args: redacted as Record<string, unknown>, modified: counter.modified };
  }
  return { args: {}, modified: counter.modified };
}

export function decideRetryRecommendation(
  ctx: Pick<RestartContext, "toolName" | "lastStage" | "lastStageMeta" | "exit">,
  recentRestartTimestamps: number[]
): RetryRecommendation {
  if (ctx.lastStage === "target-lookup") {
    const meta = ctx.lastStageMeta as { targetTotal?: unknown } | undefined;
    const targetTotal = typeof meta?.targetTotal === "number" ? meta.targetTotal : undefined;
    if (targetTotal !== undefined && targetTotal > 5) {
      return "narrow-query";
    }
  }

  if (ctx.exit.signal === "SIGABRT" || ctx.exit.signal === "SIGSEGV" || ctx.exit.signal === "SIGKILL") {
    return "clear-cache";
  }

  if (recentRestartTimestamps.length >= RESTART_REPEAT_THRESHOLD) {
    return "report-bug";
  }

  return "same-request";
}

export function buildSyntheticCallToolResult(
  id: RequestId,
  ctx: RestartContext
): JSONRPCResponse {
  const tool = ctx.toolName ?? "unknown";
  const hints: string[] = [];
  if (ctx.lastStage) {
    const indexNote = (() => {
      const meta = ctx.lastStageMeta as
        | { targetIndex?: unknown; targetTotal?: unknown }
        | undefined;
      if (
        meta &&
        typeof meta.targetIndex === "number" &&
        typeof meta.targetTotal === "number"
      ) {
        return `at index ${meta.targetIndex}/${meta.targetTotal}`;
      }
      return "";
    })();
    const recommendation = (() => {
      switch (ctx.retryRecommendation) {
        case "narrow-query":
          return "narrow mixinConfigPath to one file and retry";
        case "clear-cache":
          return "clear cache and retry";
        case "report-bug":
          return "report a bug — repeated worker exits";
        case "same-request":
        default:
          return "retry the same request";
      }
    })();
    hints.push(
      `lastStage=${ctx.lastStage}${indexNote ? ` ${indexNote}` : ""} — ${recommendation}`
    );
  } else {
    hints.push("worker exited before stage tracking began");
  }

  const error: Record<string, unknown> = {
    type: "about:blank/mcp/worker-restart",
    title: "MCP worker restarted",
    detail: `The worker process exited while handling tools/call (${tool}).`,
    status: 503,
    code: "ERR_WORKER_RESTART",
    instance: `urn:mcp:request:${String(id)}`,
    hints
  };
  // Mutated args carry sentinel placeholders (`<truncated:…>`, `<redacted>`)
  // that are not safe to retry. Surface them on `meta.restart.redactedToolArgs`
  // for diagnostics instead.
  if (ctx.toolArgsRedacted !== undefined && !ctx.toolArgsRedactedModified) {
    // Only emit `suggestedCall` when the resolved tool name is a
    // currently-registered public tool. The "unknown" fallback above and
    // unregistered names (typo, disabled tool, version-skewed) cannot
    // produce a re-callable payload; buildSuggestedCall fails open for
    // unregistered names so the registration check belongs here. The
    // diagnostic `restart.redactedToolArgs` field below still surfaces the
    // args.
    if (
      ctx.toolName !== undefined &&
      ctx.toolName.length > 0 &&
      getToolSchema(ctx.toolName) !== undefined
    ) {
      const gated = buildSuggestedCall({
        tool: ctx.toolName,
        params: ctx.toolArgsRedacted as Record<string, unknown>
      });
      if (gated.suggestedCall) {
        error.suggestedCall = gated.suggestedCall;
      }
    }
  }
  if (ctx.lastStage !== undefined) {
    error.failedStage = ctx.lastStage;
  }

  const restart: Record<string, unknown> = {
    tool,
    durationMs: ctx.durationMs,
    lastStage: ctx.lastStage ?? null,
    lastStageElapsedMs: ctx.lastStageElapsedMs ?? null,
    lastStageMeta: ctx.lastStageMeta ?? null,
    exit: {
      code: ctx.exit.code,
      signal: ctx.exit.signal
    },
    retryRecommendation: ctx.retryRecommendation
  };
  // Diagnostic echo (paired with the modified flag); not retryable.
  if (ctx.toolArgsRedacted !== undefined) {
    restart.redactedToolArgs = ctx.toolArgsRedacted;
    restart.redactedToolArgsModified = ctx.toolArgsRedactedModified;
  }
  const meta: Record<string, unknown> = {
    synthetic: true,
    syntheticSource: "supervisor",
    restart
  };

  const structuredContent = { error, meta };

  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent)
        }
      ],
      isError: true,
      structuredContent
    }
  } as unknown as JSONRPCResponse;
}

export function pruneRestartTimestamps(
  timestamps: number[],
  now: number,
  windowMs = RESTART_WINDOW_MS
): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter((t) => t >= cutoff);
}

/**
 * Group a worker-exit batch by toolName and produce the per-tool pruned
 * timestamp set plus the post-exit snapshot. Grouping ensures one exit
 * counts as one death per tool regardless of how many concurrent pending
 * requests it killed. `prunedByTool` feeds `buildWorkerRestartReply`;
 * `updatedByTool` is what the caller writes back to `recentRestarts`.
 */
export function buildExitTimestampGroups(
  pendingToolNames: Iterable<string | undefined>,
  recentRestarts: Map<string, number[]>,
  now: number
): { prunedByTool: Map<string, number[]>; updatedByTool: Map<string, number[]> } {
  const prunedByTool = new Map<string, number[]>();
  const updatedByTool = new Map<string, number[]>();
  for (const raw of pendingToolNames) {
    const toolName = raw ?? "unknown";
    if (prunedByTool.has(toolName)) continue;
    const pruned = pruneRestartTimestamps(recentRestarts.get(toolName) ?? [], now);
    prunedByTool.set(toolName, pruned);
    updatedByTool.set(toolName, [...pruned, now]);
  }
  return { prunedByTool, updatedByTool };
}

export type BuildWorkerRestartReplyOptions = {
  structuredRestartDisabled?: boolean;
};

export function buildWorkerRestartReply(
  req: PendingRequestSnapshot,
  exit: ExitInfo,
  now: number,
  recentRestartTimestamps: number[],
  options: BuildWorkerRestartReplyOptions = {}
): { reply: JSONRPCResponse; updatedTimestamps: number[] } {
  if (options.structuredRestartDisabled || req.method !== "tools/call") {
    return {
      reply: buildLegacyJsonRpcError(req.id),
      updatedTimestamps: recentRestartTimestamps
    };
  }

  const pruned = pruneRestartTimestamps(recentRestartTimestamps, now);
  // Include the current restart in the count so "3 deaths in 60s →
  // report-bug" fires on the third event, not the fourth.
  const updatedTimestamps = [...pruned, now];
  const recommendation = decideRetryRecommendation(
    {
      toolName: req.toolName,
      lastStage: req.lastStage,
      lastStageMeta: req.lastStageMeta,
      exit
    },
    updatedTimestamps
  );

  const ctx: RestartContext = {
    toolName: req.toolName,
    durationMs: Math.max(0, now - req.startedAt),
    lastStage: req.lastStage,
    lastStageElapsedMs:
      req.lastStageStartedAt !== undefined
        ? Math.max(0, now - req.lastStageStartedAt)
        : undefined,
    lastStageMeta: req.lastStageMeta,
    exit,
    toolArgsRedacted: req.toolArgsRedacted,
    toolArgsRedactedModified: req.toolArgsRedactedModified ?? false,
    retryRecommendation: recommendation
  };
  return {
    reply: buildSyntheticCallToolResult(req.id, ctx),
    updatedTimestamps
  };
}

function debugSupervisor(event: string, details?: Record<string, unknown>): void {
  if (!SUPERVISOR_DEBUG_ENABLED) {
    return;
  }
  log("info", `supervisor.debug.${event}`, details);
}

export class StdioSupervisor {
  private readonly entryFile: string;
  private readonly clientReader = new JsonRpcFrameReader();
  private readonly workerReader = new JsonRpcFrameReader();
  private readonly queuedMessages: JSONRPCMessage[] = [];
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly recentRestarts = new Map<string, number[]>();

  private child: ChildProcessWithoutNullStreams | undefined;
  private childReady = false;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private workerStderrBuffer = "";
  private clientMode: ConcreteFramingMode = DEFAULT_CLIENT_MODE;
  private initializeRequest: JSONRPCRequest | undefined;
  private initializedNotification: JSONRPCNotification | undefined;
  private clientInitialized = false;
  private replayingInitialization = false;
  private initializeSentToWorker = false;

  constructor(options: SupervisorOptions) {
    this.entryFile = options.entryFile;
  }

  async start(): Promise<void> {
    process.stdin.on("data", this.handleClientData);
    process.stdin.on("error", this.handleClientError);
    process.stdin.on("end", this.handleClientClosed);
    process.stdin.on("close", this.handleClientClosed);
    process.stdin.resume();

    process.on("SIGINT", this.handleTerminateSignal);
    process.on("SIGTERM", this.handleTerminateSignal);

    this.spawnWorker();
  }

  private readonly handleClientData = (chunk: Buffer): void => {
    this.clientReader.processChunk(chunk, {
      onFrame: ({ message, mode }) => {
        this.clientMode = mode;
        this.handleClientMessage(message);
      },
      onError: (error) => {
        log("warn", "supervisor.client_parse_error", { message: error.message });
      }
    });
  };

  private readonly handleClientError = (error: Error): void => {
    log("warn", "supervisor.client_stream_error", { message: error.message });
  };

  private readonly handleClientClosed = (): void => {
    void this.shutdown();
  };

  private readonly handleTerminateSignal = (): void => {
    void this.shutdown();
  };

  private handleClientMessage(message: JSONRPCMessage): void {
    debugSupervisor("client_message", {
      hasMethod: "method" in message,
      method: "method" in message ? message.method : undefined,
      id: "id" in message ? message.id : undefined,
      childReady: this.childReady
    });
    if (isRequest(message) && message.method === "initialize") {
      this.initializeRequest = message;
      this.clientInitialized = false;
    } else if (isNotification(message) && message.method === "notifications/initialized") {
      this.initializedNotification = message;
    }

    if (!this.childReady) {
      this.queuedMessages.push(message);
      return;
    }

    this.forwardToWorker(message);
  }

  private forwardToWorker(message: JSONRPCMessage): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      this.queuedMessages.push(message);
      if (!this.shuttingDown) {
        this.scheduleRestart();
      }
      return;
    }

    if (isRequest(message)) {
      const id = getTrackedRequestId(message);
      if (id !== undefined) {
        const pending: PendingRequest = {
          id,
          method: message.method,
          startedAt: performance.now()
        };
        if (message.method === "tools/call") {
          const params = (message.params ?? {}) as {
            name?: unknown;
            arguments?: unknown;
          };
          if (typeof params.name === "string") {
            pending.toolName = params.name;
          }
          const redacted = redactToolArgs(params.arguments);
          pending.toolArgsRedacted = redacted.args;
          pending.toolArgsRedactedModified = redacted.modified;
        }
        this.pendingRequests.set(requestKey(id), pending);
      }
      if (message.method === "initialize") {
        this.initializeSentToWorker = true;
      }
    }

    debugSupervisor("forward_to_worker", {
      method: "method" in message ? message.method : undefined,
      id: "id" in message ? message.id : undefined
    });
    child.stdin.write(encodeJsonRpcMessage(message, "content-length"));
  }

  private spawnWorker(): void {
    if (this.shuttingDown) {
      return;
    }

    const stale = this.child;
    if (stale) {
      this.detachChild();
      if (stale.exitCode === null) {
        stale.kill("SIGTERM");
      }
    }

    const child = spawn(process.execPath, [...process.execArgv, this.entryFile], {
      env: {
        ...process.env,
        [WORKER_MODE_ENV]: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child = child;
    this.childReady = false;
    this.initializeSentToWorker = false;
    this.workerReader.clear();
    this.workerStderrBuffer = "";

    child.stdout.on("data", this.handleWorkerData);
    child.stderr.on("data", this.handleWorkerStderr);
    child.stdin.on("error", this.handleWorkerStdinError);
    child.once("error", (error) => this.handleWorkerProcessError(child, error));
    child.once("exit", (code, signal) => this.handleWorkerExit(child, code, signal));

    log("info", "supervisor.worker_spawn", { pid: child.pid });
  }

  private readonly handleWorkerData = (chunk: Buffer): void => {
    this.workerReader.processChunk(chunk, {
      onFrame: ({ message }) => {
        this.handleWorkerMessage(message);
      },
      onError: (error) => {
        log("warn", "supervisor.worker_parse_error", { message: error.message });
      }
    });
  };

  private readonly handleWorkerStdinError = (error: Error): void => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      return;
    }
    log("warn", "supervisor.worker_stdin_error", { message: error.message });
  };

  private readonly handleWorkerStderr = (chunk: Buffer | string): void => {
    this.workerStderrBuffer += chunk.toString();
    const lines = this.workerStderrBuffer.split(/\r?\n/);
    this.workerStderrBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === WORKER_READY_MARKER) {
        this.handleWorkerReady();
        continue;
      }
      process.stderr.write(`${line}\n`);
    }
  };

  private handleWorkerProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
    log("error", "supervisor.worker_process_error", { message: error.message });

    if (child !== this.child) {
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    this.handleWorkerExit(child, null, null);
  }

  private handleWorkerExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (child !== this.child) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      return;
    }

    const childPid = this.child?.pid;
    this.detachChild();

    if (this.shuttingDown) {
      return;
    }

    log("warn", "supervisor.worker_exit", {
      pid: childPid,
      code,
      signal,
      pendingRequests: this.pendingRequests.size
    });

    this.failPendingRequestsOnWorkerExit({ code, signal });
    this.scheduleRestart();
  }

  private handleWorkerMessage(message: JSONRPCMessage): void {
    debugSupervisor("worker_message", {
      hasMethod: "method" in message,
      method: "method" in message ? message.method : undefined,
      id: "id" in message ? message.id : undefined,
      replayingInitialization: this.replayingInitialization
    });

    if (isNotification(message) && typeof message.method === "string" && message.method.startsWith("$/")) {
      if (message.method === "$/stageUpdate") {
        this.applyStageUpdate(message.params);
      }
      return;
    }

    if (this.isInitializationResponse(message)) {
      const id = getTrackedRequestId(message);
      if (id !== undefined) {
        this.pendingRequests.delete(requestKey(id));
      }

      if (this.replayingInitialization) {
        this.replayingInitialization = false;
        if (this.initializedNotification) {
          this.forwardToWorker(this.initializedNotification);
        }
        this.childReady = true;
        this.flushQueue();
        return;
      }

      this.clientInitialized = true;
      this.childReady = true;
      this.writeToClient(message);
      this.flushQueue();
      return;
    }

    if (isResponse(message)) {
      const id = getTrackedRequestId(message);
      if (id !== undefined) {
        this.pendingRequests.delete(requestKey(id));
      }
    }

    this.writeToClient(message);
  }

  private applyStageUpdate(params: unknown): void {
    if (params === null || params === undefined || typeof params !== "object") {
      return;
    }
    const p = params as {
      stage?: unknown;
      meta?: unknown;
      requestId?: unknown;
    };
    const requestId =
      typeof p.requestId === "string" || typeof p.requestId === "number"
        ? p.requestId
        : undefined;
    if (requestId === undefined) return;
    const pending = this.pendingRequests.get(requestKey(requestId));
    if (!pending) return;
    // Refresh `lastStageStartedAt` only on stage transitions so
    // `lastStageElapsedMs` measures from stage entry, not from the latest
    // per-target emit. `lastStageMeta` still updates on every emit so
    // restart envelopes carry the latest progress payload.
    if (typeof p.stage === "string" && p.stage !== pending.lastStage) {
      pending.lastStage = p.stage;
      pending.lastStageStartedAt = performance.now();
    } else if (pending.lastStageStartedAt === undefined) {
      // First emit for this request; bootstrap the stage timer.
      pending.lastStageStartedAt = performance.now();
    }
    pending.lastStageMeta = p.meta;
  }

  private handleWorkerReady(): void {
    debugSupervisor("worker_ready", {
      hasInitializeRequest: this.initializeRequest !== undefined,
      clientInitialized: this.clientInitialized
    });

    if (!this.initializeRequest) {
      this.childReady = true;
      this.flushQueue();
      return;
    }

    this.replayingInitialization = this.clientInitialized;
    this.forwardToWorker(this.initializeRequest);
  }

  private isInitializationResponse(message: JSONRPCMessage): message is JSONRPCResponse {
    const id = isResponse(message) ? getTrackedRequestId(message) : undefined;
    const initializeId = this.initializeRequest
      ? getTrackedRequestId(this.initializeRequest)
      : undefined;
    return (
      id !== undefined &&
      initializeId !== undefined &&
      requestKey(id) === requestKey(initializeId)
    );
  }

  private flushQueue(): void {
    if (!this.childReady || this.queuedMessages.length === 0) {
      return;
    }

    const pending = this.queuedMessages.splice(0, this.queuedMessages.length);
    for (const message of pending) {
      if (
        this.initializeSentToWorker &&
        isRequest(message) &&
        message.method === "initialize" &&
        this.initializeRequest !== undefined &&
        getTrackedRequestId(message) === getTrackedRequestId(this.initializeRequest)
      ) {
        continue;
      }
      this.forwardToWorker(message);
    }
  }

  private failPendingRequestsOnWorkerExit(exit: ExitInfo): void {
    const preservedInitializeKey = this.initializeRequest
      ? requestKey(this.initializeRequest.id)
      : undefined;

    const now = performance.now();

    // Record this exit once per toolName regardless of how many concurrent
    // pending requests it killed; per-request recording would inflate the
    // count to N and falsely escalate retryRecommendation to "report-bug".
    const pendingToolNames: Array<string | undefined> = [];
    for (const [key, pending] of this.pendingRequests.entries()) {
      if (key === preservedInitializeKey) continue;
      pendingToolNames.push(pending.toolName);
    }
    const { prunedByTool, updatedByTool } = buildExitTimestampGroups(
      pendingToolNames,
      this.recentRestarts,
      now
    );
    for (const [toolName, updated] of updatedByTool) {
      this.recentRestarts.set(toolName, updated);
    }

    for (const [key, pending] of [...this.pendingRequests.entries()]) {
      if (key === preservedInitializeKey) continue;
      this.pendingRequests.delete(key);
      const toolName = pending.toolName ?? "unknown";
      const pruned = prunedByTool.get(toolName) ?? [];
      const { reply } = buildWorkerRestartReply(
        pending,
        exit,
        now,
        pruned,
        { structuredRestartDisabled: STRUCTURED_RESTART_DISABLED }
      );
      this.writeToClient(reply);
    }
  }

  private writeToClient(message: JSONRPCMessage): void {
    debugSupervisor("write_to_client", {
      hasMethod: "method" in message,
      method: "method" in message ? message.method : undefined,
      id: "id" in message ? message.id : undefined,
      clientMode: this.clientMode
    });
    const frame = encodeJsonRpcMessage(message, this.clientMode);
    process.stdout.write(frame);
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.shuttingDown) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnWorker();
    }, 100);
  }

  private detachChild(): void {
    const child = this.child;
    if (!child) {
      this.childReady = false;
      return;
    }

    child.stdout.off("data", this.handleWorkerData);
    child.stderr.off("data", this.handleWorkerStderr);
    child.stdin.off("error", this.handleWorkerStdinError);
    child.removeAllListeners("error");
    child.removeAllListeners("exit");
    this.child = undefined;
    this.childReady = false;
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    process.stdin.off("data", this.handleClientData);
    process.stdin.off("error", this.handleClientError);
    process.stdin.off("end", this.handleClientClosed);
    process.stdin.off("close", this.handleClientClosed);
    process.off("SIGINT", this.handleTerminateSignal);
    process.off("SIGTERM", this.handleTerminateSignal);

    const child = this.child;
    this.detachChild();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
}

export const STDIO_WORKER_MODE_ENV = WORKER_MODE_ENV;
