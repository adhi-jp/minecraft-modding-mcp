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

test("encodeJavaNbt/decodeJavaNbt round-trip preserves non-finite float/double sentinels", () => {
  const input: TypedNbtDocument = {
    rootName: "NonFinite",
    root: {
      type: "compound",
      value: {
        fNaN: { type: "float", value: "NaN" },
        fInf: { type: "float", value: "Infinity" },
        fNegInf: { type: "float", value: "-Infinity" },
        dNaN: { type: "double", value: "NaN" },
        dInf: { type: "double", value: "Infinity" },
        dNegInf: { type: "double", value: "-Infinity" }
      }
    }
  };

  const decoded = decodeJavaNbt(encodeJavaNbt(input));

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

test("decodeJavaNbt decodes MUTF-8 NUL (C0 80) as U+0000 in string payloads", () => {
  const bytes = Buffer.from([
    0x0a, 0x00, 0x01, 0x52,
    0x08, 0x00, 0x01, 0x6b,
    0x00, 0x04,
    0x61, 0xc0, 0x80, 0x62,
    0x00
  ]);
  const decoded = decodeJavaNbt(bytes);
  const value = (decoded.root as any).value.k.value as string;
  assert.equal(value.length, 3);
  assert.equal(value.charCodeAt(0), 0x61);
  assert.equal(value.charCodeAt(1), 0x0000);
  assert.equal(value.charCodeAt(2), 0x62);
});

test("encodeJavaNbt encodes U+0000 inside a string as MUTF-8 (C0 80)", () => {
  const doc: TypedNbtDocument = {
    rootName: "R",
    root: {
      type: "compound",
      value: {
        k: { type: "string", value: "a\u0000b" }
      }
    }
  };
  const buffer = encodeJavaNbt(doc);
  const hex = buffer.toString("hex");
  assert.ok(/61c08062/.test(hex), `encoded NUL must serialize to C0 80 between 'a' and 'b', hex=${hex}`);
});

test("encodeJavaNbt/decodeJavaNbt round-trip preserves a supplementary-character emoji (U+1F600)", () => {
  const doc: TypedNbtDocument = {
    rootName: "R",
    root: {
      type: "compound",
      value: {
        emoji: { type: "string", value: "😀" }
      }
    }
  };
  const buffer = encodeJavaNbt(doc);
  const decoded = decodeJavaNbt(buffer);
  const value = (decoded.root as any).value.emoji.value as string;
  assert.equal(value, "😀");
  assert.equal(value.length, 2);
});

test("decodeJavaNbt decodes a Java-style surrogate pair fixture (ED A0 BD ED B8 80) as U+1F600", () => {
  const bytes = Buffer.from([
    0x0a, 0x00, 0x01, 0x52,
    0x08, 0x00, 0x01, 0x6b,
    0x00, 0x06,
    0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80,
    0x00
  ]);
  const decoded = decodeJavaNbt(bytes);
  const value = (decoded.root as any).value.k.value as string;
  assert.equal(value, "😀");
});

test("encodeJavaNbt ASCII strings still produce identical bytes to UTF-8 (regression guard)", () => {
  const doc: TypedNbtDocument = {
    rootName: "R",
    root: {
      type: "compound",
      value: {
        k: { type: "string", value: "hello world" }
      }
    }
  };
  const buffer = encodeJavaNbt(doc);
  assert.ok(buffer.includes(Buffer.from("hello world", "utf8")));
});

test("encodeJavaNbt common BMP CJK strings still produce identical bytes to UTF-8 (regression guard)", () => {
  const doc: TypedNbtDocument = {
    rootName: "R",
    root: {
      type: "compound",
      value: {
        k: { type: "string", value: "日本語" }
      }
    }
  };
  const buffer = encodeJavaNbt(doc);
  assert.ok(buffer.includes(Buffer.from("日本語", "utf8")));
});

test("decodeJavaNbt rejects a MUTF-8 string with an invalid continuation byte", () => {
  // root compound (empty name) -> string "s" with value bytes [0xC2, 0x41].
  // 0xC2 is a 2-byte lead, but 0x41 ('A') is not a continuation byte.
  const bytes = Buffer.from("0a000008000173" + "0002" + "c241" + "00", "hex");
  assert.throws(
    () => decodeJavaNbt(bytes),
    (error: unknown) => (error as { code?: string }).code === ERROR_CODES.NBT_PARSE_FAILED
  );
});

test("decodeJavaNbt still accepts the overlong C0 80 form for NUL", () => {
  // Java MUTF-8 encodes U+0000 as the overlong two-byte sequence 0xC0 0x80.
  const bytes = Buffer.from("0a000008000173" + "0002" + "c080" + "00", "hex");
  const decoded = decodeJavaNbt(bytes);
  assert.deepEqual(decoded, {
    rootName: "",
    root: { type: "compound", value: { s: { type: "string", value: "\u0000" } } }
  });
});
