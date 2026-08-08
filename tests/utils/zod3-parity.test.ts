import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { toFieldErrorsFromZod } from "../../src/tool-guidance.ts";
import { optionalPositiveInt, zod3ParityIntCheck } from "../../src/tool-schemas.ts";
import { positiveIntSchema } from "../../src/entry-tools/entry-tool-schema.ts";

/**
 * zod3-parity layer unit tests: every branch pinned with LITERAL expected
 * bytes. The public fieldErrors bytes are a frozen contract (zod3 default
 * texts and code names), reconstructed from zod4 structured issues by
 * src/tool-guidance.ts toFieldErrorsFromZod.
 */

function fieldErrors(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  assert.ok(!result.success, "input was expected to fail validation");
  return toFieldErrorsFromZod(result.error, input);
}

test("parity: missing required field maps to invalid_type/Required", () => {
  const schema = z.object({ task: z.string(), subject: z.object({}) });
  assert.deepEqual(fieldErrors(schema, {}), [
    { path: "task", message: "Required", code: "invalid_type" },
    { path: "subject", message: "Required", code: "invalid_type" }
  ]);
});

test("parity: wrong primitive type maps to zod3 Expected/received bytes", () => {
  const schema = z.object({ includeFiles: z.boolean().optional() });
  assert.deepEqual(fieldErrors(schema, { includeFiles: "not-a-boolean" }), [
    { path: "includeFiles", message: "Expected boolean, received string", code: "invalid_type" }
  ]);
});

test("parity: enum failure with a STRING received keeps invalid_enum_value bytes", () => {
  const schema = z.object({ detail: z.enum(["summary", "standard", "full"]).optional() });
  assert.deepEqual(fieldErrors(schema, { detail: "__premigration_bogus_enum__" }), [
    {
      path: "detail",
      message:
        "Invalid enum value. Expected 'summary' | 'standard' | 'full', received '__premigration_bogus_enum__'",
      code: "invalid_enum_value"
    }
  ]);
});

test("parity: enum failure with a NON-STRING received maps to invalid_type (zod3 type-check-first)", () => {
  const schema = z.object({
    mode: z.enum(["summary", "standard", "full"]).optional(),
    def: z.enum(["p", "q"]).default("p")
  });
  assert.deepEqual(fieldErrors(schema, { mode: 5 }), [
    { path: "mode", message: "Expected 'summary' | 'standard' | 'full', received number", code: "invalid_type" }
  ]);
  assert.deepEqual(fieldErrors(schema, { mode: null }), [
    { path: "mode", message: "Expected 'summary' | 'standard' | 'full', received null", code: "invalid_type" }
  ]);
  assert.deepEqual(fieldErrors(schema, { mode: { bogus: 1 } }), [
    { path: "mode", message: "Expected 'summary' | 'standard' | 'full', received object", code: "invalid_type" }
  ]);
  assert.deepEqual(fieldErrors(schema, { mode: ["summary"] }), [
    { path: "mode", message: "Expected 'summary' | 'standard' | 'full', received array", code: "invalid_type" }
  ]);
  // .default()-wrapped enum keeps the same classification.
  assert.deepEqual(fieldErrors(schema, { def: 3 }), [
    { path: "def", message: "Expected 'p' | 'q', received number", code: "invalid_type" }
  ]);
});

test("parity: enum failures at nested paths and array elements keep zod3 path joining", () => {
  const schema = z.object({
    nested: z.object({ kind: z.enum(["a", "b"]) }).optional(),
    arr: z.array(z.enum(["x", "y"])).optional()
  });
  assert.deepEqual(fieldErrors(schema, { nested: { kind: true } }), [
    { path: "nested.kind", message: "Expected 'a' | 'b', received boolean", code: "invalid_type" }
  ]);
  assert.deepEqual(fieldErrors(schema, { arr: ["x", 7] }), [
    { path: "arr.1", message: "Expected 'x' | 'y', received number", code: "invalid_type" }
  ]);
});

test("parity: discriminated-union failure maps to invalid_union_discriminator at the discriminator path", () => {
  const schema = z.object({
    subject: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("jar"), jarPath: z.string() }),
      z.object({ kind: z.literal("class"), className: z.string() })
    ])
  });
  assert.deepEqual(fieldErrors(schema, { subject: { kind: "__premigration_bogus__" } }), [
    {
      path: "subject.kind",
      message: "Invalid discriminator value. Expected 'jar' | 'class'",
      code: "invalid_union_discriminator"
    }
  ]);
});

