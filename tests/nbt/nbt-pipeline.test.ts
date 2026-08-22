import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { ERROR_CODES } from "../../src/errors.ts";
import {
  applyNbtJsonPatch,
  nbtBase64ToTypedJson,
  typedJsonToNbtBase64,
  type DecodeCompression,
  type EncodeCompression
} from "../../src/nbt/pipeline.ts";
import type { TypedNbtDocument } from "../../src/nbt/typed-json.ts";

import { expectAppErrorCode } from "../helpers/expect-app-error.ts";

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
      nbtBase64ToTypedJson(
        { nbtBase64: encoded.nbtBase64, compression: "none" },
        { maxInputBytes: 1, maxInflatedBytes: 1_000_000, maxResponseBytes: 1_000_000 }
      ),
    expectAppErrorCode(ERROR_CODES.LIMIT_EXCEEDED)
  );
});

test("nbtBase64ToTypedJson enforces max inflated bytes for gzip payloads", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "gzip" });

  assert.throws(
    () =>
      nbtBase64ToTypedJson(
        { nbtBase64: encoded.nbtBase64, compression: "auto" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 8, maxResponseBytes: 1_000_000 }
      ),
    expectAppErrorCode(ERROR_CODES.LIMIT_EXCEEDED)
  );
});

test("nbtBase64ToTypedJson enforces typedJson response bytes limit", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "none" });

  assert.throws(
    () =>
      nbtBase64ToTypedJson(
        { nbtBase64: encoded.nbtBase64, compression: "none" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 8 }
      ),
    expectAppErrorCode(ERROR_CODES.LIMIT_EXCEEDED)
  );
});

test("typedJsonToNbtBase64 enforces response bytes limit", () => {
  const sample = buildSample();

  assert.throws(
    () =>
      typedJsonToNbtBase64(
        { typedJson: sample, compression: "none" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 8 }
      ),
    expectAppErrorCode(ERROR_CODES.LIMIT_EXCEEDED)
  );
});

test("applyNbtJsonPatch enforces patched typedJson response bytes limit", () => {
  const sample = buildSample();

  assert.throws(
    () =>
      applyNbtJsonPatch(
        {
          typedJson: sample,
          patch: [{ op: "test", path: "/root/value/name/value", value: "Steve" }]
        },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 8 }
      ),
    expectAppErrorCode(ERROR_CODES.LIMIT_EXCEEDED)
  );
});

