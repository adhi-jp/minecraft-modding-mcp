import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { decodeJavaNbt, encodeJavaNbt } from "../src/nbt/java-nbt-codec.ts";
import type { TypedNbtDocument } from "../src/nbt/typed-json.ts";

test("decodeJavaNbt decodes a simple known Java NBT payload", () => {
  const bytes = Buffer.from("0a000152030006616e737765720000002a00", "hex");

  const decoded = decodeJavaNbt(bytes);

  assert.deepEqual(decoded, {
    rootName: "R",
    root: {
      type: "compound",
      value: {
        answer: { type: "int", value: 42 }
      }
    }
  });
});

test("encodeJavaNbt/decodeJavaNbt roundtrip preserves typed structure", () => {
  const input: TypedNbtDocument = {
    rootName: "Level",
    root: {
      type: "compound",
      value: {
        b: { type: "byte", value: -12 },
        s: { type: "short", value: 1234 },
        i: { type: "int", value: -123456 },
        l: { type: "long", value: "-9223372036854775808" },
        f: { type: "float", value: 1.5 },
        d: { type: "double", value: -23.125 },
        text: { type: "string", value: "hello" },
        bytes: { type: "byteArray", value: [1, -2, 3] },
        ints: { type: "intArray", value: [10, 20, -30] },
        longs: { type: "longArray", value: ["1", "-2", "3"] },
        list: {
          type: "list",
          elementType: "compound",
          value: [
            {
              type: "compound",
              value: {
                name: { type: "string", value: "first" }
              }
            },
            {
              type: "compound",
              value: {
                name: { type: "string", value: "second" }
              }
            }
          ]
        }
      }
    }
  };

  const encoded = encodeJavaNbt(input);
  const decoded = decodeJavaNbt(encoded);

  assert.deepEqual(decoded, input);
});

test("decodeJavaNbt throws structured parse errors for truncated payloads", () => {
  const truncated = Buffer.from([0x0a, 0x00]);

  assert.throws(
    () => decodeJavaNbt(truncated),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.NBT_PARSE_FAILED
  );
});

test("encodeJavaNbt rejects out-of-range long values", () => {
  const input = {
    rootName: "TooBig",
    root: {
      type: "long",
      value: "9223372036854775808"
    }
  } as const;

  assert.throws(
    () => encodeJavaNbt(input),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.NBT_INVALID_TYPED_JSON
  );
});
