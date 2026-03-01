import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { CompatStdioServerTransport } from "../src/compat-stdio-transport.ts";

function buildInitializeRequest(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "transport-test",
        version: "1.0.0"
      }
    }
  };
}

function buildInitializeResult(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: true }
      },
      serverInfo: {
        name: "minecraft-modding-mcp",
        version: "1.1.0"
      }
    }
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTransport(): {
  transport: CompatStdioServerTransport;
  stdin: PassThrough;
  stdout: PassThrough;
  output: string;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const transport = new CompatStdioServerTransport(
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream
  );

  return {
    transport,
    stdin,
    stdout,
    get output() {
      return output;
    }
  };
}

test("CompatStdioServerTransport parses newline-delimited JSON-RPC messages", async () => {
  const { transport, stdin } = createTransport();
  const messages: JSONRPCMessage[] = [];

  transport.onmessage = (message) => {
    messages.push(message);
  };

  await transport.start();

  const request = buildInitializeRequest(1);
  stdin.write(`${JSON.stringify(request)}\n`);
  await flush();

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], request);

  await transport.close();
});

test("CompatStdioServerTransport parses Content-Length framed JSON-RPC messages", async () => {
  const { transport, stdin } = createTransport();
  const messages: JSONRPCMessage[] = [];

  transport.onmessage = (message) => {
    messages.push(message);
  };

  await transport.start();

  const request = buildInitializeRequest(2);
  const body = JSON.stringify(request);
  stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  await flush();

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], request);

  await transport.close();
});

test("CompatStdioServerTransport emits newline-delimited responses after newline input", async () => {
  const harness = createTransport();
  const { transport, stdin } = harness;

  await transport.start();
  const request = buildInitializeRequest(3);
  stdin.write(`${JSON.stringify(request)}\n`);
  await flush();

  const response = buildInitializeResult(3);
  await transport.send(response);
  await flush();

  assert.equal(harness.output, `${JSON.stringify(response)}\n`);

  await transport.close();
});

test("CompatStdioServerTransport emits Content-Length responses after Content-Length input", async () => {
  const harness = createTransport();
  const { transport, stdin } = harness;

  await transport.start();
  const request = buildInitializeRequest(4);
  const body = JSON.stringify(request);
  stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  await flush();

  const response = buildInitializeResult(4);
  const responseBody = JSON.stringify(response);
  await transport.send(response);
  await flush();

  assert.equal(
    harness.output,
    `Content-Length: ${Buffer.byteLength(responseBody, "utf8")}\r\n\r\n${responseBody}`
  );

  await transport.close();
});

test("CompatStdioServerTransport waits until full Content-Length body is available", async () => {
  const { transport, stdin } = createTransport();
  const messages: JSONRPCMessage[] = [];

  transport.onmessage = (message) => {
    messages.push(message);
  };

  await transport.start();

  const request = buildInitializeRequest(5);
  const body = JSON.stringify(request);
  const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  const splitAt = Math.floor(frame.length / 2);

  stdin.write(frame.slice(0, splitAt));
  await flush();
  assert.equal(messages.length, 0);

  stdin.write(frame.slice(splitAt));
  await flush();
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], request);

  await transport.close();
});

test("CompatStdioServerTransport reports malformed Content-Length headers and recovers", async () => {
  const { transport, stdin } = createTransport();
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];

  transport.onmessage = (message) => {
    messages.push(message);
  };
  transport.onerror = (error) => {
    errors.push(error);
  };

  await transport.start();

  stdin.write("Content-Length: nope\r\n\r\n");
  await flush();

  const request = buildInitializeRequest(6);
  stdin.write(`${JSON.stringify(request)}\n`);
  await flush();

  assert.ok(errors.length >= 1);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], request);

  await transport.close();
});

test("CompatStdioServerTransport handles mid-stream switch from line to Content-Length with CRLF endings", async () => {
  const { transport, stdin } = createTransport();
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];

  transport.onmessage = (message) => {
    messages.push(message);
  };
  transport.onerror = (error) => {
    errors.push(error);
  };

  await transport.start();

  // First message: newline-delimited → locks mode to "line".
  const first = buildInitializeRequest(10);
  stdin.write(`${JSON.stringify(first)}\n`);
  await flush();
  assert.equal(messages.length, 1);

  // Second message: Content-Length with \r\n endings arriving in "line" mode.
  // The parser must re-inject the header correctly so findHeaderBoundary succeeds.
  const second = buildInitializeRequest(11);
  const body = JSON.stringify(second);
  stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  await flush();

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], second);

  await transport.close();
});
