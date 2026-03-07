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

const DEFAULT_CLIENT_MODE: ConcreteFramingMode = "line";
const WORKER_MODE_ENV = "MCP_STDIO_WORKER_MODE";
const WORKER_READY_MARKER = "__MCP_STDIO_WORKER_READY__";
const SUPERVISOR_DEBUG_ENABLED = process.env.MCP_SUPERVISOR_DEBUG === "1";

type SupervisorOptions = {
  entryFile: string;
};

type RequestId = string | number;

type PendingRequest = {
  id: RequestId;
  method?: string;
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

function buildWorkerRestartError(id: RequestId): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: "MCP worker restarted while handling the request. Retry the request."
    }
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
        this.pendingRequests.set(requestKey(id), {
          id,
          method: message.method
        });
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
    child.once("error", this.handleWorkerProcessError);
    child.once("exit", this.handleWorkerExit);

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

  private readonly handleWorkerProcessError = (error: Error): void => {
    log("error", "supervisor.worker_process_error", { message: error.message });
  };

  private readonly handleWorkerExit = (code: number | null, signal: NodeJS.Signals | null): void => {
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

    this.failPendingRequestsOnWorkerExit();
    this.scheduleRestart();
  };

  private handleWorkerMessage(message: JSONRPCMessage): void {
    debugSupervisor("worker_message", {
      hasMethod: "method" in message,
      method: "method" in message ? message.method : undefined,
      id: "id" in message ? message.id : undefined,
      replayingInitialization: this.replayingInitialization
    });
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

  private failPendingRequestsOnWorkerExit(): void {
    const preservedInitializeKey =
      this.initializeRequest && !this.clientInitialized
        ? requestKey(this.initializeRequest.id)
        : undefined;

    for (const [key, pending] of [...this.pendingRequests.entries()]) {
      if (key === preservedInitializeKey) {
        continue;
      }

      this.pendingRequests.delete(key);
      this.writeToClient(buildWorkerRestartError(pending.id));
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
    child.off("error", this.handleWorkerProcessError);
    child.off("exit", this.handleWorkerExit);
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
