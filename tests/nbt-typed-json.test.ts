import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { assertValidTypedNbtDocument, type TypedNbtDocument } from "../src/nbt/typed-json.ts";

test("assertValidTypedNbtDocument accepts a valid typed NBT document", () => {
  const input: TypedNbtDocument = {
    rootName: "Level",
    root: {
      type: "compound",
      value: {
        health: { type: "int", value: 20 },
        owner: { type: "string", value: "Alex" },
        ticks: { type: "long", value: "9223372036854775807" },
        items: {
          type: "list",
          elementType: "string",
          value: [
            { type: "string", value: "apple" },
            { type: "string", value: "bread" }
          ]
        },
        bytes: { type: "byteArray", value: [1, -2, 3] },
        values: { type: "intArray", value: [1, 2, -3] },
        longs: { type: "longArray", value: ["1", "-2", "3"] }
      }
    }
  };

  assert.doesNotThrow(() => assertValidTypedNbtDocument(input));
});

test("assertValidTypedNbtDocument rejects non-string long values", () => {
  const input = {
    rootName: "Bad",
    root: {
      type: "long",
      value: 1
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(input),
    (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) {
        return false;
      }

      const err = error as { code: string; details?: Record<string, unknown> };
      return (
        err.code === ERROR_CODES.NBT_INVALID_TYPED_JSON &&
        err.details?.jsonPointer === "/root/value"
      );
    }
  );
});

test("assertValidTypedNbtDocument rejects list element type mismatches", () => {
  const input = {
    rootName: "Bad",
    root: {
      type: "list",
      elementType: "int",
      value: [{ type: "string", value: "not-an-int" }]
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(input),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.NBT_INVALID_TYPED_JSON
  );
});

test("assertValidTypedNbtDocument rejects out-of-range byteArray values", () => {
  const input = {
    rootName: "Bad",
    root: {
      type: "byteArray",
      value: [127, 128]
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(input),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.NBT_INVALID_TYPED_JSON
  );
});
