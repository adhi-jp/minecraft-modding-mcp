import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

import { encodeJsonRpcMessage, type ConcreteFramingMode } from "../../src/json-rpc-framing.ts";

/**
 * Era-neutral response-framing correlation tests.
 *
 * The supervisor must answer every client-bound message in the framing of the
 * request it belongs to (per-request correlation), not in whatever framing the
 * most recent inbound frame happened to use (the retired global-flip model).
 * The client-side parser below is deliberately NOT JsonRpcFrameReader: it
 * scans the raw byte stream and classifies every frame independently, so a
 * response stream that alternates framings mid-stream is decoded faithfully.
 */

type FramedMessage = {
  message: { id?: string | number; result?: Record<string, unknown>; error?: Record<string, unknown> };
  mode: ConcreteFramingMode;
};

function startFixture(env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/stdio-supervisor-timeout-worker.runtime.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, MCP_VALIDATE_PROJECT_TIMEOUT_MS: "10000", ...env },
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

/**
 * Frame-by-frame stdout decoder: every frame is classified on its own bytes
 * ('{' opens a newline-delimited JSON frame; anything else must be a
 * Content-Length header block), so mixed-mode response streams parse exactly.
 */
function collectFramedResponses(child: ChildProcessWithoutNullStreams): {
  next(id: string | number, timeoutMs?: number): Promise<FramedMessage>;
} {
  let buffer = Buffer.alloc(0);
  const frames: FramedMessage[] = [];
  const waiters = new Map<string, (frame: FramedMessage) => void>();

  const push = (frame: FramedMessage): void => {
    const id = frame.message.id;
    if (id === undefined) return;
    const waiter = waiters.get(String(id));
    if (waiter) {
      waiters.delete(String(id));
      waiter(frame);
      return;
    }
    frames.push(frame);
  };

  const drain = (): void => {
    for (;;) {
      let start = 0;
      while (start < buffer.length && (buffer[start] === 0x0a || buffer[start] === 0x0d)) start += 1;
      if (start > 0) buffer = buffer.subarray(start);
      if (buffer.length === 0) return;

      if (buffer[0] === 0x7b /* '{' */) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex === -1) return;
        const line = buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
        buffer = buffer.subarray(newlineIndex + 1);
        push({ message: JSON.parse(line), mode: "line" });
        continue;
      }

      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headers = buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /content-length:\s*([0-9]+)/i.exec(headers);
      if (!lengthMatch) {
        throw new Error(`unparseable stdout frame header: ${headers.slice(0, 200)}`);
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(lengthMatch[1]);
      if (buffer.length < bodyEnd) return;
      const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.subarray(bodyEnd);
      push({ message: JSON.parse(body), mode: "content-length" });
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });

  return {
    next(id, timeoutMs = 8_000) {
      const existingIndex = frames.findIndex((frame) => frame.message.id === id);
      if (existingIndex >= 0) {
        return Promise.resolve(frames.splice(existingIndex, 1)[0]);
      }
      return new Promise<FramedMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(String(id));
          reject(new Error(`timed out waiting for response ${String(id)}`));
        }, timeoutMs);
        waiters.set(String(id), (frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    }
  };
}

async function handshake(
  child: ChildProcessWithoutNullStreams,
  replies: ReturnType<typeof collectFramedResponses>,
  id: number,
  mode: ConcreteFramingMode
): Promise<FramedMessage> {
  send(child, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "response-framing-test", version: "1.0.0" }
    }
  }, mode);
  const reply = await replies.next(id);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, mode);
  return reply;
}

async function workerPid(
  child: ChildProcessWithoutNullStreams,
  replies: ReturnType<typeof collectFramedResponses>,
  id: number,
  mode: ConcreteFramingMode
): Promise<number> {
  send(child, { jsonrpc: "2.0", id, method: "worker/pid", params: {} }, mode);
  const reply = await replies.next(id);
  const pid = (reply.message.result as { pid?: number } | undefined)?.pid;
  assert.ok(typeof pid === "number" && pid > 0, "fixture worker must report its pid");
  return pid;
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`worker pid ${pid} did not exit`);
}

