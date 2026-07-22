import process from "node:process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { encodeJsonRpcMessage, JsonRpcFrameReader } from "../../src/json-rpc-framing.ts";
import { STDIO_WORKER_MODE_ENV, StdioSupervisor } from "../../src/stdio-supervisor.ts";

if (process.env[STDIO_WORKER_MODE_ENV] !== "1") {
  const supervisor = new StdioSupervisor({ entryFile: fileURLToPath(import.meta.url) });
  await supervisor.start();
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
  process.once("exit", () => clearInterval(keepAlive));
  const { startServer } = await import("../../src/index.ts");
  await startServer();
  process.stderr.write("__MCP_STDIO_WORKER_READY__\n");
} else {
  const reader = new JsonRpcFrameReader();
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
