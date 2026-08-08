import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";

import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse
} from "@modelcontextprotocol/server";

import { encodeJsonRpcMessage, JsonRpcFrameReader, type ConcreteFramingMode } from "./json-rpc-framing.js";
import { log } from "./logger.js";
import { buildSuggestedCall } from "./build-suggested-call.js";
import { getToolSchema } from "./tool-schema-registry.js";
import {
  buildEraConflictRejection,
  buildMethodNotFoundRejection,
  buildMissingMetaRejection,
  classifyEraSignal,
  type Era
} from "./era-classifier.js";

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
const DEFAULT_VALIDATE_PROJECT_TIMEOUT_MS = 120_000;
const MIN_VALIDATE_PROJECT_TIMEOUT_MS = 10_000;
const MAX_VALIDATE_PROJECT_TIMEOUT_MS = 600_000;
const MAX_WORKER_STARTUP_WATCHDOG_MS = 30_000;
const MAX_SUPERVISOR_QUEUE = 2;
const DEFAULT_TREE_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TOKEN_RETRY_BASE_MS = 1_000;
const DEFAULT_CLEANUP_TOKEN_RETRY_CAP_MS = 30_000;

export function loadValidateProjectTimeoutMs(value = process.env.MCP_VALIDATE_PROJECT_TIMEOUT_MS): number {
  if (!/^[0-9]+$/.test(value ?? "")) {
    return DEFAULT_VALIDATE_PROJECT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_VALIDATE_PROJECT_TIMEOUT_MS ||
    parsed > MAX_VALIDATE_PROJECT_TIMEOUT_MS
  ) {
    return DEFAULT_VALIDATE_PROJECT_TIMEOUT_MS;
  }
  return parsed;
}

export function computeWorkerStartupWatchdogMs(validateProjectTimeoutMs: number): number {
  return Math.min(validateProjectTimeoutMs, MAX_WORKER_STARTUP_WATCHDOG_MS);
}

export function computeRestartBackoffMs(retryIndex: number): number {
  if (!Number.isFinite(retryIndex) || retryIndex <= 0) {
    return 100;
  }
  return Math.min(100 * (2 ** Math.floor(retryIndex)), MAX_WORKER_STARTUP_WATCHDOG_MS);
}

export function terminatePosixProcessGroup(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill
): boolean {
  try {
    kill(-pid, "SIGKILL");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") {
      return true;
    }
    return false;
  }
}

export function buildWindowsTreeKillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

export function shouldRetainUnavailableNotification(method: string): boolean {
  return method === "notifications/initialized";
}

export type RestartReservation = {
  epoch: number;
  notBefore: number;
  delayMs: number;
};

export class RestartBackoffState {
  private retryIndex = 0;
  private epoch = 0;

  reserve(now: number): RestartReservation {
    const delayMs = computeRestartBackoffMs(this.retryIndex);
    this.retryIndex += 1;
    return {
      epoch: ++this.epoch,
      notBefore: now + delayMs,
      delayMs
    };
  }

  reset(): void {
    this.retryIndex = 0;
  }
}

export function retryPosixTreeToken(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill
): boolean {
  return terminatePosixProcessGroup(pid, kill);
}

export async function settleTreeCleanupWithin(
  operation: Promise<boolean>,
  timeoutMs: number,
  onTimeout: () => void = () => {}
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { onTimeout(); } catch { /* best effort */ }
      finish(false);
    }, timeoutMs);
    operation.then(finish, () => finish(false));
  });
}

export type SupervisorOptions = {
  entryFile: string;
  validateProjectTimeoutMs?: number;
  clientWriter?: (message: JSONRPCMessage) => void;
  treeTokenRetrier?: (pid: number) => boolean | Promise<boolean>;
  treeCleanupTimeoutMs?: number;
  cleanupTokenRetryBaseMs?: number;
  cleanupTokenRetryCapMs?: number;
  eventWriter?: (
    level: "warn" | "error" | "info",
    event: string,
    details?: Record<string, unknown>
  ) => void;
  monotonicNow?: () => number;
  timerScheduler?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  timerClearer?: (timer: NodeJS.Timeout) => void;
  workerSpawner?: () => ChildProcessWithoutNullStreams;
  treeTerminator?: (pid: number) => boolean | Promise<boolean>;
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
  /**
   * Framing mode of the inbound frame that carried this request, captured at
   * admission. Every terminal client-bound write for this request (forwarded
   * worker response, timeout/queue-limit/restart synthesis) uses THIS mode —
   * never the connection's latest inbound mode. Retained for the pending
   * entry's whole lifetime (including client-cancelled tombstones) until the
   * entry is discarded.
   */
  mode?: ConcreteFramingMode;
  lastStage?: string;
  lastStageStartedAt?: number;
  lastStageMeta?: unknown;
};

type PendingRequest = PendingRequestSnapshot & {
  deadlineTimer?: NodeJS.Timeout;
  timeoutPhase?: "queue" | "running";
  clientCancelled?: boolean;
};

type QueuedRequest = {
  message: JSONRPCRequest;
  pending: PendingRequest;
};

type CleanupState = {
  pid: number;
  status: "pending" | "accepted" | "unresolved";
  parentExited: boolean;
};

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

function redactDiagnosticValue(value: unknown): unknown {
  const counter: RedactCounter = { modified: false };
  return redactValue(value, counter) ?? null;
}

function buildSyntheticToolResult(
  id: RequestId,
  structuredContent: Record<string, unknown>
): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      isError: true,
      structuredContent
    }
  } as unknown as JSONRPCResponse;
}

export function buildSupervisorQueueLimitReply(id: RequestId, method: string): JSONRPCResponse {
  if (method !== "tools/call") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "MCP supervisor request queue is full."
      }
    } as JSONRPCResponse;
  }

  return buildSyntheticToolResult(id, {
    error: {
      type: "about:blank/mcp/limit-exceeded",
      title: "Supervisor queue limit exceeded",
      detail: "The MCP supervisor request queue is full.",
      status: 413,
      code: "ERR_LIMIT_EXCEEDED",
      instance: `urn:mcp:request:${String(id)}`,
      retryClass: "transient",
      issueOrigin: "tool_issue",
      hints: ["Retry after the supervisor queue drains."]
    },
    meta: {
      synthetic: true,
      syntheticSource: "supervisor",
      queue: {
        reason: "supervisor-request-queue",
        maxQueued: MAX_SUPERVISOR_QUEUE,
        queuedCount: MAX_SUPERVISOR_QUEUE
      }
    }
  });
}

export type BuildValidateProjectTimeoutReplyInput = {
  request: PendingRequestSnapshot;
  phase: "queue" | "running";
  deadlineMs: number;
  now: number;
  workerRestartInitiated: boolean;
};

