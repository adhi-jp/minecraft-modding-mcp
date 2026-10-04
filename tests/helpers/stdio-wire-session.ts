import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

/**
 * Shared wire plumbing for the stdio suites that spawn the REAL entry point
 * (`node --import tsx src/cli.ts`) and speak newline-delimited JSON-RPC on its
 * stdio: spawn with an isolated cache, NDJSON frame collection from stdout,
 * stderr capture, and a polling wait. Teardown stays in
 * tests/helpers/stdio-child-lifecycle.ts (stopSupervisor).
 *
 * Without MCP_STDIO_WORKER_MODE the production supervisor runs and spawns the
 * production SDK worker (the child inherits `--import tsx` through
 * process.execArgv); with MCP_STDIO_WORKER_MODE=1 the worker runs directly.
 */

export type WireFrame = Record<string, unknown> & { id?: unknown; method?: unknown };

export type WireExit = { code: number | null; signal: NodeJS.Signals | null };

export type WireSession = {
  child: ChildProcessWithoutNullStreams;
  frames: WireFrame[];
  /** Writes one newline-delimited JSON-RPC frame. */
  send: (message: object) => void;
  /** Writes raw bytes, for framing tests that need exact wire control. */
  writeRaw: (payload: string) => void;
  stderr: () => string;
  /** Whether the readiness marker has appeared on stderr. */
  workerReady: () => boolean;
  exit: () => WireExit | undefined;
};

export type WireSessionOptions = {
  /** Extra environment variables for the child; they override the isolated cache paths. */
  extraEnv?: Record<string, string>;
  /**
   * The stderr text that signals readiness. Defaults to the supervisor's
   * worker-adoption debug event (requires MCP_SUPERVISOR_DEBUG=1).
   */
  readyMarker?: string;
  /**
   * Ignore stdin pipe errors, for sessions whose stdin may be torn down under
   * the test (a write to the closed pipe must not crash the test process).
   */
  swallowStdinErrors?: boolean;
};

const DEFAULT_READY_MARKER = "supervisor.debug.worker_ready";

export function startWireSession(root: string, options: WireSessionOptions = {}): WireSession {
  const readyMarker = options.readyMarker ?? DEFAULT_READY_MARKER;
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_CACHE_DIR: join(root, "cache"),
      MCP_SQLITE_PATH: join(root, "cache", "source-cache.db"),
      ...options.extraEnv
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let buffer = "";
  const frames: WireFrame[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        frames.push(JSON.parse(line) as WireFrame);
      } catch {
        // Ignore non-JSON stdout noise.
      }
    }
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  let exit: WireExit | undefined;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  if (options.swallowStdinErrors) {
    child.stdin.on("error", () => {});
  }

  return {
    child,
    frames,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    writeRaw: (payload) => child.stdin.write(payload),
    stderr: () => stderrBuffer,
    workerReady: () => stderrBuffer.includes(readyMarker),
    exit: () => exit
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
