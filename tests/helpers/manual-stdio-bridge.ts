import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);
// Keep this test helper copy in sync with src/stdio-supervisor.ts.
const WORKER_READY_MARKER = "__MCP_STDIO_WORKER_READY__";
const BRIDGE_START_TIMEOUT_MS = 3_000;
const BRIDGE_SHUTDOWN_TIMEOUT_MS = 2_000;

export type ManualStdioMode =
  | {
      kind: "native";
      supportsWorkerRestartValidation: true;
    }
  | {
      kind: "bash-bridge";
      supportsWorkerRestartValidation: false;
      detail: string;
    };

type DirectWorkerBridgeTransportOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

function createBridgeStartError(message: string): Error {
  return new Error(`manual stdio bridge failed to start: ${message}`);
}

function waitForStreamOpen(
  stream: ReadStream | WriteStream,
  label: string,
  timeoutMs = BRIDGE_START_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(createBridgeStartError(`timed out waiting for ${label} to open after ${timeoutMs}ms.`));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      stream.off("open", onOpen);
      stream.off("error", onError);
    };

    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

async function terminateProcess(child: ChildProcess, timeoutMs = BRIDGE_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  const closed = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs))
  ]);

  if (!timedOut) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }

  await Promise.race([
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

export function selectManualStdioMode(canUseNativeSpawnPipes: boolean): ManualStdioMode {
  if (canUseNativeSpawnPipes) {
    return {
      kind: "native",
      supportsWorkerRestartValidation: true
    };
  }

  return {
    kind: "bash-bridge",
    supportsWorkerRestartValidation: false,
    detail: "Node child-process stdio pipes close stdin immediately in this runtime."
  };
}

export function createDirectWorkerBridgeTransport(
  options: DirectWorkerBridgeTransportOptions
): Transport {
  return new DirectWorkerBridgeTransport(options);
}

class DirectWorkerBridgeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readBuffer = new ReadBuffer();

  private bridgeProcess: ChildProcess | undefined;
  private inputStream: WriteStream | undefined;
  private outputStream: ReadStream | undefined;
  private tempRoot: string | undefined;
  private closed = false;
  private stderrBuffer = "";

  constructor(options: DirectWorkerBridgeTransportOptions) {
    this.cwd = options.cwd;
    this.env = options.env;
  }

  async start(): Promise<void> {
    if (this.bridgeProcess) {
      throw new Error("DirectWorkerBridgeTransport already started.");
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "manual-stdio-bridge-"));
    const inputFifo = join(tempRoot, "client-to-worker.fifo");
    const outputFifo = join(tempRoot, "worker-to-client.fifo");

    await execFileAsync("mkfifo", [inputFifo, outputFifo]);

    const bridgeProcess = spawn(
      "bash",
      ["-c", [
        "set -euo pipefail",
        "coproc MCP_WORKER { node --import tsx src/cli.ts; }",
        "exec 7>&${MCP_WORKER[1]}",
        "exec 8<&${MCP_WORKER[0]}",
        "cat \"$MCP_BRIDGE_INPUT_FIFO\" >&7 &",
        "bridge_in_pid=$!",
        "cat <&8 > \"$MCP_BRIDGE_OUTPUT_FIFO\" &",
        "bridge_out_pid=$!",
        "cleanup() {",
        "  kill \"$bridge_in_pid\" \"$bridge_out_pid\" \"$MCP_WORKER_PID\" 2>/dev/null || true",
        "  exec 7>&- 8<&-",
        "}",
        "trap cleanup EXIT INT TERM",
        "wait \"$MCP_WORKER_PID\""
      ].join("\n")],
      {
        cwd: this.cwd,
        env: {
          ...this.env,
          MCP_STDIO_WORKER_MODE: "1",
          MCP_BRIDGE_INPUT_FIFO: inputFifo,
          MCP_BRIDGE_OUTPUT_FIFO: outputFifo
        },
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let startupState: "pending" | "ready" | "failed" = "pending";
    let rejectStartup!: (error: Error) => void;
    const startupFailure = new Promise<never>((_, reject) => {
      rejectStartup = reject;
    });
    void startupFailure.catch(() => undefined);

    const failStartup = (error: Error) => {
      if (startupState !== "pending") {
        return;
      }
      startupState = "failed";
      rejectStartup(error);
    };

    bridgeProcess.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrBuffer += text;

      const lines = this.stderrBuffer.split(/\r?\n/);
      this.stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line || line === WORKER_READY_MARKER) {
          continue;
        }
        this.onerror?.(new Error(`manual stdio bridge stderr: ${line}`));
      }
    });

    bridgeProcess.once("error", (error) => {
      if (startupState === "pending") {
        failStartup(createBridgeStartError(error.message));
        return;
      }

      if (startupState === "ready") {
        this.onerror?.(error);
      }
    });

    bridgeProcess.once("exit", (code, signal) => {
      this.bridgeProcess = undefined;
      if (this.closed) {
        return;
      }

      const details = [
        startupState === "pending"
          ? `bridge process exited before the FIFO transport became ready (code=${code ?? "null"}, signal=${signal ?? "null"})`
          : `manual stdio bridge exited before close (code=${code ?? "null"}, signal=${signal ?? "null"})`
      ];
      const stderrTail = this.stderrBuffer.trim();
      if (stderrTail) {
        details.push(stderrTail);
      }
      const error = startupState === "pending"
        ? createBridgeStartError(details.join("\n"))
        : new Error(details.join("\n"));

      if (startupState === "pending") {
        failStartup(error);
        return;
      }

      if (startupState === "ready") {
        this.onerror?.(error);
        this.onclose?.();
      }
    });

    const outputStream = createReadStream(outputFifo);
    const inputStream = createWriteStream(inputFifo);

    outputStream.on("data", (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      while (true) {
        try {
          const message = this.readBuffer.readMessage();
          if (message === null) {
            return;
          }
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });

    outputStream.on("error", (error) => {
      if (!this.closed) {
        this.onerror?.(error);
      }
    });

    inputStream.on("error", (error) => {
      if (!this.closed) {
        this.onerror?.(error);
      }
    });

    const streamOpenPromise = Promise.all([
      waitForStreamOpen(outputStream, "worker-to-client FIFO"),
      waitForStreamOpen(inputStream, "client-to-worker FIFO")
    ]);
    void streamOpenPromise.catch(() => undefined);

    try {
      await Promise.race([streamOpenPromise, startupFailure]);
    } catch (error) {
      if (startupState === "pending") {
        startupState = "failed";
      }
      outputStream.destroy();
      inputStream.destroy();
      await terminateProcess(bridgeProcess);
      await rm(tempRoot, { recursive: true, force: true });
      throw error;
    }

    this.tempRoot = tempRoot;
    this.bridgeProcess = bridgeProcess;
    this.inputStream = inputStream;
    this.outputStream = outputStream;
    this.closed = false;
    startupState = "ready";
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.inputStream || this.inputStream.destroyed) {
      throw new Error("DirectWorkerBridgeTransport is not connected.");
    }

    const inputStream = this.inputStream;
    const payload = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        inputStream.off("error", onError);
        inputStream.off("drain", onDrain);
      };

      inputStream.once("error", onError);
      if (inputStream.write(payload)) {
        cleanup();
        resolve();
        return;
      }

      inputStream.once("drain", onDrain);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.readBuffer.clear();

    const inputStream = this.inputStream;
    const outputStream = this.outputStream;
    const bridgeProcess = this.bridgeProcess;
    const tempRoot = this.tempRoot;

    this.inputStream = undefined;
    this.outputStream = undefined;
    this.bridgeProcess = undefined;
    this.tempRoot = undefined;

    await new Promise<void>((resolve) => {
      if (!inputStream) {
        resolve();
        return;
      }

      inputStream.end(() => resolve());
    });

    outputStream?.destroy();

    if (bridgeProcess) {
      await terminateProcess(bridgeProcess);
    }

    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }

    this.onclose?.();
  }
}