export function buildValidateProjectTimeoutReply(
  input: BuildValidateProjectTimeoutReplyInput
): JSONRPCResponse {
  const { request, phase, deadlineMs, now, workerRestartInitiated } = input;
  const retryRecommendation = decideRetryRecommendation(
    {
      toolName: "validate-project",
      lastStage: request.lastStage,
      lastStageMeta: request.lastStageMeta,
      exit: { code: null, signal: null }
    },
    []
  );
  const error: Record<string, unknown> = {
    type: "about:blank/mcp/tool-timeout",
    title: "MCP tool timed out",
    detail: `validate-project exceeded its ${deadlineMs} ms deadline.`,
    status: 408,
    code: "ERR_TOOL_TIMEOUT",
    instance: `urn:mcp:request:${String(request.id)}`,
    retryClass: "transient",
    issueOrigin: "tool_issue",
    hints: ["Retry the request or narrow the validation scope."]
  };
  if (
    request.toolName === "validate-project" &&
    request.toolArgsRedacted !== undefined &&
    !request.toolArgsRedactedModified &&
    getToolSchema("validate-project") !== undefined
  ) {
    const gated = buildSuggestedCall({
      tool: "validate-project",
      params: request.toolArgsRedacted
    });
    if (gated.suggestedCall) {
      error.suggestedCall = gated.suggestedCall;
    }
  }

  return buildSyntheticToolResult(request.id, {
    error,
    meta: {
      synthetic: true,
      syntheticSource: "supervisor",
      timeout: {
        tool: "validate-project",
        phase,
        durationMs: Math.max(0, now - request.startedAt),
        deadlineMs,
        lastStage: request.lastStage ?? null,
        lastStageElapsedMs:
          request.lastStageStartedAt === undefined
            ? null
            : Math.max(0, now - request.lastStageStartedAt),
        lastStageMeta: redactDiagnosticValue(request.lastStageMeta),
        redactedToolArgs: request.toolArgsRedacted ?? {},
        redactedToolArgsModified: request.toolArgsRedactedModified ?? false,
        retryRecommendation,
        workerRestartInitiated
      }
    }
  });
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
  private readonly validateProjectTimeoutMs: number;
  private readonly workerStartupWatchdogMs: number;
  private readonly clientWriter: ((message: JSONRPCMessage) => void) | undefined;
  private readonly treeTokenRetrier: ((pid: number) => boolean | Promise<boolean>) | undefined;
  private readonly treeCleanupTimeoutMs: number;
  private readonly cleanupTokenRetryBaseMs: number;
  private readonly cleanupTokenRetryCapMs: number;
  private readonly eventWriter: NonNullable<SupervisorOptions["eventWriter"]>;
  private readonly monotonicNow: () => number;
  private readonly timerScheduler: NonNullable<SupervisorOptions["timerScheduler"]>;
  private readonly timerClearer: NonNullable<SupervisorOptions["timerClearer"]>;
  private readonly workerSpawner: () => ChildProcessWithoutNullStreams;
  private readonly treeTerminator: ((pid: number) => boolean | Promise<boolean>) | undefined;
  private readonly clientReader = new JsonRpcFrameReader();
  private readonly workerReaders = new Map<ChildProcessWithoutNullStreams, JsonRpcFrameReader>();
  private readonly queuedRequests: QueuedRequest[] = [];
  private readonly queuedNotifications: JSONRPCMessage[] = [];
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly recentRestarts = new Map<string, number[]>();
  private readonly liveChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly staleChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly cleanupStates = new Map<ChildProcessWithoutNullStreams, CleanupState>();
  private readonly unresolvedTreeTokens = new Set<number>();
  private readonly restartBackoff = new RestartBackoffState();
  private readonly terminalChildren = new WeakSet<ChildProcessWithoutNullStreams>();

  private child: ChildProcessWithoutNullStreams | undefined;
  private childReady = false;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private cleanupRetryTimer: NodeJS.Timeout | undefined;
  private cleanupRetryIndex = 0;
  private readonly cleanupRetryAttempts = new Map<number, number>();
  private readonly cleanupRetriesInFlight = new Map<number, Promise<void>>();
  private startupWatchdog: NodeJS.Timeout | undefined;
  private validateBarrierKey: string | undefined;
  private runningValidateKey: string | undefined;
  private attemptToken = 0;
  private currentRetryEpoch: number | undefined;
  private currentRetryReservation: RestartReservation | undefined;
  private retryPaused = false;
  private workerStderrBuffer = "";
  /**
   * Framing mode of the most recently detected inbound client frame. NOT used
   * for request-correlated writes (those use the originating request's
   * captured mode); this is only the documented fallback for client-bound
   * writes that correlate to no request id (worker-originated notifications
   * and server->client requests forwarded at handleWorkerMessage, and late
   * responses whose pending entry was already discarded).
   */
  private lastInboundClientMode: ConcreteFramingMode = DEFAULT_CLIENT_MODE;
  /**
   * Per-frame framing mode of every inbound client message, keyed by message
   * object identity. Lets admission (createPendingRequest), queued-message
   * flushes, and initialize replay recover the ORIGINATING frame's mode long
   * after the frame was parsed.
   */
  private readonly inboundFrameModes = new WeakMap<object, ConcreteFramingMode>();
  private initializeRequest: JSONRPCRequest | undefined;
  private initializedNotification: JSONRPCNotification | undefined;
  private clientInitialized = false;
  private replayingInitialization = false;
  private initializeSentToWorker = false;
  /**
   * Process-lifetime era state. The supervisor is the SOLE era gatekeeper:
   * classification happens at admission (handleClientMessage), in stdin
   * order. The first valid NON-discover era signal locks the era (initialize
   * → legacy; shallow-valid modern `_meta` request → modern); the lock is
   * one-way and survives worker restarts.
   */
  private era: Era = "unselected";

  constructor(options: SupervisorOptions) {
    this.entryFile = options.entryFile;
    this.validateProjectTimeoutMs = options.validateProjectTimeoutMs ?? loadValidateProjectTimeoutMs();
    this.workerStartupWatchdogMs = computeWorkerStartupWatchdogMs(this.validateProjectTimeoutMs);
    this.clientWriter = options.clientWriter;
    this.treeTokenRetrier = options.treeTokenRetrier;
    this.treeCleanupTimeoutMs = options.treeCleanupTimeoutMs ?? DEFAULT_TREE_CLEANUP_TIMEOUT_MS;
    this.cleanupTokenRetryBaseMs = Math.max(
      1,
      Math.floor(options.cleanupTokenRetryBaseMs ?? DEFAULT_CLEANUP_TOKEN_RETRY_BASE_MS)
    );
    this.cleanupTokenRetryCapMs = Math.max(
      this.cleanupTokenRetryBaseMs,
      Math.floor(options.cleanupTokenRetryCapMs ?? DEFAULT_CLEANUP_TOKEN_RETRY_CAP_MS)
    );
    this.eventWriter = options.eventWriter ?? log;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.timerScheduler = options.timerScheduler ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.timerClearer = options.timerClearer ?? ((timer) => clearTimeout(timer));
    this.workerSpawner = options.workerSpawner ?? (() => spawn(process.execPath, [...process.execArgv, this.entryFile], {
      env: {
        ...process.env,
        [WORKER_MODE_ENV]: "1"
      },
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32" ? {} : { detached: true })
    }));
    this.treeTerminator = options.treeTerminator;
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
        this.inboundFrameModes.set(message as object, mode);
        this.lastInboundClientMode = mode;
        this.handleClientMessage(message);
      },
      onError: (error) => {
        log("warn", "supervisor.client_parse_error", { message: error.message });
      }
    });
  };

  /** The captured per-frame mode of an inbound client message, if known. */
  private modeForMessage(message: JSONRPCMessage | undefined): ConcreteFramingMode | undefined {
    return message === undefined ? undefined : this.inboundFrameModes.get(message as object);
  }

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
    if (isNotification(message)) {
      this.handleClientNotification(message);
      return;
    }

    if (!isRequest(message)) {
      return;
    }

    if (message.method === "initialize") {
      // initialize is the legacy era signal regardless of any _meta envelope
      // it carries: the envelope is ignored for era classification here.
      if (this.era === "modern") {
        // One-way era lock: a rejected initialize is NEVER captured into the
        // replay cache.
        this.writeToClient(
          buildEraConflictRejection(message.id as RequestId, "modern"),
          this.modeForMessage(message)
        );
        return;
      }
      this.era = "legacy";
      if (!this.child && this.liveCapOccupancy() >= 2) {
        // Capture-ordering fix: the cap-blocked rejection happens BEFORE
        // capture, so a rejected initialize can never enter (or corrupt) the
        // replay cache. clearInitialInitializationState() still discards any
        // NOT-yet-completed earlier handshake, exactly as before.
        this.clearInitialInitializationState();
        this.writeToClient(buildLegacyJsonRpcError(message.id as RequestId), this.modeForMessage(message));
        return;
      }
      this.initializeRequest = message;
      this.clientInitialized = false;
      if (this.childReady) {
        this.forwardRequest(message, this.createPendingRequest(message));
      } else {
        const existing = this.queuedNotifications.findIndex(
          (entry) => isRequest(entry) && entry.method === "initialize"
        );
        if (existing >= 0) this.queuedNotifications.splice(existing, 1);
        this.queuedNotifications.push(message);
      }
      return;
    }

    if (!this.admitEraRequest(message)) {
      return;
    }

    const pending = this.createPendingRequest(message);
    if (!this.child && this.liveCapOccupancy() >= 2) {
      const { reply } = buildWorkerRestartReply(
        pending,
        { code: null, signal: null },
        this.monotonicNow(),
        [],
        { structuredRestartDisabled: STRUCTURED_RESTART_DISABLED }
      );
      this.writeToClient(reply, pending.mode);
      return;
    }
    const isValidate = pending.toolName === "validate-project";
    const dispatchImmediately = this.canDispatchImmediately(pending);
    if (!dispatchImmediately && this.queuedRequests.length >= MAX_SUPERVISOR_QUEUE) {
      this.writeToClient(
        buildSupervisorQueueLimitReply(pending.id, pending.method ?? message.method),
        pending.mode
      );
      this.drainQueue();
      return;
    }

    if (isValidate) {
      pending.timeoutPhase = "queue";
      const elapsedAtAdmission = Math.max(0, this.monotonicNow() - pending.startedAt);
      pending.deadlineTimer = this.timerScheduler(
        () => this.handleValidateProjectDeadline(requestKey(pending.id)),
        Math.max(0, this.validateProjectTimeoutMs - elapsedAtAdmission)
      );
      pending.deadlineTimer.unref();
      if (!this.validateBarrierKey) {
        this.validateBarrierKey = requestKey(pending.id);
      }
    }

    if (dispatchImmediately) {
      this.forwardRequest(message, pending);
      return;
    }
    this.queuedRequests.push({ message, pending });
  }

  /**
   * Era-aware notification dispatch. notifications/cancelled stays
   * supervisor-side in ALL eras/states; notifications/initialized is captured
   * and forwarded only within a legacy flow; every other notification is
   * gated by the era rules before reaching the original forwarding path.
   * Dropped variants emit NO response and never affect subsequent traffic.
   */
  private handleClientNotification(message: JSONRPCNotification): void {
    if (message.method === "notifications/cancelled") {
      this.handleCancellation(message);
      return;
    }

    if (message.method === "notifications/initialized") {
      if (this.era !== "legacy") {
        // A stray initialized outside a legacy flow is dropped and NEVER
        // captured: forwarding (or later replaying) it would pin a worker
        // connection legacy.
        this.eventWriter("warn", "supervisor.notification_dropped", {
          method: message.method,
          reason: this.era === "modern" ? "era-conflict" : "era-unselected"
        });
        return;
      }
      if (this.initializeRequest === undefined) {
        // Legacy era but NO handshake in progress (e.g. after a cap-rejected
        // initialize): capturing here could later replay the stray frame
        // around an uninitialized worker. Drop, never capture.
        this.eventWriter("warn", "supervisor.notification_dropped", {
          method: message.method,
          reason: "no-active-handshake"
        });
        return;
      }
      this.initializedNotification = message;
    } else if (this.era === "unselected") {
      if (this.childReady) {
        // Consumed at the supervisor: forwarding any notification before an
        // era is selected would pin the worker connection legacy. The
        // worker-unavailable branch below keeps its original drop reasons.
        this.eventWriter("warn", "supervisor.notification_dropped", {
          method: message.method,
          reason: "era-unselected"
        });
        return;
      }
    } else {
      const signal = classifyEraSignal(message.params);
      if (this.era === "legacy" && signal.classification === "modern-signal") {
        // Only shallow-VALID modern signals conflict with the legacy lock;
        // claim-less and claim-shaped-invalid notifications forward as today
        // (the legacy era stays maximally permissive).
        this.eventWriter("warn", "supervisor.notification_dropped", {
          method: message.method,
          reason: "era-conflict"
        });
        return;
      }
      if (this.era === "modern" && signal.classification !== "modern-signal") {
        this.eventWriter("warn", "supervisor.notification_dropped", {
          method: message.method,
          reason: "missing-meta"
        });
        return;
      }
    }

    if (!this.childReady) {
      if (!shouldRetainUnavailableNotification(message.method)) {
        this.eventWriter("warn", "supervisor.notification_dropped", {
          method: message.method,
          reason: this.liveCapOccupancy() >= 2 ? "live-cap-blocked" : "worker-unavailable"
        });
      }
      return;
    }
    if (this.child && !this.child.stdin.destroyed) {
      this.writeToWorker(this.child, message);
    }
  }

  /**
   * Era rules for non-initialize requests, applied at admission in stdin
   * order. Returns false when the request was terminally rejected here (a
   * supervisor-produced response was written; nothing may be forwarded or
   * queued). When it returns true the caller proceeds through the original
   * era-less admission path unchanged.
   */
  private admitEraRequest(message: JSONRPCRequest): boolean {
    const signal = classifyEraSignal(message.params);
    const mode = this.modeForMessage(message);
    const id = message.id as RequestId;

    if (message.method === "subscriptions/listen" && this.era !== "legacy") {
      if (signal.classification !== "modern-signal") {
        // The shallow envelope check applies to EVERY request at admission:
        // a non-signal listen fails -32602 before the method-level -32601.
        this.writeToClient(
          buildMissingMetaRejection(id, signal, this.era === "modern" ? "modern" : "unselected"),
          mode
        );
        return false;
      }
      if (this.era === "unselected") {
        // The modern-signal on subscriptions/listen counts as the
        // era-locking signal even though the method itself is rejected:
        // lock modern first, then reject.
        this.lockModernEra();
      }
      this.writeToClient(buildMethodNotFoundRejection(id), mode);
      return false;
    }

    if (message.method === "server/discover") {
      // server/discover is ERA-NEUTRAL: it forwards under the legacy lock
      // (the legacy-pinned worker answers -32601) and a modern-signal
      // discover forwards WITHOUT locking; only signal-less discovers in
      // non-legacy states are rejected.
      if (this.era === "legacy" || signal.classification === "modern-signal") {
        return true;
      }
      this.writeToClient(
        buildMissingMetaRejection(id, signal, this.era === "modern" ? "modern" : "unselected"),
        mode
      );
      return false;
    }

    if (signal.classification === "modern-signal") {
      if (this.era === "legacy") {
        this.writeToClient(buildEraConflictRejection(id, "legacy"), mode);
        return false;
      }
      if (this.era === "unselected") {
        this.lockModernEra();
      }
      return true;
    }

    if (this.era === "legacy") {
      // Legacy-locked behavior is otherwise UNCHANGED: claim-less AND
      // claim-shaped-invalid traffic forwards exactly as before the era gate.
      return true;
    }
    this.writeToClient(
      buildMissingMetaRejection(id, signal, this.era === "modern" ? "modern" : "unselected"),
      mode
    );
    return false;
  }

  /**
   * One-way modern lock. Purges the cached legacy lifecycle state so no
   * initialize/notifications/initialized can ever reach a worker in a
   * modern-locked process — across ALL later worker generations.
   */
  private lockModernEra(): void {
    this.era = "modern";
    this.initializeRequest = undefined;
    this.initializedNotification = undefined;
    this.clientInitialized = false;
    this.replayingInitialization = false;
    this.initializeSentToWorker = false;
  }

  private createPendingRequest(message: JSONRPCRequest): PendingRequest {
    const pending: PendingRequest = {
      id: message.id as RequestId,
      method: message.method,
      startedAt: this.monotonicNow(),
      mode: this.modeForMessage(message)
    };
    if (message.method === "tools/call") {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name === "string") pending.toolName = params.name;
      const redacted = redactToolArgs(params.arguments);
      pending.toolArgsRedacted = redacted.args;
      pending.toolArgsRedactedModified = redacted.modified;
    }
    return pending;
  }

  private canDispatchImmediately(pending: PendingRequest): boolean {
    if (!this.childReady || !this.child || this.child.stdin.destroyed) return false;
    if (pending.toolName === "validate-project") {
      return (
        this.pendingRequests.size === 0 &&
        this.runningValidateKey === undefined &&
        this.staleChildren.size === 0 &&
        this.unresolvedTreeTokens.size === 0 &&
        this.queuedRequests.length === 0
      );
    }
    return this.validateBarrierKey === undefined;
  }

  private forwardRequest(message: JSONRPCRequest, pending: PendingRequest): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      if (this.queuedRequests.length < MAX_SUPERVISOR_QUEUE) {
        this.queuedRequests.push({ message, pending });
      } else {
        if (pending.deadlineTimer) this.timerClearer(pending.deadlineTimer);
        this.writeToClient(
          buildSupervisorQueueLimitReply(pending.id, pending.method ?? message.method),
          pending.mode
        );
      }
      this.scheduleRestart();
      return;
    }

    this.pendingRequests.set(requestKey(pending.id), pending);
    if (pending.toolName === "validate-project") {
      pending.timeoutPhase = "running";
      this.runningValidateKey = requestKey(pending.id);
      this.validateBarrierKey = requestKey(pending.id);
    }
    if (message.method === "initialize") this.initializeSentToWorker = true;

    debugSupervisor("forward_to_worker", {
      method: "method" in message ? message.method : undefined,
      id: "id" in message ? message.id : undefined
    });
    this.writeToWorker(child, message);
  }

  private writeToWorker(child: ChildProcessWithoutNullStreams, message: JSONRPCMessage): void {
    child.stdin.write(encodeJsonRpcMessage(message, "content-length"));
  }

  private handleCancellation(message: JSONRPCNotification): void {
    const params = (message.params ?? {}) as { requestId?: unknown };
    const targetId = params.requestId;
    if (typeof targetId !== "string" && typeof targetId !== "number") {
      return;
    }
    const key = requestKey(targetId);
    const queuedIndex = this.queuedRequests.findIndex(
      (entry) => requestKey(entry.pending.id) === key
    );
    if (queuedIndex >= 0) {
      const [{ pending }] = this.queuedRequests.splice(queuedIndex, 1);
      if (pending.deadlineTimer) this.timerClearer(pending.deadlineTimer);
      if (this.validateBarrierKey === key) this.validateBarrierKey = undefined;
      this.drainQueue();
      return;
    }

    const pending = this.pendingRequests.get(key);
    if (pending?.toolName === "validate-project") {
      pending.clientCancelled = true;
    }
    if (this.era === "unselected") {
      // Never forward: the cancellation could be a worker connection's first
      // frame and would legacy-pin it. Supervisor-side bookkeeping above
      // still applies — which means an in-flight era-neutral discover cannot
      // be cancelled server-side (accepted limitation).
      return;
    }
    if (this.era === "modern" && classifyEraSignal(message.params).classification !== "modern-signal") {
      // A claim-less/invalid cancellation must never reach a modern-locked
      // worker connection: after a restart it could be the fresh
      // generation's FIRST frame and the SDK would classify the opening
      // frame legacy. Bookkeeping above still cancels supervisor-side.
      this.eventWriter("warn", "supervisor.notification_dropped", {
        method: message.method,
        reason: "missing-meta"
      });
      return;
    }
    const child = this.child;
    if (child && !child.stdin.destroyed) {
      this.writeToWorker(child, message);
    }
  }

  private handleValidateProjectDeadline(key: string): void {
    const queuedIndex = this.queuedRequests.findIndex(
      (entry) => requestKey(entry.pending.id) === key
    );
    if (queuedIndex >= 0) {
      const [{ pending }] = this.queuedRequests.splice(queuedIndex, 1);
      if (pending.deadlineTimer) this.timerClearer(pending.deadlineTimer);
      pending.deadlineTimer = undefined;
      if (this.validateBarrierKey === key) this.validateBarrierKey = undefined;
      if (!pending.clientCancelled) {
        this.writeToClient(buildValidateProjectTimeoutReply({
          request: pending,
          phase: "queue",
          deadlineMs: this.validateProjectTimeoutMs,
          now: this.monotonicNow(),
          workerRestartInitiated: false
        }), pending.mode);
      }
      this.drainQueue();
      return;
    }

    const pending = this.pendingRequests.get(key);
    if (!pending || pending.toolName !== "validate-project") return;
    this.pendingRequests.delete(key);
    pending.deadlineTimer = undefined;
    this.runningValidateKey = undefined;
    this.validateBarrierKey = undefined;
    if (!pending.clientCancelled) {
      this.writeToClient(buildValidateProjectTimeoutReply({
        request: pending,
        phase: "running",
        deadlineMs: this.validateProjectTimeoutMs,
        now: this.monotonicNow(),
        workerRestartInitiated: true
      }), pending.mode);
    }
    this.recoverTimedOutWorker();
  }

  private drainQueue(): void {
    if (!this.childReady || !this.child || this.child.stdin.destroyed) return;

    while (this.queuedRequests.length > 0) {
      if (this.runningValidateKey) return;
      const next = this.queuedRequests[0];
      const nextKey = requestKey(next.pending.id);
      if (next.pending.toolName === "validate-project") {
        this.validateBarrierKey = nextKey;
        if (
          this.pendingRequests.size > 0 ||
          this.staleChildren.size > 0 ||
          this.unresolvedTreeTokens.size > 0
        ) {
          return;
        }
        this.queuedRequests.shift();
        this.forwardRequest(next.message, next.pending);
        return;
      }
      if (this.validateBarrierKey && this.validateBarrierKey !== nextKey) {
        const barrierIndex = this.queuedRequests.findIndex(
          (entry) => requestKey(entry.pending.id) === this.validateBarrierKey
        );
        if (barrierIndex === 0) return;
      }
      this.queuedRequests.shift();
      this.forwardRequest(next.message, next.pending);
    }
  }

  private spawnWorker(): void {
    if (this.shuttingDown || this.child || this.liveCapOccupancy() >= 2) {
      this.retryPaused = this.liveCapOccupancy() >= 2;
      return;
    }
    this.currentRetryEpoch = undefined;
    this.currentRetryReservation = undefined;
    this.retryPaused = false;
    const token = ++this.attemptToken;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.workerSpawner();
    } catch (error) {
      log("error", "supervisor.worker_spawn_throw", {
        message: error instanceof Error ? error.message : String(error)
      });
      this.handleStartupFailure(token, { code: null, signal: null });
      return;
    }

    this.child = child;
    this.liveChildren.add(child);
    this.workerReaders.set(child, new JsonRpcFrameReader());
    this.childReady = false;
    this.initializeSentToWorker = false;
    this.workerStderrBuffer = "";
    this.clearStartupWatchdog();
    this.startupWatchdog = this.timerScheduler(() => {
      if (token !== this.attemptToken || child !== this.child || this.childReady) return;
      log("warn", "supervisor.worker_startup_timeout", {
        pid: child.pid,
        timeoutMs: this.workerStartupWatchdogMs
      });
      this.invalidateCurrentChild(child);
      this.beginTreeTermination(child);
      this.handleStartupFailure(token, { code: null, signal: "SIGKILL" });
    }, this.workerStartupWatchdogMs);

    child.stdout.on("data", (chunk: Buffer) => this.handleWorkerData(child, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => this.handleWorkerStderr(child, chunk));
    child.stdin.on("error", (error) => this.handleWorkerStdinError(child, error));
    child.once("error", (error) => this.handleWorkerProcessError(child, error));
    child.once("exit", (code, signal) => this.handleWorkerExit(child, code, signal));
    child.once("close", (code, signal) => this.handleWorkerExit(child, code, signal));

    log("info", "supervisor.worker_spawn", { pid: child.pid });
  }

  private handleWorkerData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    const reader = this.workerReaders.get(child);
    if (!reader) return;
    reader.processChunk(chunk, {
      onFrame: ({ message }) => {
        this.handleWorkerMessage(child, message);
      },
      onError: (error) => {
        log("warn", "supervisor.worker_parse_error", { message: error.message });
      }
    });
  }

  private handleWorkerStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      return;
    }
    log("warn", "supervisor.worker_stdin_error", { message: error.message });
  }

  private handleWorkerStderr(child: ChildProcessWithoutNullStreams, chunk: Buffer | string): void {
    if (child !== this.child) return;
    this.workerStderrBuffer += chunk.toString();
    const lines = this.workerStderrBuffer.split(/\r?\n/);
    this.workerStderrBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === WORKER_READY_MARKER) {
        this.handleWorkerReady(child);
        continue;
      }
      process.stderr.write(`${line}\n`);
    }
  }

  private handleWorkerProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
    log("error", "supervisor.worker_process_error", { message: error.message });

    if (child !== this.child) {
      return;
    }
    const wasReady = this.childReady;
    this.invalidateCurrentChild(child);
    this.beginTreeTermination(child);
    if (!wasReady) {
      this.handleStartupFailure(this.attemptToken, { code: null, signal: null });
    } else {
      this.failPendingRequestsOnWorkerExit({ code: null, signal: null });
      this.scheduleRestart(true);
    }
  }

  private handleWorkerExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.terminalChildren.has(child)) return;
    this.terminalChildren.add(child);
    const cleanup = this.cleanupStates.get(child);
    if (cleanup) {
      cleanup.parentExited = true;
      this.liveChildren.delete(child);
      this.workerReaders.delete(child);
      this.staleChildren.delete(child);
      if (cleanup.status === "pending" || cleanup.status === "unresolved") {
        this.unresolvedTreeTokens.add(cleanup.pid);
        this.scheduleCleanupTokenRetry();
      } else {
        this.cleanupStates.delete(child);
      }
      this.resumePausedRestart();
      this.drainQueue();
      return;
    }

    this.liveChildren.delete(child);
    this.workerReaders.delete(child);
    this.staleChildren.delete(child);

    if (child !== this.child) {
      this.resumePausedRestart();
      this.drainQueue();
      return;
    }

    const childPid = this.child?.pid;
    const wasReady = this.childReady;
    this.detachCurrentChild();

    if (this.shuttingDown) {
      return;
    }

    log("warn", "supervisor.worker_exit", {
      pid: childPid,
      code,
      signal,
      pendingRequests: this.pendingRequests.size
    });

    if (!wasReady) {
      this.handleStartupFailure(this.attemptToken, { code, signal });
      return;
    }
    this.failPendingRequestsOnWorkerExit({ code, signal });
    this.scheduleRestart(true);
  }

  private handleWorkerMessage(child: ChildProcessWithoutNullStreams, message: JSONRPCMessage): void {
    if (child !== this.child) return;
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
      let initializeMode: ConcreteFramingMode | undefined;
      if (id !== undefined) {
        const key = requestKey(id);
        initializeMode = this.pendingRequests.get(key)?.mode;
        this.pendingRequests.delete(key);
      }
      initializeMode ??= this.modeForMessage(this.initializeRequest);

      if ("error" in message) {
        if (!this.replayingInitialization && id !== undefined) {
          this.writeToClient(buildLegacyJsonRpcError(id), initializeMode);
          const retainedIndex = this.queuedNotifications.findIndex(
            (entry) => isRequest(entry) && requestKey(entry.id as RequestId) === requestKey(id)
          );
          if (retainedIndex >= 0) this.queuedNotifications.splice(retainedIndex, 1);
        }
        const active = this.child;
        if (active) {
          this.invalidateCurrentChild(active);
          this.beginTreeTermination(active);
        }
        this.handleStartupFailure(this.attemptToken, { code: null, signal: null });
        return;
      }

      if (this.replayingInitialization) {
        this.replayingInitialization = false;
        if (this.initializedNotification) {
          this.writeToWorker(child, this.initializedNotification);
        }
        this.adoptActiveChild();
        this.flushQueue();
        return;
      }

      this.clientInitialized = true;
      this.adoptActiveChild();
      this.writeToClient(message, initializeMode);
      this.flushQueue();
      return;
    }

    // Worker messages that correlate to no tracked request (server-originated
    // notifications/requests, late responses whose pending entry was already
    // discarded) fall back to the last-detected inbound mode in writeToClient.
    let responseMode: ConcreteFramingMode | undefined;
    if (isResponse(message)) {
      const id = getTrackedRequestId(message);
      if (id !== undefined) {
        const key = requestKey(id);
        const pending = this.pendingRequests.get(key);
        responseMode = pending?.mode;
        this.pendingRequests.delete(key);
        if (pending?.deadlineTimer) this.timerClearer(pending.deadlineTimer);
        if (pending?.toolName === "validate-project") {
          this.runningValidateKey = undefined;
          if (this.validateBarrierKey === key) this.validateBarrierKey = undefined;
          if (pending.clientCancelled) {
            this.drainQueue();
            return;
          }
        }
      }
    }

    this.writeToClient(message, responseMode);
    this.drainQueue();
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
      pending.lastStageStartedAt = this.monotonicNow();
    } else if (pending.lastStageStartedAt === undefined) {
      // First emit for this request; bootstrap the stage timer.
      pending.lastStageStartedAt = this.monotonicNow();
    }
    pending.lastStageMeta = p.meta;
  }

  private handleWorkerReady(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return;
    debugSupervisor("worker_ready", {
      hasInitializeRequest: this.initializeRequest !== undefined,
      clientInitialized: this.clientInitialized
    });

    // Era-gated replay: initialize replay fires ONLY in the legacy era. The
    // modern lock purges the cached lifecycle, so the era check is
    // belt-and-braces — no initialize may ever reach a modern-locked worker.
    if (this.era !== "legacy" || !this.initializeRequest) {
      this.adoptActiveChild();
      this.flushQueue();
      return;
    }

    this.replayingInitialization = this.clientInitialized;
    this.forwardRequest(this.initializeRequest, this.createPendingRequest(this.initializeRequest));
  }

  private isInitializationResponse(message: JSONRPCMessage): message is JSONRPCResponse {
    const id = isResponse(message) ? getTrackedRequestId(message) : undefined;
    const initializeId = this.initializeRequest
      ? getTrackedRequestId(this.initializeRequest)
      : undefined;
    const initializePending = initializeId !== undefined
      ? this.pendingRequests.get(requestKey(initializeId))?.method === "initialize"
      : false;
    return (
      id !== undefined &&
      initializeId !== undefined &&
      initializePending &&
      requestKey(id) === requestKey(initializeId)
    );
  }

  private flushQueue(): void {
    if (!this.childReady || !this.child) {
      return;
    }

    const controls = this.queuedNotifications.splice(0, this.queuedNotifications.length);
    for (const message of controls) {
      if (
        this.initializeSentToWorker &&
        isRequest(message) &&
        message.method === "initialize" &&
        this.initializeRequest !== undefined &&
        getTrackedRequestId(message) === getTrackedRequestId(this.initializeRequest)
      ) {
        continue;
      }
      if (isRequest(message)) {
        this.forwardRequest(message, this.createPendingRequest(message));
      } else {
        this.writeToWorker(this.child, message);
      }
    }
    this.drainQueue();
  }

  private failPendingRequestsOnWorkerExit(exit: ExitInfo): void {
    const preservedInitializeKey = this.initializeRequest
      ? requestKey(this.initializeRequest.id)
      : undefined;

    const now = this.monotonicNow();

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
      if (pending.deadlineTimer) this.timerClearer(pending.deadlineTimer);
      if (this.runningValidateKey === key) this.runningValidateKey = undefined;
      if (this.validateBarrierKey === key) this.validateBarrierKey = undefined;
      if (pending.clientCancelled) continue;
      const toolName = pending.toolName ?? "unknown";
      const pruned = prunedByTool.get(toolName) ?? [];
      const { reply } = buildWorkerRestartReply(
        pending,
        exit,
        now,
        pruned,
        { structuredRestartDisabled: STRUCTURED_RESTART_DISABLED }
      );
      this.writeToClient(reply, pending.mode);
    }
  }

  /**
   * Writes one client-bound message. `mode` is the ORIGINATING REQUEST's
   * captured framing; callers omit it only for writes that correlate to no
   * request id, which fall back to the last-detected inbound mode.
   */
  private writeToClient(message: JSONRPCMessage, mode?: ConcreteFramingMode): void {
    const effectiveMode = mode ?? this.lastInboundClientMode;
    debugSupervisor("write_to_client", {
      hasMethod: "method" in message,
      method: "method" in message ? message.method : undefined,
      id: "id" in message ? message.id : undefined,
      clientMode: effectiveMode
    });
    try {
      if (this.clientWriter) {
        this.clientWriter(message);
        return;
      }
      const frame = encodeJsonRpcMessage(message, effectiveMode);
      process.stdout.write(frame);
    } catch (error) {
      this.eventWriter("warn", "supervisor.client_write_error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private clearInitialInitializationState(): void {
    if (this.clientInitialized) return;
    this.initializeRequest = undefined;
    this.initializedNotification = undefined;
    this.replayingInitialization = false;
    this.initializeSentToWorker = false;
  }

  private liveCapOccupancy(): number {
    return this.liveChildren.size + this.unresolvedTreeTokens.size;
  }

  get unresolvedTreeTokenCount(): number {
    return this.unresolvedTreeTokens.size;
  }

  private clearStartupWatchdog(): void {
    if (this.startupWatchdog) {
      this.timerClearer(this.startupWatchdog);
      this.startupWatchdog = undefined;
    }
  }

  private adoptActiveChild(): void {
    this.clearStartupWatchdog();
    this.childReady = true;
    this.restartBackoff.reset();
    this.currentRetryEpoch = undefined;
    this.currentRetryReservation = undefined;
    this.retryPaused = false;
  }

  private invalidateCurrentChild(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return;
    this.clearStartupWatchdog();
    this.child = undefined;
    this.childReady = false;
    this.replayingInitialization = false;
    this.initializeSentToWorker = false;
    this.staleChildren.add(child);
    this.attemptToken += 1;
    child.stdout.removeAllListeners("data");
    child.stderr.removeAllListeners("data");
    child.stdin.removeAllListeners("error");
  }

  private detachCurrentChild(): void {
    const child = this.child;
    this.clearStartupWatchdog();
    this.child = undefined;
    this.childReady = false;
    this.replayingInitialization = false;
    this.initializeSentToWorker = false;
    if (child) {
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.stdin.removeAllListeners("error");
    }
  }

  private recoverTimedOutWorker(): void {
    const child = this.child;
    if (!child) {
      this.scheduleRestart(true);
      return;
    }
    this.invalidateCurrentChild(child);
    this.beginTreeTermination(child);
    this.spawnWorker();
  }

  private beginTreeTermination(child: ChildProcessWithoutNullStreams): void {
    const pid = child.pid;
    if (pid === undefined) {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      return;
    }
    if (!this.cleanupStates.has(child)) {
      this.cleanupStates.set(child, { pid, status: "pending", parentExited: false });
    }

    if (this.treeTerminator) {
      let operation: boolean | Promise<boolean>;
      try {
        operation = this.treeTerminator(pid);
      } catch {
        operation = false;
      }
      if (typeof operation === "boolean") {
        if (!operation) {
          try { child.kill("SIGKILL"); } catch { /* best effort */ }
        }
        this.finishTreeTermination(child, operation);
      } else {
        void settleTreeCleanupWithin(operation, this.treeCleanupTimeoutMs).then((success) => {
          if (!success) {
            try { child.kill("SIGKILL"); } catch { /* best effort */ }
          }
          this.finishTreeTermination(child, success);
        });
      }
      return;
    }

    if (process.platform !== "win32") {
      if (terminatePosixProcessGroup(pid)) {
        this.finishTreeTermination(child, true);
      } else {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
        this.finishTreeTermination(child, false);
      }
      return;
    }

    let taskkill;
    try {
      taskkill = spawn("taskkill", buildWindowsTreeKillArgs(pid), {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      this.finishTreeTermination(child, false);
      return;
    }
    const operation = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        resolve(success);
      };
      taskkill.once("error", () => finish(false));
      taskkill.once("exit", (code) => finish(code === 0));
    });
    void settleTreeCleanupWithin(operation, this.treeCleanupTimeoutMs, () => {
      try { taskkill.kill("SIGKILL"); } catch { /* best effort */ }
    }).then((success) => {
      if (!success) {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
      this.finishTreeTermination(child, success);
    });
  }

  private finishTreeTermination(child: ChildProcessWithoutNullStreams, success: boolean): void {
    const cleanup = this.cleanupStates.get(child);
    if (!cleanup) return;
    cleanup.status = success ? "accepted" : "unresolved";
    if (!cleanup.parentExited) return;
    if (success) {
      this.unresolvedTreeTokens.delete(cleanup.pid);
      this.cleanupRetryAttempts.delete(cleanup.pid);
      this.cleanupStates.delete(child);
      this.stopCleanupTokenRetryIfIdle();
    } else {
      this.unresolvedTreeTokens.add(cleanup.pid);
      this.scheduleCleanupTokenRetry();
    }
    this.resumePausedRestart();
    this.drainQueue();
  }

  private scheduleCleanupTokenRetry(): void {
    if (this.shuttingDown || this.cleanupRetryTimer || this.unresolvedTreeTokens.size === 0) return;
    const delayMs = Math.min(
      this.cleanupTokenRetryBaseMs * (2 ** this.cleanupRetryIndex),
      this.cleanupTokenRetryCapMs
    );
    this.cleanupRetryIndex += 1;
    this.cleanupRetryTimer = this.timerScheduler(() => {
      this.cleanupRetryTimer = undefined;
      void this.runCleanupTokenRetries();
    }, delayMs);
    this.cleanupRetryTimer.unref();
  }

  private async runCleanupTokenRetries(): Promise<void> {
    await Promise.all(
      [...this.unresolvedTreeTokens].map((pid) => this.retryUnresolvedTreeToken(pid))
    );
    if (this.unresolvedTreeTokens.size === 0) {
      this.cleanupRetryIndex = 0;
      return;
    }
    this.scheduleCleanupTokenRetry();
  }

  private stopCleanupTokenRetryIfIdle(): void {
    if (this.unresolvedTreeTokens.size > 0) return;
    if (this.cleanupRetryTimer) {
      this.timerClearer(this.cleanupRetryTimer);
      this.cleanupRetryTimer = undefined;
    }
    this.cleanupRetryIndex = 0;
    this.cleanupRetryAttempts.clear();
  }

  private retryUnresolvedTreeToken(pid: number): Promise<void> {
    const existing = this.cleanupRetriesInFlight.get(pid);
    if (existing) return existing;
    const retry = this.performUnresolvedTreeTokenRetry(pid);
    this.cleanupRetriesInFlight.set(pid, retry);
    return retry.finally(() => {
      if (this.cleanupRetriesInFlight.get(pid) === retry) {
        this.cleanupRetriesInFlight.delete(pid);
      }
    });
  }

  private async performUnresolvedTreeTokenRetry(pid: number): Promise<void> {
    if (!this.unresolvedTreeTokens.has(pid)) return;
    const attempt = (this.cleanupRetryAttempts.get(pid) ?? 0) + 1;
    this.cleanupRetryAttempts.set(pid, attempt);
    this.eventWriter("warn", "supervisor.cleanup_token.retry", { pid, attempt });
    let success = false;
    if (this.treeTokenRetrier) {
      success = await settleTreeCleanupWithin(
        Promise.resolve().then(() => this.treeTokenRetrier!(pid)),
        this.treeCleanupTimeoutMs
      );
    } else if (process.platform !== "win32") {
      success = retryPosixTreeToken(pid);
    } else {
      let taskkill: ReturnType<typeof spawn> | undefined;
      const operation = new Promise<boolean>((resolve) => {
        try {
          taskkill = spawn("taskkill", buildWindowsTreeKillArgs(pid), {
            stdio: "ignore",
            windowsHide: true
          });
        } catch {
          resolve(false);
          return;
        }
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        taskkill.once("error", () => finish(false));
        taskkill.once("exit", (code) => finish(code === 0));
      });
      success = await settleTreeCleanupWithin(operation, this.treeCleanupTimeoutMs, () => {
        try { taskkill?.kill("SIGKILL"); } catch { /* best effort */ }
      });
    }
    if (!success || !this.unresolvedTreeTokens.has(pid)) return;
    this.unresolvedTreeTokens.delete(pid);
    this.cleanupRetryAttempts.delete(pid);
    for (const [child, cleanup] of this.cleanupStates) {
      if (cleanup.pid === pid && cleanup.parentExited) {
        this.cleanupStates.delete(child);
      }
    }
    this.eventWriter("info", "supervisor.cleanup_token.recovered", {
      pid,
      attempt,
      unresolvedTreeTokens: this.unresolvedTreeTokens.size
    });
    this.stopCleanupTokenRetryIfIdle();
    this.resumePausedRestart();
    this.drainQueue();
  }

  private handleStartupFailure(token: number, exit: ExitInfo): void {
    if (token !== this.attemptToken && this.child !== undefined) return;
    this.clearStartupWatchdog();
    this.failQueuedRequestsOnStartupFailure(exit);
    this.scheduleRestart(true);
  }

  private failQueuedRequestsOnStartupFailure(exit: ExitInfo): void {
    const now = this.monotonicNow();
    const queued = this.queuedRequests.splice(0, this.queuedRequests.length);
    for (const { pending } of queued) {
      if (pending.deadlineTimer) this.timerClearer(pending.deadlineTimer);
      const { reply } = buildWorkerRestartReply(pending, exit, now, [], {
        structuredRestartDisabled: STRUCTURED_RESTART_DISABLED
      });
      this.writeToClient(reply, pending.mode);
    }
    const retainedInitialize = this.queuedNotifications.find(
      (message) => isRequest(message) && message.method === "initialize"
    );
    this.queuedNotifications.splice(0, this.queuedNotifications.length);
    if (retainedInitialize && isRequest(retainedInitialize)) {
      this.writeToClient(
        buildLegacyJsonRpcError(retainedInitialize.id as RequestId),
        this.modeForMessage(retainedInitialize)
      );
    }
    this.clearInitialInitializationState();
    this.validateBarrierKey = undefined;
    this.runningValidateKey = undefined;
  }

  private scheduleRestart(_failedAttempt = false): void {
    if (this.restartTimer || this.shuttingDown || this.child || this.currentRetryReservation) {
      return;
    }
    const reservation = this.restartBackoff.reserve(this.monotonicNow());
    this.currentRetryReservation = reservation;
    this.currentRetryEpoch = reservation.epoch;
    if (this.liveCapOccupancy() >= 2) {
      this.retryPaused = true;
      this.eventWriter("warn", "supervisor.live_cap.saturated", {
        occupancy: this.liveCapOccupancy(),
        cap: 2,
        liveChildren: this.liveChildren.size,
        unresolvedTreeTokens: this.unresolvedTreeTokens.size,
        reason: "restart-blocked"
      });
      return;
    }
    this.armRestartReservation(reservation);
  }

  private armRestartReservation(reservation: RestartReservation): void {
    if (this.restartTimer || this.shuttingDown) return;
    const remaining = Math.max(0, reservation.notBefore - this.monotonicNow());
    this.restartTimer = this.timerScheduler(() => {
      this.restartTimer = undefined;
      if (
        this.shuttingDown ||
        reservation.epoch !== this.currentRetryEpoch ||
        this.child ||
        this.liveCapOccupancy() >= 2
      ) {
        if (
          !this.shuttingDown &&
          reservation.epoch === this.currentRetryEpoch &&
          this.liveCapOccupancy() >= 2
        ) {
          this.retryPaused = true;
        }
        return;
      }
      this.currentRetryEpoch = undefined;
      this.currentRetryReservation = undefined;
      this.spawnWorker();
    }, remaining);
  }

  private resumePausedRestart(): void {
    if (!this.retryPaused || this.shuttingDown || this.child || this.liveCapOccupancy() >= 2) return;
    this.retryPaused = false;
    const reservation = this.currentRetryReservation;
    if (!reservation) {
      this.scheduleRestart(true);
      return;
    }
    if (reservation.epoch !== this.currentRetryEpoch) return;
    this.armRestartReservation(reservation);
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    if (this.cleanupRetryTimer) {
      this.timerClearer(this.cleanupRetryTimer);
      this.cleanupRetryTimer = undefined;
    }
    if (this.restartTimer) {
      this.timerClearer(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.currentRetryEpoch = undefined;
    this.currentRetryReservation = undefined;
    this.retryPaused = false;
    this.clearStartupWatchdog();

    for (const pending of this.pendingRequests.values()) {
      if (pending.deadlineTimer) this.timerClearer(pending.deadlineTimer);
    }
    for (const { pending } of this.queuedRequests) {
      if (pending.deadlineTimer) this.timerClearer(pending.deadlineTimer);
    }
    this.pendingRequests.clear();
    this.queuedRequests.splice(0, this.queuedRequests.length);

    process.stdin.off("data", this.handleClientData);
    process.stdin.off("error", this.handleClientError);
    process.stdin.off("end", this.handleClientClosed);
    process.stdin.off("close", this.handleClientClosed);
    process.off("SIGINT", this.handleTerminateSignal);
    process.off("SIGTERM", this.handleTerminateSignal);

    this.detachCurrentChild();
    for (const child of this.liveChildren) {
      this.beginTreeTermination(child);
    }
    await Promise.all(
      [...this.unresolvedTreeTokens].map((pid) => this.retryUnresolvedTreeToken(pid))
    );
  }
}

export const STDIO_WORKER_MODE_ENV = WORKER_MODE_ENV;
