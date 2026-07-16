import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

import { encodeJsonRpcMessage, JsonRpcFrameReader, type ConcreteFramingMode } from "../../src/json-rpc-framing.ts";

type RpcResponse = {
  id: string | number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

function startFixture(): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/stdio-supervisor-timeout-worker.runtime.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, MCP_VALIDATE_PROJECT_TIMEOUT_MS: "10000" },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
}

async function canUseNativeStdioPipes(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(42));setTimeout(()=>process.exit(0),150);"],
      { stdio: ["pipe", "ignore", "ignore"] }
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === 0));
  });
}

function send(child: ChildProcessWithoutNullStreams, message: object, mode: ConcreteFramingMode): void {
  child.stdin.write(encodeJsonRpcMessage(message as never, mode));
}

function collectResponses(child: ChildProcessWithoutNullStreams): {
  next(id: string | number, timeoutMs?: number): Promise<RpcResponse>;
} {
  const responses: RpcResponse[] = [];
  const waiters = new Map<string, (response: RpcResponse) => void>();
  const reader = new JsonRpcFrameReader();
  child.stdout.on("data", (chunk: Buffer) => {
    reader.processChunk(chunk, {
      onFrame: ({ message }) => {
        if (!("id" in message)) return;
        const response = message as RpcResponse;
        const key = String(response.id);
        const waiter = waiters.get(key);
        if (waiter) {
          waiters.delete(key);
          waiter(response);
        } else {
          responses.push(response);
        }
      },
      onError: (error) => {
        throw error;
      }
    });
  });
  return {
    next(id, timeoutMs = 15_000) {
      const existingIndex = responses.findIndex((entry) => entry.id === id);
      if (existingIndex >= 0) {
        return Promise.resolve(responses.splice(existingIndex, 1)[0]);
      }
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(String(id));
          reject(new Error(`timed out waiting for response ${String(id)}`));
        }, timeoutMs);
        waiters.set(String(id), (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    }
  };
}

for (const framing of ["line", "content-length"] as const) test(`running timeout and overflow use exact envelopes with ${framing} framing`, { timeout: 20_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => {
    child.kill("SIGKILL");
  });
  const replies = collectResponses(child);

  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, framing);
  await replies.next(1);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "validate-project", arguments: { task: "project-summary", subject: { kind: "project", path: "." } } }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 6,
    method: "resources/read",
    params: { uri: "mc://versions" }
  }, framing);

  const overflow = await replies.next(5, 2_000);
  const overflowResult = overflow.result as { structuredContent?: { error?: { code?: string }; meta?: { queue?: { queuedCount?: number } } } };
  assert.equal(overflowResult.structuredContent?.error?.code, "ERR_LIMIT_EXCEEDED");
  assert.equal(overflowResult.structuredContent?.meta?.queue?.queuedCount, 2);
  assert.deepEqual(await replies.next(6, 2_000), {
    jsonrpc: "2.0",
    id: 6,
    error: { code: -32000, message: "MCP supervisor request queue is full." }
  });

  const timeoutReply = await replies.next(2);
  const timeoutResult = timeoutReply.result as { structuredContent?: { error?: { code?: string }; meta?: { timeout?: { phase?: string; workerRestartInitiated?: boolean } } } };
  assert.equal(timeoutResult.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.deepEqual(timeoutResult.structuredContent?.meta?.timeout?.phase, "running");
  assert.equal(timeoutResult.structuredContent?.meta?.timeout?.workerRestartInitiated, true);

  const recovered = await replies.next(3, 5_000);
  assert.ok(recovered.result);
});

for (const framing of ["line", "content-length"] as const) test(`queued timeout preserves the worker with ${framing} framing`, { timeout: 18_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectResponses(child);

  send(child, { jsonrpc: "2.0", id: 10, method: "initialize", params: {} }, framing);
  await replies.next(10);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "list-versions", arguments: { delayMs: 11_000 } }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "validate-project", arguments: { task: "project-summary", subject: { kind: "project", path: "." } } }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);

  const timeoutReply = await replies.next(12, 13_000);
  const timeoutResult = timeoutReply.result as { structuredContent?: { error?: { code?: string }; meta?: { timeout?: { phase?: string; workerRestartInitiated?: boolean } } } };
  assert.equal(timeoutResult.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.equal(timeoutResult.structuredContent?.meta?.timeout?.phase, "queue");
  assert.equal(timeoutResult.structuredContent?.meta?.timeout?.workerRestartInitiated, false);

  const held = await replies.next(11, 3_000);
  const later = await replies.next(13, 3_000);
  const heldPid = ((held.result as { structuredContent?: { result?: { pid?: number } } }).structuredContent?.result?.pid);
  const laterPid = ((later.result as { structuredContent?: { result?: { pid?: number } } }).structuredContent?.result?.pid);
  assert.equal(laterPid, heldPid);
});

test("queued cancellation removes the validate barrier without forwarding a result", { timeout: 5_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 20, method: "initialize", params: {} }, "line");
  await replies.next(20);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, "line");
  send(child, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "list-versions", arguments: { delayMs: 500 } } }, "line");
  send(child, { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "validate-project", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "list-versions", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 22, reason: "test" } }, "line");

  await replies.next(21, 2_000);
  await replies.next(23, 2_000);
  await assert.rejects(replies.next(22, 250), /timed out waiting/);
});

test("running cancellation suppresses timeout output but still recovers queued work", { timeout: 16_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 30, method: "initialize", params: {} }, "line");
  await replies.next(30);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, "line");
  send(child, { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "validate-project", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "list-versions", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 31, reason: "test" } }, "line");

  await replies.next(32, 13_000);
  await assert.rejects(replies.next(31, 250), /timed out waiting/);
});
