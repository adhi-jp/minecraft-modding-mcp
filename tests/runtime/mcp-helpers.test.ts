import assert from "node:assert/strict";
import test from "node:test";

import { objectResult, textResource, objectResource, errorResource } from "../../src/mcp-helpers.ts";
import { ERROR_CODES } from "../../src/errors.ts";

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
  // Resource-side parity for the breaking retryClass change: an internal fault
  // is a non-recoverable server fault here too, not transient.
  assert.equal(parsed.error.retryClass, "server");
  assert.equal(parsed.error.issueOrigin, "tool_issue");
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

test("errorResource carries retryClass + issueOrigin for a coded AppError", () => {
  const entry = errorResource("mc://x", {
    message: "gone",
    code: ERROR_CODES.CLASS_NOT_FOUND
  }).contents[0]!;
  const parsed = JSON.parse(entry.text!);
  assert.equal(parsed.error.retryClass, "permanent");
  assert.equal(parsed.error.issueOrigin, "code_issue");
});

test("errorResource(string detail) carries the input/code_issue classifiers", () => {
  const parsed = JSON.parse(errorResource("mc://x", "bad path").contents[0]!.text!);
  assert.equal(parsed.error.retryClass, "input");
  assert.equal(parsed.error.issueOrigin, "code_issue");
  // String form has no details, so no recovery fields are added.
  assert.equal("hints" in parsed.error, false);
  assert.equal("suggestedCall" in parsed.error, false);
  assert.equal("context" in parsed.error, false);
});

test("errorResource extracts hints/suggestedCall/context from AppError details", () => {
  const entry = errorResource("mc://x", {
    message: "m",
    code: ERROR_CODES.CLASS_NOT_FOUND,
    details: {
      nextAction: "Call resolve-artifact first.",
      suggestedCall: {
        tool: "get-class-source",
        params: {
          target: { kind: "version", value: "1.21.10" },
          className: "net.minecraft.Foo"
        }
      },
      artifactId: "a1"
    }
  }).contents[0]!;
  const parsed = JSON.parse(entry.text!);
  assert.deepEqual(parsed.error.hints, ["Call resolve-artifact first."]);
  assert.equal(parsed.error.suggestedCall.tool, "get-class-source");
  assert.equal(parsed.error.context.artifactId, "a1");
});

test("errorResource drops a placeholder-only suggestedCall via the shared validation gate", () => {
  const entry = errorResource("mc://x", {
    message: "m",
    code: ERROR_CODES.CLASS_NOT_FOUND,
    details: {
      suggestedCall: {
        tool: "get-class-source",
        params: { className: "<fill-in>", target: "<fill-in>" }
      }
    }
  }).contents[0]!;
  const parsed = JSON.parse(entry.text!);
  // The placeholder primary fails schema validation, so no suggestedCall is emitted.
  assert.equal("suggestedCall" in parsed.error, false);
});

test("errorResource forwards validated exampleCalls from AppError details", () => {
  const entry = errorResource("mc://x", {
    message: "ambiguous",
    code: ERROR_CODES.CLASS_NOT_FOUND,
    details: {
      exampleCalls: [
        {
          tool: "get-class-source",
          params: {
            target: { kind: "version", value: "1.21.10" },
            className: "net.minecraft.world.entity.LivingEntity"
          },
          reason: "Fetch the resolved class source."
        }
      ]
    }
  }).contents[0]!;
  const parsed = JSON.parse(entry.text!);
  assert.equal(Array.isArray(parsed.error.exampleCalls), true);
  assert.equal(parsed.error.exampleCalls.length, 1);
  assert.equal(parsed.error.exampleCalls[0].tool, "get-class-source");
  assert.equal(parsed.error.exampleCalls[0].reason, "Fetch the resolved class source.");
});

test("errorResource honours a per-throw-site issueOrigin override from AppError details", () => {
  // An mc:// resource read publishes the same AppError as the equivalent tool
  // call, so a throw site that classified itself as a tool-side gap must not be
  // re-labelled caller-fixable just because the caller used a resource URI.
  const parsed = JSON.parse(
    errorResource("mc://classes/net.example.Foo", {
      message: 'artifact "minecraft-1.21.10" has no binary jar',
      code: ERROR_CODES.CONTEXT_UNRESOLVED,
      details: { artifactId: "minecraft-1.21.10", issueOrigin: "tool_issue" }
    }).contents[0]!.text!
  );
  assert.equal(parsed.error.issueOrigin, "tool_issue");
  // retryClass has no override seam and stays code-derived.
  assert.equal(parsed.error.retryClass, "input");
});

test("errorResource keeps the issueOrigin override out of the published context blob", () => {
  // `issueOrigin` is a classification input, not repair context: it is absent
  // from CONTEXT_ALLOWLIST and must never be echoed back inside `context`.
  const parsed = JSON.parse(
    errorResource("mc://classes/net.example.Foo", {
      message: "no binary jar",
      code: ERROR_CODES.CONTEXT_UNRESOLVED,
      details: { artifactId: "minecraft-1.21.10", issueOrigin: "tool_issue" }
    }).contents[0]!.text!
  );
  assert.deepEqual(parsed.error.context, { artifactId: "minecraft-1.21.10" });
  assert.equal("issueOrigin" in parsed.error.context, false);
});
