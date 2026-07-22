import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeJsonRpcMessage,
  JsonRpcFrameReader,
  loadMaxFrameBytes
} from "../../src/json-rpc-framing.ts";

const NORMAL_MESSAGE = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "ping"
};

function createHarness(maxFrameBytes: number): {
  reader: JsonRpcFrameReader;
  frames: unknown[];
  errors: Error[];
  process: (chunk: Buffer) => void;
} {
  const reader = new JsonRpcFrameReader({ maxFrameBytes });
  const frames: unknown[] = [];
  const errors: Error[] = [];
  return {
    reader,
    frames,
    errors,
    process(chunk) {
      reader.processChunk(chunk, {
        onFrame: ({ message }) => frames.push(message),
        onError: (error) => errors.push(error)
      });
    }
  };
}

test("oversized Content-Length frames report the limit and preserve the next frame", () => {
  const harness = createHarness(64);
  const oversizedBody = Buffer.alloc(96, 0x20);
  const oversizedFrame = Buffer.concat([
    Buffer.from(`Content-Length: ${oversizedBody.length}\r\n\r\n`, "utf8"),
    oversizedBody
  ]);

  harness.process(Buffer.concat([
    oversizedFrame,
    encodeJsonRpcMessage(NORMAL_MESSAGE, "line")
  ]));

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0]?.message ?? "", /Content-Length 96.*limit.*64/i);
  assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
});

test("oversized Content-Length frames are rejected before a chunked body is buffered", () => {
  const maxFrameBytes = 64;
  const body = Buffer.alloc(256, 0x20);
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body
  ]);
  const harness = createHarness(maxFrameBytes);
  let deliveredBytes = 0;

  for (const byte of frame) {
    harness.process(Buffer.from([byte]));
    deliveredBytes += 1;
    if (harness.errors.length > 0) {
      break;
    }
  }

  assert.equal(harness.errors.length, 1);
  assert.ok(deliveredBytes <= maxFrameBytes + 64, `rejection waited for ${deliveredBytes} bytes`);
  assert.ok(deliveredBytes < frame.length);
});

test("headerless garbage exceeding the frame limit is rejected and the reader recovers", () => {
  const harness = createHarness(64);

  harness.process(Buffer.alloc(65, 0x78));

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0]?.message ?? "", /65.*limit.*64/i);

  harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
  assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
});

test("an overlong line-delimited frame is rejected and the reader recovers", () => {
  const harness = createHarness(64);
  harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
  harness.frames.length = 0;

  harness.process(Buffer.alloc(65, 0x78));

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0]?.message ?? "", /line-delimited.*65.*limit.*64/i);

  harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
  assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
});

test("loadMaxFrameBytes applies defaults, overrides, fallback, and the minimum clamp", () => {
  assert.equal(loadMaxFrameBytes(undefined), 67_108_864);
  assert.equal(loadMaxFrameBytes("2097152"), 2_097_152);
  assert.equal(loadMaxFrameBytes("invalid"), 67_108_864);
  assert.equal(loadMaxFrameBytes("9007199254740992"), 67_108_864);
  assert.equal(loadMaxFrameBytes("1024"), 1_048_576);
});

test("reset and clear cancel oversized-frame discard state", () => {
  for (const resetReader of [
    (reader: JsonRpcFrameReader) => reader.reset(),
    (reader: JsonRpcFrameReader) => reader.clear()
  ]) {
    const harness = createHarness(64);
    harness.process(Buffer.from("Content-Length: 96\r\n\r\n", "utf8"));
    assert.equal(harness.errors.length, 1);

    resetReader(harness.reader);
    harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
    assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
  }
});
