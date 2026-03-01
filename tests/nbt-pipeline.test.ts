import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { applyNbtJsonPatch, nbtBase64ToTypedJson, typedJsonToNbtBase64 } from "../src/nbt/pipeline.ts";
import type { TypedNbtDocument } from "../src/nbt/typed-json.ts";

function buildSample(): TypedNbtDocument {
  return {
    rootName: "Root",
    root: {
      type: "compound",
      value: {
        counter: { type: "int", value: 1 },
        name: { type: "string", value: "Steve" }
      }
    }
  };
}

test("typedJsonToNbtBase64 + nbtBase64ToTypedJson support gzip roundtrip with auto detection", () => {
  const input = buildSample();

  const encoded = typedJsonToNbtBase64({
    typedJson: input,
    compression: "gzip"
  });

  const decoded = nbtBase64ToTypedJson({
    nbtBase64: encoded.nbtBase64,
    compression: "auto"
  });

  assert.equal(encoded.meta.compressionApplied, "gzip");
  assert.equal(decoded.meta.compressionDetected, "gzip");
  assert.deepEqual(decoded.typedJson, input);
  assert.ok(encoded.meta.outputBytes > 0);
  assert.ok(decoded.meta.inputBytes > 0);
});

test("applyNbtJsonPatch reports metadata and returns patched typed json", () => {
  const input = buildSample();

  const output = applyNbtJsonPatch({
    typedJson: input,
    patch: [
      { op: "replace", path: "/root/value/counter/value", value: 2 },
      { op: "test", path: "/root/value/name/value", value: "Steve" }
    ]
  });

  assert.equal(output.meta.appliedOps, 2);
  assert.equal(output.meta.testOps, 1);
  assert.equal(output.meta.changed, true);
  assert.equal(
    (output.typedJson.root as { value: { counter: { value: number } } }).value.counter.value,
    2
  );
});

test("nbtBase64ToTypedJson enforces max input bytes limit", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "none" });

  assert.throws(
    () =>
      (nbtBase64ToTypedJson as unknown as (
        input: unknown,
        limits: { maxInputBytes: number; maxInflatedBytes: number; maxResponseBytes: number }
      ) => unknown)(
        { nbtBase64: encoded.nbtBase64, compression: "none" },
        { maxInputBytes: 1, maxInflatedBytes: 1_000_000, maxResponseBytes: 1_000_000 }
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.LIMIT_EXCEEDED
  );
});

test("nbtBase64ToTypedJson enforces max inflated bytes for gzip payloads", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "gzip" });

  assert.throws(
    () =>
      (nbtBase64ToTypedJson as unknown as (
        input: unknown,
        limits: { maxInputBytes: number; maxInflatedBytes: number; maxResponseBytes: number }
      ) => unknown)(
        { nbtBase64: encoded.nbtBase64, compression: "auto" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 8, maxResponseBytes: 1_000_000 }
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.LIMIT_EXCEEDED
  );
});

test("nbtBase64ToTypedJson enforces typedJson response bytes limit", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "none" });

  assert.throws(
    () =>
      (nbtBase64ToTypedJson as unknown as (
        input: unknown,
        limits: { maxInputBytes: number; maxInflatedBytes: number; maxResponseBytes: number }
      ) => unknown)(
        { nbtBase64: encoded.nbtBase64, compression: "none" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 8 }
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.LIMIT_EXCEEDED
  );
});

test("typedJsonToNbtBase64 enforces response bytes limit", () => {
  const sample = buildSample();

  assert.throws(
    () =>
      (typedJsonToNbtBase64 as unknown as (
        input: unknown,
        limits: { maxInputBytes: number; maxInflatedBytes: number; maxResponseBytes: number }
      ) => unknown)(
        { typedJson: sample, compression: "none" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 8 }
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.LIMIT_EXCEEDED
  );
});

test("applyNbtJsonPatch enforces patched typedJson response bytes limit", () => {
  const sample = buildSample();

  assert.throws(
    () =>
      (applyNbtJsonPatch as unknown as (
        input: unknown,
        limits: { maxInputBytes: number; maxInflatedBytes: number; maxResponseBytes: number }
      ) => unknown)(
        {
          typedJson: sample,
          patch: [{ op: "test", path: "/root/value/name/value", value: "Steve" }]
        },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 8 }
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.LIMIT_EXCEEDED
  );
});

test("nbtBase64ToTypedJson treats truncated gzip payload as parse failure, not limit exceeded", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "gzip" });
  const truncated = encoded.nbtBase64.slice(0, -4);

  assert.throws(
    () =>
      (nbtBase64ToTypedJson as unknown as (
        input: unknown,
        limits: { maxInputBytes: number; maxInflatedBytes: number; maxResponseBytes: number }
      ) => unknown)(
        { nbtBase64: truncated, compression: "gzip" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 1_000_000 }
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.NBT_PARSE_FAILED
  );
});

test("nbtBase64ToTypedJson rejects oversized base64 before Buffer.from decode allocation", () => {
  const oversizedBase64 = "AAAA".repeat(64);
  const originalFrom = Buffer.from;
  let decodeCalled = false;
  let caught: unknown;

  (Buffer as unknown as { from: typeof Buffer.from }).from = ((...args: unknown[]) => {
    decodeCalled = true;
    return (originalFrom as (...inner: unknown[]) => Buffer)(...args);
  }) as typeof Buffer.from;

  try {
    try {
      (nbtBase64ToTypedJson as unknown as (
        input: unknown,
        limits: { maxInputBytes: number; maxInflatedBytes: number; maxResponseBytes: number }
      ) => unknown)(
        { nbtBase64: oversizedBase64, compression: "none" },
        { maxInputBytes: 8, maxInflatedBytes: 1_000_000, maxResponseBytes: 1_000_000 }
      );
    } catch (error) {
      caught = error;
    }
  } finally {
    (Buffer as unknown as { from: typeof Buffer.from }).from = originalFrom;
  }

  assert.equal(decodeCalled, false);
  assert.equal(typeof caught, "object");
  assert.notEqual(caught, null);
  assert.equal((caught as { code?: string }).code, ERROR_CODES.LIMIT_EXCEEDED);
});