test("parity: too_small array/number/string keep zod3 wording incl. exclusive bounds", () => {
  const schema = z.object({
    entries: z.array(z.string()).min(1).optional(),
    gt: z.number().gt(0).optional(),
    gte: z.number().min(1).optional(),
    s: z.string().min(1).optional()
  });
  assert.deepEqual(fieldErrors(schema, { entries: [] }), [
    { path: "entries", message: "Array must contain at least 1 element(s)", code: "too_small" }
  ]);
  assert.deepEqual(fieldErrors(schema, { gt: 0 }), [
    { path: "gt", message: "Number must be greater than 0", code: "too_small" }
  ]);
  assert.deepEqual(fieldErrors(schema, { gte: 0 }), [
    { path: "gte", message: "Number must be greater than or equal to 1", code: "too_small" }
  ]);
  assert.deepEqual(fieldErrors(schema, { s: "" }), [
    { path: "s", message: "String must contain at least 1 character(s)", code: "too_small" }
  ]);
});

test("parity: too_big number and batch-style entries.max(50) keep zod3 wording", () => {
  const schema = z.object({
    concurrency: z.number().check(zod3ParityIntCheck).min(1).max(8).optional(),
    entries: z.array(z.object({ className: z.string() })).min(1).max(50).optional()
  });
  assert.deepEqual(fieldErrors(schema, { concurrency: 99 }), [
    { path: "concurrency", message: "Number must be less than or equal to 8", code: "too_big" }
  ]);
  const oversized = Array.from({ length: 51 }, (_, index) => ({ className: `C${index}` }));
  assert.deepEqual(fieldErrors(schema, { entries: oversized }), [
    { path: "entries", message: "Array must contain at most 50 element(s)", code: "too_big" }
  ]);
});

test("parity: unrecognized strict-object keys keep zod3 quoting", () => {
  const schema = z.object({ inner: z.object({ a: z.string() }).strict() });
  assert.deepEqual(fieldErrors(schema, { inner: { a: "x", __premigrationUnknownKey: true } }), [
    {
      path: "inner",
      message: "Unrecognized key(s) in object: '__premigrationUnknownKey'",
      code: "unrecognized_keys"
    }
  ]);
});

test("parity: custom issues pass through unchanged", () => {
  const schema = z.object({ a: z.string().optional() }).superRefine((_value, ctx) => {
    ctx.addIssue({ code: "custom", message: "Exactly one of a or b required." });
  });
  assert.deepEqual(fieldErrors(schema, {}), [
    { path: "$", message: "Exactly one of a or b required.", code: "custom" }
  ]);
});

test("parity: a custom message that mimics a zod4 default prefix still passes through unchanged", () => {
  // code "custom" bypasses every reconstruction gate — even when the app text
  // happens to start with a zod4 default prefix like "Too small: ".
  const schema = z.object({ a: z.string().optional() }).superRefine((_value, ctx) => {
    ctx.addIssue({ code: "custom", message: "Too small: needs more cowbell", path: ["a"] });
  });
  assert.deepEqual(fieldErrors(schema, { a: "x" }), [
    { path: "a", message: "Too small: needs more cowbell", code: "custom" }
  ]);
});

test("parity: int-typed fields reject floats with zod3's exact integer/float bytes", () => {
  const schema = z.object({ limit: optionalPositiveInt });
  assert.deepEqual(fieldErrors(schema, { limit: 1.5 }), [
    { path: "limit", message: "Expected integer, received float", code: "invalid_type" }
  ]);
  // Non-aborting checks (zod3 behavior): a negative float reports BOTH the
  // integer failure and the positivity failure.
  assert.deepEqual(fieldErrors(schema, { limit: -2.5 }), [
    { path: "limit", message: "Expected integer, received float", code: "invalid_type" },
    { path: "limit", message: "Number must be greater than 0", code: "too_small" }
  ]);
});

test("parity: int-typed fields ACCEPT unsafe integers exactly like zod3", () => {
  const schema = z.object({ limit: optionalPositiveInt });
  const unsafe = 9007199254740992; // 2^53 — Number.isInteger true, unsafe
  assert.equal(Number.isInteger(unsafe), true);
  const parsed = schema.safeParse({ limit: unsafe });
  assert.equal(parsed.success, true, "zod3 accepted every Number.isInteger value; zod4 .int() must not narrow this");
});

test("parity: entry-tool positiveIntSchema shares the zod3 integer acceptance and float bytes", () => {
  const unsafe = 9007199254740992; // 2^53
  assert.equal(positiveIntSchema.safeParse(unsafe).success, true);
  const schema = z.object({ maxResults: positiveIntSchema });
  assert.deepEqual(toFieldErrorsFromZod(
    (schema.safeParse({ maxResults: 2.5 }) as { error: z.ZodError }).error,
    { maxResults: 2.5 }
  ), [
    { path: "maxResults", message: "Expected integer, received float", code: "invalid_type" }
  ]);
});
