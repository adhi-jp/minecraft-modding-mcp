import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { assertValidTypedNbtDocument, type TypedNbtDocument } from "../src/nbt/typed-json.ts";

import { expectAppErrorCode } from "./helpers/expect-app-error.ts";

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

test("assertValidTypedNbtDocument rejects a non-record document", () => {
  assert.throws(
    () => assertValidTypedNbtDocument("not-a-document"),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "" })
  );
});

test("assertValidTypedNbtDocument rejects a missing root node", () => {
  assert.throws(
    () => assertValidTypedNbtDocument({ rootName: "NoRoot" }),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root" })
  );
});

test("assertValidTypedNbtDocument rejects a non-object root", () => {
  assert.throws(
    () => assertValidTypedNbtDocument({ rootName: "BadRoot", root: 5 }),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root" })
  );
});

test("assertValidTypedNbtDocument rejects a node missing its 'type' field", () => {
  assert.throws(
    () => assertValidTypedNbtDocument({ rootName: "NoType", root: { value: 1 } }),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/type" })
  );
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
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/value" })
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
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON)
  );
});

test("assertValidTypedNbtDocument accepts non-finite float/double sentinels", () => {
  for (const value of ["NaN", "Infinity", "-Infinity"]) {
    for (const type of ["float", "double"] as const) {
      const input = {
        rootName: "NonFinite",
        root: { type, value }
      };

      assert.doesNotThrow(() => assertValidTypedNbtDocument(input));
    }
  }
});

test("assertValidTypedNbtDocument rejects unrecognized float/double strings", () => {
  const input = {
    rootName: "Bad",
    root: {
      type: "float",
      value: "not-a-number"
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(input),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/value" })
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
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/value/1" })
  );
});

test("assertValidTypedNbtDocument rejects out-of-range intArray values", () => {
  const input = {
    rootName: "Bad",
    root: {
      type: "intArray",
      value: [0, 2147483648]
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(input),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/value/1" })
  );
});

test("assertValidTypedNbtDocument rejects out-of-range longArray values", () => {
  const input = {
    rootName: "Bad",
    root: {
      type: "longArray",
      value: ["0", "9223372036854775808"]
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(input),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/value/1" })
  );
});

test("assertValidTypedNbtDocument escapes compound key tokens in the JSON pointer", () => {
  const slashKey = {
    rootName: "Bad",
    root: {
      type: "compound",
      value: {
        "a/b": { type: "long", value: 1 }
      }
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(slashKey),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/value/a~1b/value" })
  );

  const tildeKey = {
    rootName: "Bad",
    root: {
      type: "compound",
      value: {
        "a~b": { type: "long", value: 1 }
      }
    }
  };

  assert.throws(
    () => assertValidTypedNbtDocument(tildeKey),
    expectAppErrorCode(ERROR_CODES.NBT_INVALID_TYPED_JSON, { jsonPointer: "/root/value/a~0b/value" })
  );
});