test("response framing correlation: newline then Content-Length pipeline answers each request in its own framing", { timeout: 20_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectFramedResponses(child);

  const init = await handshake(child, replies, 100, "line");
  assert.equal(init.mode, "line");

  // The line request is admitted first but answered LAST (delayMs); by the
  // time its response is written, the latest inbound frame was Content-Length.
  send(child, {
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: { name: "list-versions", arguments: { delayMs: 400 } }
  }, "line");
  send(child, {
    jsonrpc: "2.0",
    id: 102,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, "content-length");

  const second = await replies.next(102);
  assert.equal(second.mode, "content-length", "Content-Length request must be answered in Content-Length framing");

  const first = await replies.next(101);
  assert.equal(first.mode, "line", "newline request must be answered in newline framing even after a Content-Length frame arrived");
});

test("response framing correlation: Content-Length then newline pipeline answers each request in its own framing", { timeout: 20_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectFramedResponses(child);

  const init = await handshake(child, replies, 110, "content-length");
  assert.equal(init.mode, "content-length");

  send(child, {
    jsonrpc: "2.0",
    id: 111,
    method: "tools/call",
    params: { name: "list-versions", arguments: { delayMs: 400 } }
  }, "content-length");
  send(child, {
    jsonrpc: "2.0",
    id: 112,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, "line");

  const second = await replies.next(112);
  assert.equal(second.mode, "line", "newline request must be answered in newline framing even on a connection opened with Content-Length");

  const first = await replies.next(111);
  assert.equal(first.mode, "content-length", "Content-Length request must keep Content-Length framing after a newline frame arrived");
});

test("response framing correlation: mid-stream switch keeps in-flight and post-switch requests in their own framings", { timeout: 20_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectFramedResponses(child);

  await handshake(child, replies, 120, "line");

  // Completed round-trip before the switch.
  send(child, {
    jsonrpc: "2.0",
    id: 121,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, "line");
  const before = await replies.next(121);
  assert.equal(before.mode, "line");

  // In-flight line request straddles the switch to Content-Length.
  send(child, {
    jsonrpc: "2.0",
    id: 122,
    method: "tools/call",
    params: { name: "list-versions", arguments: { delayMs: 400 } }
  }, "line");
  send(child, {
    jsonrpc: "2.0",
    id: 123,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, "content-length");

  const after = await replies.next(123);
  assert.equal(after.mode, "content-length", "post-switch request must be answered in Content-Length framing");

  const straddling = await replies.next(122);
  assert.equal(straddling.mode, "line", "request admitted before the switch must still be answered in newline framing");
});

test("response framing correlation: request queued across a worker restart is answered in its admission framing", { timeout: 30_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectFramedResponses(child);

  await handshake(child, replies, 130, "line");
  const pid = await workerPid(child, replies, 131, "line");

  process.kill(pid, "SIGKILL");
  await waitForProcessExit(pid);

  // Admitted while the worker is down, in a DIFFERENT framing than the
  // previous traffic; a line-framed request follows so the last-detected
  // inbound mode diverges from request 132's own framing.
  send(child, {
    jsonrpc: "2.0",
    id: 132,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, "content-length");
  send(child, {
    jsonrpc: "2.0",
    id: 133,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, "line");

  const queuedContentLength = await replies.next(132, 15_000);
  assert.equal(
    queuedContentLength.mode,
    "content-length",
    "request queued across the restart must be answered in its own Content-Length framing"
  );

  const queuedLine = await replies.next(133, 15_000);
  assert.equal(
    queuedLine.mode,
    "line",
    "request queued across the restart must be answered in its own newline framing"
  );
});

test("response framing correlation: worker-restart synthesis uses the originating request's framing", { timeout: 30_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const child = startFixture();
  t.after(() => child.kill("SIGKILL"));
  const replies = collectFramedResponses(child);

  await handshake(child, replies, 140, "line");
  const pid = await workerPid(child, replies, 141, "line");

  // Long-running line-framed tools/call is pending in the worker while the
  // latest inbound frame (142's probe) switches the stream to Content-Length.
  send(child, {
    jsonrpc: "2.0",
    id: 142,
    method: "tools/call",
    params: { name: "list-versions", arguments: { delayMs: 60_000 } }
  }, "line");
  send(child, { jsonrpc: "2.0", id: 143, method: "worker/pid", params: {} }, "content-length");
  const probe = await replies.next(143);
  assert.equal(probe.mode, "content-length");

  process.kill(pid, "SIGKILL");

  const synthetic = await replies.next(142, 15_000);
  assert.equal(
    synthetic.mode,
    "line",
    "worker-restart synthesis must use the failed request's newline framing, not the latest inbound Content-Length"
  );
  const structured = (synthetic.message.result as {
    structuredContent?: { error?: { code?: string } };
  } | undefined)?.structuredContent;
  assert.equal(structured?.error?.code, "ERR_WORKER_RESTART");
});
