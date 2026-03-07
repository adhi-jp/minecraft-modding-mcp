#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startServer } from "./index.js";
import { log } from "./logger.js";
import { STDIO_WORKER_MODE_ENV, StdioSupervisor } from "./stdio-supervisor.js";

const CHILD_PID_FILE_ENV = "MCP_SUPERVISOR_CHILD_PID_FILE";
const WORKER_READY_MARKER = "__MCP_STDIO_WORKER_READY__";

async function main(): Promise<void> {
  if (process.env[STDIO_WORKER_MODE_ENV] === "1") {
    const pidFile = process.env[CHILD_PID_FILE_ENV];
    if (pidFile) {
      writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    }
    // Worker mode runs behind the stdio supervisor; keep the process alive
    // until the parent explicitly closes stdin or sends a signal.
    const keepAliveTimer = setInterval(() => undefined, 60_000);
    process.once("exit", () => clearInterval(keepAliveTimer));
    await startServer();
    process.stderr.write(`${WORKER_READY_MARKER}\n`);
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
