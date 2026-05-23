import assert from "node:assert/strict";
import test from "node:test";

import { objectResult, textResource, objectResource, errorResource } from "../src/mcp-helpers.ts";
import { ERROR_CODES } from "../src/errors.ts";

test("objectResult mirrors JSON envelopes into structuredContent", () => {
  const payload = {
    result: {
      ok: true
    },
    meta: {
      requestId: "req-1",
      tool: "demo",
      durationMs: 1,
      warnings: []
    }
  };

  const result = objectResult(payload);

  assert.deepEqual(result.structuredContent, payload);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(payload) }]);
});

test("objectResult marks MCP errors with isError", () => {
  const payload = {
    error: {
      code: "ERR_INVALID_INPUT",
      detail: "bad input"
    },
    meta: {
      requestId: "req-2",
      tool: "demo",
      durationMs: 2,
      warnings: []
    }
  };

  const result = objectResult(payload, { isError: true });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, payload);
});

test("objectResult omits the isError key entirely when options.isError is falsy or absent", () => {
  const payload = { result: { ok: true }, meta: {} };
  const noOpts = objectResult(payload);
  const explicitFalse = objectResult(payload, { isError: false });
  assert.ok(!("isError" in noOpts), "no isError key when options omitted");
  assert.ok(!("isError" in explicitFalse), "no isError key when isError:false");
});

test("objectResult content[0] is a single text block whose text JSON-parses back to structuredContent", () => {
  const payload = { result: { ok: true, items: [1, 2] }, meta: {} };
  const out = objectResult(payload);
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0]!.type, "text");
  assert.equal(typeof out.content[0]!.text, "string");
  const parsed = JSON.parse(out.content[0]!.text);
  assert.deepEqual(parsed, payload);
});

test("objectResult preserves Unicode/emoji round-trip through JSON.stringify", () => {
  const payload = { result: { text: "café 🦊 日本語" }, meta: {} };
  const parsed = JSON.parse(objectResult(payload).content[0]!.text);
  assert.equal(parsed.result.text, "café 🦊 日本語");
});

test("textResource returns the canonical { contents: [{ uri, text }] } shape", () => {
  assert.deepEqual(textResource("mc://x", "hello"), {
    contents: [{ uri: "mc://x", text: "hello" }]
  });
});

test("objectResource wraps payload with mimeType application/json and meta.uri", () => {
  const data = { items: [1, 2, 3] };
  const result = objectResource("mc://artifacts/abc", data);
  assert.equal(result.contents.length, 1);
  const entry = result.contents[0]!;
  assert.equal(entry.uri, "mc://artifacts/abc");
  assert.equal(entry.mimeType, "application/json");
  assert.deepEqual(JSON.parse(entry.text!), {
    result: data,
    meta: { uri: "mc://artifacts/abc" }
  });
});

test("objectResource handles empty payload with result === {}", () => {
  const entry = objectResource("mc://empty", {}).contents[0]!;
  const parsed = JSON.parse(entry.text!);
  assert.deepEqual(parsed.result, {});
  assert.equal(parsed.meta.uri, "mc://empty");
});

test("errorResource(string detail) defaults to ERR_INVALID_INPUT with status 400", () => {
  const entry = errorResource("mc://x", "bad path").contents[0]!;
  const parsed = JSON.parse(entry.text!);
  assert.equal(entry.mimeType, "application/json");
  assert.equal(parsed.error.code, ERROR_CODES.INVALID_INPUT);
  assert.equal(parsed.error.status, 400);
  assert.equal(parsed.error.detail, "bad path");
  assert.equal(parsed.error.instance, "mc://x");
  assert.equal(parsed.error.type, "https://minecraft-modding-mcp.dev/problems/resource");
  assert.equal(parsed.error.title, "Resource read failed");
  assert.equal(parsed.meta.uri, "mc://x");
});

test("errorResource falls back to ERR_INTERNAL + status 500 when error.code is undefined", () => {
  const entry = errorResource("mc://x", { message: "boom" }).contents[0]!;
  const parsed = JSON.parse(entry.text!);
  assert.equal(parsed.error.code, ERROR_CODES.INTERNAL);
  assert.equal(parsed.error.status, 500);
  assert.equal(parsed.error.detail, "boom");
});

test("errorResource maps ErrorCode values to documented status (404 / 422 / 400 / 500)", () => {
  const cases: Array<{ code: any; status: number }> = [
    { code: ERROR_CODES.FILE_NOT_FOUND, status: 404 },
    { code: ERROR_CODES.SOURCE_NOT_FOUND, status: 404 },
    { code: ERROR_CODES.CLASS_NOT_FOUND, status: 404 },
    { code: ERROR_CODES.VERSION_NOT_FOUND, status: 404 },
    { code: ERROR_CODES.JAR_NOT_FOUND, status: 404 },
    { code: ERROR_CODES.MAPPING_UNAVAILABLE, status: 422 },
    { code: ERROR_CODES.MAPPING_NOT_APPLIED, status: 422 },
    { code: ERROR_CODES.NAMESPACE_MISMATCH, status: 422 },
    { code: ERROR_CODES.INVALID_INPUT, status: 400 },
    { code: ERROR_CODES.INTERNAL, status: 500 }
  ];
  for (const { code, status } of cases) {
    const parsed = JSON.parse(errorResource("mc://x", { message: "x", code }).contents[0]!.text!);
    assert.equal(parsed.error.code, code);
    assert.equal(parsed.error.status, status, `expected ${code} -> ${status}, got ${parsed.error.status}`);
  }
});
