import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { JSONRPCMessage } from "@modelcontextprotocol/server";

import { encodeJsonRpcMessage, JsonRpcFrameReader } from "../../src/json-rpc-framing.ts";
import { STDIO_WORKER_MODE_ENV, StdioSupervisor } from "../../src/stdio-supervisor.ts";

if (process.env[STDIO_WORKER_MODE_ENV] !== "1") {
  const supervisor = new StdioSupervisor({ entryFile: fileURLToPath(import.meta.url) });
  await supervisor.start();
  // Fault injection for the fatal-handler EXIT contract. Registering
  // uncaughtException/unhandledRejection suppresses node's default abort, so a
  // crashed supervisor only leaves if something ends it: with a referenced
  // handle like this interval, setting `process.exitCode` alone never takes
  // effect and the crashed process lives on holding the worker's group open.
  if (process.env.MCP_TEST_SUPERVISOR_HOLD_EVENT_LOOP === "1") {
    setInterval(() => undefined, 1_000);
  }
  // Fault injection for the supervisor-side fatal-handler contract: a real
  // uncaught exception raised AFTER the worker has been spawned, so the test
  // can observe whether the crash still reaps the worker process group.
  const fatalAfterMs = Number(process.env.MCP_TEST_FATAL_SUPERVISOR_AFTER_MS ?? "");
  if (Number.isFinite(fatalAfterMs) && fatalAfterMs > 0) {
    setTimeout(() => {
      throw new Error("fatal supervisor fixture");
    }, fatalAfterMs).unref();
  }
} else if (process.env.MCP_TEST_FATAL_WORKER_MARKER) {
  const markerPath = process.env.MCP_TEST_FATAL_WORKER_MARKER;
  if (!existsSync(markerPath)) {
    const fatalReader = new JsonRpcFrameReader();
    let faultScheduled = false;
    process.stdin.on("data", (chunk: Buffer) => {
      fatalReader.processChunk(chunk, {
        onFrame: ({ message }) => {
          if (faultScheduled || !("method" in message) || message.method !== "notifications/initialized") {
            return;
          }
          faultScheduled = true;
          writeFileSync(markerPath, `${process.pid}\n`, "utf8");
          queueMicrotask(() => { throw new Error("fatal worker fixture"); });
        },
        onError: (error) => process.stderr.write(`${error.message}\n`)
      });
    });
  }
  const keepAlive = setInterval(() => undefined, 1_000);
  // Released on stdin EOF, matching the plain-worker branch below and
  // src/cli.ts: clearing it from a process "exit" listener runs only once the
  // process is already leaving, so the event loop never drained and this
  // fixture worker outlived the supervisor that spawned it.
  process.stdin.once("end", () => clearInterval(keepAlive));
  const { startServer } = await import("../../src/index.ts");
  await startServer();
  process.stderr.write("__MCP_STDIO_WORKER_READY__\n");
} else {
  const reader = new JsonRpcFrameReader();
  // A DESCENDANT of the worker, in the worker's process group and holding no
  // stdin of its own. Ending the supervisor's stdin cannot reach it, and
  // neither can the worker's own stand-down: only the supervisor's shutdown
  // path, which terminates the worker's whole process group, collects it.
  const descendantPidFile = process.env.MCP_TEST_WORKER_DESCENDANT_PID_FILE;
  if (descendantPidFile) {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000);"], {
      stdio: "ignore"
    });
    descendant.unref();
    writeFileSync(descendantPidFile, `${descendant.pid ?? 0}\n`, "utf8");
  }
  const keepAlive = setInterval(() => undefined, 1_000);
  process.stdin.once("end", () => clearInterval(keepAlive));
  process.stdin.on("data", (chunk: Buffer) => {
    reader.processChunk(chunk, {
      onFrame: ({ message }) => handle(message),
      onError: (error) => {
        process.stderr.write(`${error.message}\n`);
      }
    });
  });
  process.stdin.resume();
  process.stderr.write("__MCP_STDIO_WORKER_READY__\n");
}

function write(message: JSONRPCMessage): void {
  process.stdout.write(encodeJsonRpcMessage(message, "content-length"));
}

function handle(message: JSONRPCMessage): void {
  if (!("method" in message) || !("id" in message)) {
    return;
  }
  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "timeout-fixture", version: "1.0.0" }
      }
    } as JSONRPCMessage);
    return;
  }
  if (message.method === "tools/call") {
    const params = (message.params ?? {}) as { name?: string; arguments?: { delayMs?: number } };
    if (params.name === "validate-project") {
      return;
    }
    const delayMs = params.arguments?.delayMs;
    if (typeof delayMs === "number" && delayMs > 0) {
      setTimeout(() => writeToolResult(message.id), delayMs);
      return;
    }
    writeToolResult(message.id);
    return;
  }
  write({ jsonrpc: "2.0", id: message.id, result: { pid: process.pid } } as JSONRPCMessage);
}

function writeToolResult(id: string | number): void {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: String(process.pid) }],
        structuredContent: { result: { pid: process.pid }, meta: {} }
      }
    } as JSONRPCMessage);
}
