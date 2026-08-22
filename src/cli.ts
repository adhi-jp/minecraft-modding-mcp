#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startServer } from "./index.js";
import { log } from "./logger.js";
import { STDIO_WORKER_MODE_ENV, StdioSupervisor } from "./stdio-supervisor.js";

const CHILD_PID_FILE_ENV = "MCP_SUPERVISOR_CHILD_PID_FILE";
const WORKER_READY_MARKER = "__MCP_STDIO_WORKER_READY__";
const PARENT_LIVENESS_POLL_MS = 5_000;

async function main(): Promise<void> {
  if (process.env[STDIO_WORKER_MODE_ENV] === "1") {
    const pidFile = process.env[CHILD_PID_FILE_ENV];
    if (pidFile) {
      writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    }

    // Worker mode runs behind the stdio supervisor, which holds the SOLE write
    // end of this stdin — so the supervisor's death is delivered here as EOF.
    // This interval keeps the process alive until then; releasing it only from
    // a process "exit" listener (which by definition runs once the process is
    // already leaving) meant the event loop never drained and the worker
    // outlived every supervisor that did not shut down cooperatively.
    const keepAliveTimer = setInterval(() => undefined, 60_000);

    // Defence in depth for hosts where stdin is not a pipe the parent solely
    // owns, so EOF never arrives. `process.ppid` is a static data property in
    // node — re-reading it can never reveal reparenting — so the parent pid is
    // snapshotted once and probed for LIVENESS instead. The probe errs towards
    // "alive" (EPERM means the pid was reused by another user's process), so it
    // can make a dead parent look alive but never the reverse.
    const parentPid = process.ppid;
    const parentLivenessTimer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        clearInterval(parentLivenessTimer);
        clearInterval(keepAliveTimer);
        // This arm is reached precisely BECAUSE stdin never ended, so the
        // still-flowing stdin handle would keep the event loop referenced on
        // its own. Nothing more can ever arrive on it — the writer is gone —
        // so release it, guarding unref() for a file-backed stdin exactly as
        // the supervisor's own shutdown does.
        process.stdin.pause();
        const unrefStdin = (process.stdin as { unref?: () => void }).unref;
        if (typeof unrefStdin === "function") {
          unrefStdin.call(process.stdin);
        }
      }
    }, PARENT_LIVENESS_POLL_MS);
    parentLivenessTimer.unref();

    // No process.exit() here: src/compat-stdio-transport.ts deliberately keeps
    // writing after a half-close so in-flight responses are still delivered,
    // and an immediate exit would truncate one. Releasing the timers lets the
    // event loop drain once the remaining work is done.
    const releaseKeepAlive = (): void => {
      clearInterval(keepAliveTimer);
      clearInterval(parentLivenessTimer);
    };

    let workerReady = false;
    let stdinEnded = false;
    const handleStdinEnd = (): void => {
      stdinEnded = true;
      if (workerReady) {
        releaseKeepAlive();
      }
    };
    // Registered BEFORE startServer: "end" fires once, and a listener attached
    // afterwards can miss it entirely on a host whose pipe closes immediately.
    // Attaching a listener does not itself start the flow, so this is inert
    // until the transport resumes stdin.
    process.stdin.on("end", handleStdinEnd);
    process.stdin.on("close", handleStdinEnd);

    await startServer();
    process.stderr.write(`${WORKER_READY_MARKER}\n`);
    workerReady = true;
    // An EOF observed during startup must not be lost: act on it now that the
    // worker is up, rather than idling forever on a stream that already ended.
    if (stdinEnded || process.stdin.readableEnded) {
      releaseKeepAlive();
    }
    return;
  }

  const supervisor = new StdioSupervisor({
    entryFile: fileURLToPath(import.meta.url)
  });
  await supervisor.start();
}

main().catch((err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  log("error", "cli.fatal", {
    message: error.message,
    stack: error.stack
  });
  process.exit(1);
});