test("nbtBase64ToTypedJson treats truncated gzip payload as parse failure, not limit exceeded", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "gzip" });
  const truncated = encoded.nbtBase64.slice(0, -4);

  assert.throws(
    () =>
      nbtBase64ToTypedJson(
        { nbtBase64: truncated, compression: "gzip" },
        { maxInputBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxResponseBytes: 1_000_000 }
      ),
    expectAppErrorCode(ERROR_CODES.NBT_PARSE_FAILED)
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
      nbtBase64ToTypedJson(
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

test("nbtBase64ToTypedJson rejects an invalid compression value", () => {
  const sample = buildSample();
  const encoded = typedJsonToNbtBase64({ typedJson: sample, compression: "none" });

  assert.throws(
    () =>
      nbtBase64ToTypedJson({
        nbtBase64: encoded.nbtBase64,
        compression: "bogus" as unknown as DecodeCompression
      }),
    expectAppErrorCode(ERROR_CODES.INVALID_INPUT)
  );
});

test("typedJsonToNbtBase64 rejects an invalid compression value", () => {
  const sample = buildSample();

  assert.throws(
    () =>
      typedJsonToNbtBase64({
        typedJson: sample,
        compression: "bogus" as unknown as EncodeCompression
      }),
    expectAppErrorCode(ERROR_CODES.INVALID_INPUT)
  );
});

test("nbtBase64ToTypedJson rejects malformed nbtBase64 input", () => {
  const cases: Array<{ name: string; nbtBase64: unknown }> = [
    { name: "non-string", nbtBase64: 123 },
    { name: "empty string", nbtBase64: "" },
    { name: "whitespace only", nbtBase64: "   " },
    { name: "length not a multiple of 4", nbtBase64: "AAA" },
    { name: "non-base64 characters", nbtBase64: "@@@@" }
  ];

  for (const { name, nbtBase64 } of cases) {
    assert.throws(
      () =>
        nbtBase64ToTypedJson({
          nbtBase64: nbtBase64 as unknown as string,
          compression: "none"
        }),
      expectAppErrorCode(ERROR_CODES.INVALID_INPUT),
      `expected INVALID_INPUT for ${name}`
    );
  }
});

test("typedJsonToNbtBase64 attaches a recovery example when the typed document is invalid", () => {
  // `typedJson` is advertised as an empty JSON Schema, so the rejection is the only
  // place the caller can be pointed at a way to obtain a well-formed document.
  let caught: unknown;
  try {
    typedJsonToNbtBase64({ typedJson: { rootName: "Bad", root: 5 } });
  } catch (error) {
    caught = error;
  }

  assert.equal((caught as { code?: string } | undefined)?.code, ERROR_CODES.NBT_INVALID_TYPED_JSON);
  const details = (caught as { details?: Record<string, unknown> } | undefined)?.details;
  assert.ok(details, "the rejection must carry details");
  assert.equal(details._suggestedCallPrimaryDropped, undefined);

  const exampleCalls = details.exampleCalls as Array<{ tool?: unknown; params?: Record<string, unknown>; reason?: unknown }>;
  assert.ok(Array.isArray(exampleCalls) && exampleCalls.length > 0, "an example recovery call must be attached");
  assert.equal(exampleCalls[0]?.tool, "nbt-to-json");
  assert.equal(typeof exampleCalls[0]?.params?.nbtBase64, "string");
  assert.match(String(exampleCalls[0]?.reason), /json-to-nbt/);
});

test("applyNbtJsonPatch attaches a recovery example when the typed document is invalid", () => {
  let caught: unknown;
  try {
    applyNbtJsonPatch({ typedJson: { rootName: "Bad" }, patch: [] });
  } catch (error) {
    caught = error;
  }

  assert.equal((caught as { code?: string } | undefined)?.code, ERROR_CODES.NBT_INVALID_TYPED_JSON);
  const details = (caught as { details?: Record<string, unknown> } | undefined)?.details;
  assert.ok(details, "the rejection must carry details");
  const exampleCalls = details.exampleCalls as Array<{ tool?: unknown; reason?: unknown }>;
  assert.ok(Array.isArray(exampleCalls) && exampleCalls.length > 0);
  assert.equal(exampleCalls[0]?.tool, "nbt-to-json");
  assert.match(String(exampleCalls[0]?.reason), /nbt-apply-json-patch/);
});

test("every NBT rejection stage carries its own default nextAction", () => {
  // `toHints()` reads only `details.nextAction`, so a rejection without one reaches the
  // client with nothing actionable. Five stages each set a default; all five were
  // unasserted, and deleting every one of them left the suite green.
  const sample = buildSample();
  const nextActionOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      const value = (error as { details?: { nextAction?: unknown } }).details?.nextAction;
      assert.equal(typeof value, "string", "every rejection stage must carry a nextAction");
      return value as string;
    }
    throw new Error("expected the stage to reject");
  };

  const parse = nextActionOf(() =>
    // A tag id the codec does not know, so decoding fails inside the codec itself.
    nbtBase64ToTypedJson({ nbtBase64: Buffer.from([0x63, 0x00]).toString("base64"), compression: "none" })
  );
  assert.match(parse, /not a well-formed Java NBT stream/);
  assert.match(parse, /compression "auto"/);

  const encode = nextActionOf(() =>
    // A string past the uint16 length NBT can express: valid typed JSON, unencodable NBT.
    typedJsonToNbtBase64({
      typedJson: {
        rootName: "Root",
        root: { type: "compound", value: { big: { type: "string", value: "x".repeat(70_000) } } }
      } as TypedNbtDocument
    })
  );
  assert.match(encode, /could not be written as Java NBT/);
  assert.match(encode, /nbt-to-json/);

  const invalidPatch = nextActionOf(() =>
    applyNbtJsonPatch({ typedJson: sample, patch: "not-an-array" as unknown as [] })
  );
  assert.match(invalidPatch, /RFC6902/);
  assert.match(invalidPatch, /typed node, not a bare scalar/);

  const unsupported = nextActionOf(() =>
    applyNbtJsonPatch({
      typedJson: sample,
      patch: [{ op: "move", path: "/root/value/counter", from: "/root/value/name" }] as unknown as []
    })
  );
  assert.match(unsupported, /not expressible in Java NBT/);
  assert.match(unsupported, /homogeneous lists/);

  const conflict = nextActionOf(() =>
    applyNbtJsonPatch({
      typedJson: sample,
      patch: [{ op: "replace", path: "/root/value/absent", value: { type: "int", value: 2 } }] as unknown as []
    })
  );
  assert.match(conflict, /did not hold what the patch expected/);
  assert.match(conflict, /Re-read the current document with nbt-to-json/);

  // Five DISTINCT strings: a single shared default would satisfy every `match` above
  // while telling four of the five callers the wrong thing.
  assert.equal(new Set([parse, encode, invalidPatch, unsupported, conflict]).size, 5);
});

test("a stage that supplies its own nextAction keeps it instead of the shared default", () => {
  // The defaults are merged as `{ nextAction: DEFAULT, ...details }`, so a site that
  // supplies its own wins. The gzip inflate failure is a live example: it shares
  // ERR_NBT_PARSE_FAILED with the codec's parse stage but must not tell the caller to
  // check NBT framing when the real problem is that the bytes are not gzip.
  const corruptGzip = Buffer.concat([
    gzipSync(Buffer.from("hello")).subarray(0, 4),
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  ]);

  let inflateNextAction = "";
  assert.throws(
    () => nbtBase64ToTypedJson({ nbtBase64: corruptGzip.toString("base64"), compression: "gzip" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.NBT_PARSE_FAILED);
      inflateNextAction = String((error as { details?: { nextAction?: unknown } }).details?.nextAction ?? "");
      return true;
    }
  );
  assert.match(inflateNextAction, /valid gzip-compressed NBT data/);
  assert.doesNotMatch(
    inflateNextAction,
    /not a well-formed Java NBT stream/,
    "the codec's parse default must not overwrite the site's own guidance"
  );
});
