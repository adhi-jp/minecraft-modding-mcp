import assert from "node:assert/strict";
import test from "node:test";

import {
  NOOP_STAGE_EMITTER,
  makeStageEmitter,
  type StageEmitterExtra
} from "../src/stage-emitter.ts";

type Capture = {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
};

function makeFakeExtra(requestId: string | number | undefined): {
  capture: Capture;
  extra: StageEmitterExtra | undefined;
} {
  const capture: Capture = { calls: [] };
  if (requestId === undefined) {
    return { capture, extra: undefined };
  }
  const extra = {
    requestId,
    sendNotification: async (notification: { method: string; params?: unknown }) => {
      capture.calls.push({
        method: notification.method,
        params: (notification.params as Record<string, unknown>) ?? {}
      });
    }
  } as unknown as StageEmitterExtra;
  return { capture, extra };
}

test("makeStageEmitter sends $/stageUpdate notification with stage and meta", async () => {
  const { capture, extra } = makeFakeExtra(42);
  const emit = makeStageEmitter(extra);
  await emit("target-lookup", { targetIndex: 1, targetTotal: 5 });
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].method, "$/stageUpdate");
  const params = capture.calls[0].params;
  assert.equal(params.stage, "target-lookup");
  assert.deepEqual(params.meta, { targetIndex: 1, targetTotal: 5 });
  assert.equal(params.requestId, 42);
  assert.equal(typeof params.t, "number");
});

test("makeStageEmitter passes string requestId verbatim", async () => {
  const { capture, extra } = makeFakeExtra("req-7");
  const emit = makeStageEmitter(extra);
  await emit("resolve");
  assert.equal(capture.calls[0].params.requestId, "req-7");
});

test("makeStageEmitter is a no-op when disabled option is true", async () => {
  const { capture, extra } = makeFakeExtra(1);
  const emit = makeStageEmitter(extra, { disabled: true });
  await emit("parse");
  assert.equal(capture.calls.length, 0);
});

test("makeStageEmitter is a no-op when extra is undefined", async () => {
  const emit = makeStageEmitter(undefined);
  await emit("input-validation");
  assert.equal(emit, NOOP_STAGE_EMITTER);
});

test("makeStageEmitter is a no-op when requestId is undefined (SDK fallback)", async () => {
  const capture: Capture = { calls: [] };
  const extra = {
    requestId: undefined as unknown as number,
    sendNotification: async (notification: { method: string }) => {
      capture.calls.push({ method: notification.method, params: {} });
    }
  } as unknown as StageEmitterExtra;
  const emit = makeStageEmitter(extra);
  await emit("resolve");
  assert.equal(capture.calls.length, 0);
});

test("makeStageEmitter is a no-op when sendNotification is missing", async () => {
  const partial = { requestId: 1 } as unknown as StageEmitterExtra;
  const emit = makeStageEmitter(partial);
  await emit("resolve");
  // No throw, no calls — falls back to noop
  assert.equal(emit, NOOP_STAGE_EMITTER);
});

test("makeStageEmitter sends meta as null when omitted", async () => {
  const { capture, extra } = makeFakeExtra(1);
  const emit = makeStageEmitter(extra);
  await emit("mapping-health");
  assert.equal(capture.calls[0].params.meta, null);
});
