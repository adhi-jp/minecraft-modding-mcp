/**
 * NBT family (nbt-decode, nbt-encode, nbt-patch) through the in-process MCP
 * session that serves the catalog and the 8.x tools side by side. Every 8.x
 * counterpart runs on the same payloads through the same session.
 *
 * Fixtures are built in memory the way tests/nbt builds them: a known Java
 * NBT payload (compound "R" holding the int `answer` = 42), its gzip form,
 * and typed documents covering every node type. The NBT input limit is set
 * low (MCP_MAX_NBT_INPUT_BYTES) so the configured limit, not the built-in
 * default, is shown to apply.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { gzipSync } from "node:zlib";

import { applyNbtJsonPatch } from "../../src/nbt/pipeline.ts";
import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { NBT_TOOL_SPECS } from "../../src/tools/families/nbt.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-nbt-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
const INPUT_LIMIT = 4096;
process.env.MCP_MAX_NBT_INPUT_BYTES = String(INPUT_LIMIT);

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

/** Compound "R" holding the int `answer` = 42 (the payload tests/nbt decodes). */
const PAYLOAD = Buffer.from("0a000152030006616e737765720000002a00", "hex");
const PAYLOAD_BASE64 = PAYLOAD.toString("base64");
const GZIP_BASE64 = gzipSync(PAYLOAD).toString("base64");

const SMALL_DOCUMENT = {
  rootName: "R",
  root: { type: "compound", value: { answer: { type: "int", value: 42 } } }
};

/** Every node type, as the codec round-trip tests build it. */
const LEVEL_DOCUMENT = {
  rootName: "Level",
  root: {
    type: "compound",
    value: {
      b: { type: "byte", value: -12 },
      s: { type: "short", value: 1234 },
      i: { type: "int", value: -123456 },
      l: { type: "long", value: "-9223372036854775808" },
      f: { type: "float", value: 1.5 },
      d: { type: "double", value: "NaN" },
      text: { type: "string", value: "hello" },
      bytes: { type: "byteArray", value: [1, -2, 3] },
      ints: { type: "intArray", value: [10, 20, -30] },
      longs: { type: "longArray", value: ["1", "-2", "3"] },
      empty: { type: "list", elementType: "end", value: [] },
      list: {
        type: "list",
        elementType: "compound",
        value: [{ type: "compound", value: { name: { type: "string", value: "first" } } }]
      }
    }
  }
};

type Envelope = {
  result?: Record<string, any>;
  error?: Record<string, any> & { fieldErrors?: Array<Record<string, any>> };
  meta: Record<string, any> & {
    warnings?: Array<{ code: string; severity: string; message: string }>;
    nextActions?: Array<{ tool: string; params: Record<string, any>; reason?: string; template?: true }>;
  };
};

let session: CatalogSession;

before(async () => {
  session = await startCatalogSession(CATALOG_TOOL_SPECS);
});

after(async () => {
  await session.close();
});

function envelopeOf(frame: SessionFrame): { envelope: Envelope; isError: boolean; text: string } {
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const result = frame.result as { content: Array<{ text: string }>; structuredContent: Envelope; isError?: boolean };
  return { envelope: result.structuredContent, isError: result.isError === true, text: result.content[0]!.text };
}

/**
 * Calls a catalog tool. Every reply names the catalog tool (positive control)
 * and no 8.x tool, carries no internal fallback sentence and publishes only
 * executable next actions for catalog tools or flagged templates.
 */
async function catalog(name: string, args: unknown) {
  const reply = envelopeOf(await session.callTool(name, args));
  assert.equal(reply.envelope.meta.tool, name);
  assert.ok(reply.text.includes(`"${name}"`), "positive control: the catalog tool name is in the reply");
  assert.doesNotMatch(reply.text, ALIAS_NAME_PATTERN, `no 8.x tool name in the ${name} reply: ${reply.text}`);
  assert.equal(reply.text.includes(FALLBACK_SENTENCE), false);
  for (const action of reply.envelope.meta.nextActions ?? []) {
    assert.ok(CATALOG_TOOL_SPECS.some((spec) => spec.name === action.tool), `${action.tool} is a catalog tool`);
    if (action.template !== true) {
      assert.deepEqual(finalizeNextActions([action]), [action], `next action ${JSON.stringify(action)} validates`);
    }
  }
  return reply;
}

async function eightX(name: string, args: unknown) {
  return envelopeOf(await session.callTool(name, args));
}

function assertSameFailure(actual: Envelope["error"], expected: Envelope["error"], label: string): void {
  assert.ok(expected, `${label}: the 8.x tool fails`);
  for (const key of ["code", "retryClass", "issueOrigin", "detail"]) {
    assert.deepEqual(actual?.[key], expected?.[key], `${label}: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// nbt-decode
// ---------------------------------------------------------------------------

test("nbt-decode matches nbt-to-json on uncompressed and gzip payloads for every compression mode", async () => {
  const cases: Array<[string, string, "none" | "gzip" | "auto" | undefined, "none" | "gzip"]> = [
    ["uncompressed, default auto", PAYLOAD_BASE64, undefined, "none"],
    ["uncompressed, none", PAYLOAD_BASE64, "none", "none"],
    ["gzip, default auto", GZIP_BASE64, undefined, "gzip"],
    ["gzip, gzip", GZIP_BASE64, "gzip", "gzip"]
  ];
  for (const [label, nbtBase64, compression, detected] of cases) {
    const request = { nbtBase64, ...(compression !== undefined ? { compression } : {}) };
    const legacy = (await eightX("nbt-to-json", request)).envelope;
    assert.equal(legacy.error, undefined, `${label}: the 8.x tool decodes the payload`);
    const { envelope, isError } = await catalog("nbt-decode", request);
    assert.equal(isError, false, JSON.stringify(envelope.error));
    assert.deepEqual(
      envelope.result,
      {
        typedJson: legacy.result!.typedJson,
        compressionDetected: legacy.meta.compressionDetected,
        inputBytes: legacy.meta.inputBytes
      },
      `${label}: the same document and counters`
    );
    assert.deepEqual(envelope.result!.typedJson, SMALL_DOCUMENT, `${label}: positive control: the known document`);
    assert.equal(envelope.result!.compressionDetected, detected);
    assert.equal(envelope.meta.warnings, undefined);
  }
});

test("nbt-decode fails like nbt-to-json on invalid base64, a malformed stream and a payload over the configured limit", async () => {
  const oversized = Buffer.alloc(INPUT_LIMIT + 4, 0).toString("base64");
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["invalid base64", { nbtBase64: "not base64!" }, "ERR_INVALID_INPUT"],
    ["truncated stream", { nbtBase64: PAYLOAD.subarray(0, 8).toString("base64") }, "ERR_NBT_PARSE_FAILED"],
    ["gzip forced on plain bytes", { nbtBase64: PAYLOAD_BASE64, compression: "gzip" }, "ERR_NBT_PARSE_FAILED"],
    ["over MCP_MAX_NBT_INPUT_BYTES", { nbtBase64: oversized }, "ERR_LIMIT_EXCEEDED"]
  ];
  for (const [label, request, code] of cases) {
    const legacy = (await eightX("nbt-to-json", request)).envelope.error;
    const { envelope, isError } = await catalog("nbt-decode", request);
    assert.equal(isError, true, label);
    assertSameFailure(envelope.error, legacy, label);
    assert.equal(envelope.error?.code, code, `${label}: positive control`);
    assert.deepEqual(envelope.error?.hints, legacy?.hints, `${label}: the same hints`);
  }
});

// ---------------------------------------------------------------------------
// nbt-encode
// ---------------------------------------------------------------------------

test("nbt-encode matches json-to-nbt with and without gzip, and nbt-decode reads its output back", async () => {
  for (const compression of [undefined, "none", "gzip"] as const) {
    for (const typedJson of [SMALL_DOCUMENT, LEVEL_DOCUMENT]) {
      const request = { typedJson, ...(compression !== undefined ? { compression } : {}) };
      const legacy = (await eightX("json-to-nbt", request)).envelope;
      assert.equal(legacy.error, undefined, JSON.stringify(legacy.error));
      const { envelope, isError } = await catalog("nbt-encode", request);
      assert.equal(isError, false, JSON.stringify(envelope.error));
      assert.deepEqual(envelope.result, {
        nbtBase64: legacy.result!.nbtBase64,
        outputBytes: legacy.meta.outputBytes,
        compressionApplied: legacy.meta.compressionApplied
      });
      assert.equal(envelope.result!.compressionApplied, compression ?? "none", "the default is none");
      const decoded = await catalog("nbt-decode", { nbtBase64: envelope.result!.nbtBase64 });
      assert.deepEqual(decoded.envelope.result!.typedJson, typedJson, "the document round-trips");
      assert.equal(decoded.envelope.result!.compressionDetected, compression ?? "none");
    }
  }
  const plain = await catalog("nbt-encode", { typedJson: SMALL_DOCUMENT });
  assert.equal(plain.envelope.result!.nbtBase64, PAYLOAD_BASE64, "positive control: the known payload's bytes");
});

test("nbt-encode reports a malformed document like json-to-nbt and offers an nbt-decode template", async () => {
  const malformed = {
    rootName: "R",
    root: { type: "compound", value: { answer: { type: "int", value: "forty-two" } } }
  };
  const legacy = (await eightX("json-to-nbt", { typedJson: malformed })).envelope;
  assert.ok(legacy.error?.exampleCalls?.length, "positive control: the 8.x reply suggests a decode in exampleCalls");
  const { envelope, isError, text } = await catalog("nbt-encode", { typedJson: malformed });
  assert.equal(isError, true);
  assertSameFailure(envelope.error, legacy.error, "malformed document");
  assert.equal(envelope.error?.code, "ERR_NBT_INVALID_TYPED_JSON");
  assert.deepEqual(envelope.error?.fieldErrors, legacy.error?.fieldErrors, "the node is named the same way");
  assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), ["/root/value/answer/value"]);
  assert.equal("exampleCalls" in envelope.error!, false, "recovery calls are next actions");
  assert.deepEqual(envelope.meta.nextActions, [
    {
      tool: "nbt-decode",
      params: { nbtBase64: "<base64-encoded-nbt-payload>" },
      reason:
        "Decode a real NBT payload with nbt-decode to obtain a well-formed typedJson document, edit that, then retry nbt-encode with it.",
      template: true
    }
  ]);
  assert.ok(text.includes("nbt-decode"));
});

test("nbt-encode requires typedJson and rejects a compression it cannot write", async () => {
  const missing = await catalog("nbt-encode", { compression: "gzip" });
  assert.equal(missing.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(missing.envelope.error?.fieldErrors?.map((entry) => entry.path), ["typedJson"]);
  const auto = await catalog("nbt-encode", { typedJson: SMALL_DOCUMENT, compression: "auto" });
  assert.deepEqual(auto.envelope.error?.fieldErrors?.map((entry) => entry.path), ["compression"]);
  const notAnObject = await catalog("nbt-encode", { typedJson: "R" });
  assert.equal(notAnObject.envelope.error?.code, "ERR_NBT_INVALID_TYPED_JSON", "the document format rejects it, not the schema");
});

// ---------------------------------------------------------------------------
// nbt-patch
// ---------------------------------------------------------------------------

test("nbt-patch matches nbt-apply-json-patch for add, replace, remove and test operations", async () => {
  const patch = [
    { op: "test", path: "/root/value/answer", value: { type: "int", value: 42 } },
    { op: "add", path: "/root/value/name", value: { type: "string", value: "Alex" } },
    { op: "replace", path: "/root/value/answer/value", value: 7 },
    { op: "add", path: "/root/value/tags", value: { type: "list", elementType: "string", value: [] } },
    { op: "add", path: "/root/value/tags/value/-", value: { type: "string", value: "a" } },
    { op: "remove", path: "/root/value/name" },
    { op: "test", path: "/rootName", value: "R" }
  ];
  const request = { typedJson: SMALL_DOCUMENT, patch };
  const legacy = (await eightX("nbt-apply-json-patch", request)).envelope;
  assert.equal(legacy.error, undefined, JSON.stringify(legacy.error));
  const { envelope, isError } = await catalog("nbt-patch", request);
  assert.equal(isError, false, JSON.stringify(envelope.error));
  assert.deepEqual(envelope.result, {
    typedJson: legacy.result!.typedJson,
    appliedOps: legacy.meta.appliedOps,
    testOps: legacy.meta.testOps,
    changed: legacy.meta.changed
  });
  assert.deepEqual(envelope.result!.typedJson.root.value, {
    answer: { type: "int", value: 7 },
    tags: { type: "list", elementType: "string", value: [{ type: "string", value: "a" }] }
  });
  assert.deepEqual([envelope.result!.appliedOps, envelope.result!.testOps, envelope.result!.changed], [7, 2, true]);

  const onlyTests = await catalog("nbt-patch", { typedJson: SMALL_DOCUMENT, patch: [patch[0]] });
  assert.deepEqual(
    [onlyTests.envelope.result!.appliedOps, onlyTests.envelope.result!.testOps, onlyTests.envelope.result!.changed],
    [1, 1, false]
  );
  assert.deepEqual(onlyTests.envelope.result!.typedJson, SMALL_DOCUMENT);
});

test("nbt-patch replaces the whole document at the root pointer, which nbt-apply-json-patch rejects", async () => {
  const patch = [{ op: "replace", path: "", value: LEVEL_DOCUMENT }];
  const { envelope, isError } = await catalog("nbt-patch", { typedJson: SMALL_DOCUMENT, patch });
  assert.equal(isError, false, JSON.stringify(envelope.error));
  const service = applyNbtJsonPatch({ typedJson: SMALL_DOCUMENT, patch });
  assert.deepEqual(envelope.result, { typedJson: service.typedJson, ...service.meta }, "the service's own answer");
  assert.deepEqual(envelope.result!.typedJson, LEVEL_DOCUMENT);

  const legacy = (await eightX("nbt-apply-json-patch", { typedJson: SMALL_DOCUMENT, patch })).envelope.error;
  assert.equal(legacy?.code, "ERR_INVALID_INPUT", "the 8.x schema requires a non-empty path");

  const invalidRoot = await catalog("nbt-patch", { typedJson: SMALL_DOCUMENT, patch: [{ op: "replace", path: "", value: { rootName: 1 } }] });
  assert.equal(invalidRoot.envelope.error?.code, "ERR_JSON_PATCH_CONFLICT", "a root replace must still leave valid typed NBT");
});

test("nbt-patch uses a path as given, where nbt-apply-json-patch trimmed surrounding spaces", async () => {
  const patch = [{ op: "replace", path: " /root/value/answer/value ", value: 7 }];
  const legacy = (await eightX("nbt-apply-json-patch", { typedJson: SMALL_DOCUMENT, patch })).envelope;
  assert.equal(legacy.result?.typedJson.root.value.answer.value, 7, "positive control: the 8.x schema trimmed the path");
  const { envelope } = await catalog("nbt-patch", { typedJson: SMALL_DOCUMENT, patch });
  assert.equal(envelope.error?.code, "ERR_JSON_PATCH_INVALID");
  const trimmed = await catalog("nbt-patch", { typedJson: SMALL_DOCUMENT, patch: [{ ...patch[0]!, path: "/root/value/answer/value" }] });
  assert.equal(trimmed.envelope.result?.typedJson.root.value.answer.value, 7);
});

test("nbt-patch fails like nbt-apply-json-patch on a failing test operation and on an invalid result", async () => {
  const cases: Array<[string, unknown[], string]> = [
    ["failing test", [{ op: "test", path: "/root/value/answer/value", value: 41 }], "ERR_JSON_PATCH_CONFLICT"],
    ["missing path", [{ op: "remove", path: "/root/value/missing" }], "ERR_JSON_PATCH_CONFLICT"],
    ["untyped value", [{ op: "replace", path: "/root/value/answer", value: 7 }], "ERR_JSON_PATCH_CONFLICT"],
    ["bad pointer", [{ op: "remove", path: "root" }], "ERR_JSON_PATCH_INVALID"],
    ["add without value", [{ op: "add", path: "/root/value/x" }], "ERR_JSON_PATCH_INVALID"]
  ];
  for (const [label, patch, code] of cases) {
    const request = { typedJson: SMALL_DOCUMENT, patch };
    const legacy = (await eightX("nbt-apply-json-patch", request)).envelope;
    const { envelope, isError } = await catalog("nbt-patch", request);
    assert.equal(isError, true, label);
    assertSameFailure(envelope.error, legacy.error, label);
    assert.equal(envelope.error?.code, code, `${label}: positive control`);
  }
  const conflict = await catalog("nbt-patch", {
    typedJson: SMALL_DOCUMENT,
    patch: [{ op: "test", path: "/root/value/answer/value", value: 41 }]
  });
  assert.deepEqual(conflict.envelope.error?.hints, [
    "The document did not hold what the patch expected at that path. Re-read the current document with nbt-decode and rebuild the patch against it."
  ]);
});

test("nbt-patch reports a malformed input document with an nbt-decode template naming nbt-patch", async () => {
  const { envelope } = await catalog("nbt-patch", {
    typedJson: { rootName: "R", root: { type: "int", value: 1.5 } },
    patch: [{ op: "test", path: "/rootName", value: "R" }]
  });
  assert.equal(envelope.error?.code, "ERR_NBT_INVALID_TYPED_JSON");
  assert.equal(envelope.meta.nextActions?.length, 1);
  assert.equal(envelope.meta.nextActions![0]!.tool, "nbt-decode");
  assert.equal(envelope.meta.nextActions![0]!.template, true);
  assert.match(envelope.meta.nextActions![0]!.reason!, /then retry nbt-patch with it\.$/);
});

// ---------------------------------------------------------------------------
// Data documents and strict input
// ---------------------------------------------------------------------------

test("members inside typedJson and inside patch operations are data, not control keys", async () => {
  const annotated = {
    ...SMALL_DOCUMENT,
    comment: "kept out of the bytes",
    root: { ...SMALL_DOCUMENT.root, note: "ignored by the format" }
  };
  const encoded = await catalog("nbt-encode", { typedJson: annotated });
  assert.equal(encoded.isError, false, "an extra document member is not a schema error");
  assert.equal(encoded.envelope.result!.nbtBase64, PAYLOAD_BASE64, "the format ignores members it does not define");

  const patched = await catalog("nbt-patch", {
    typedJson: SMALL_DOCUMENT,
    patch: [{ op: "replace", path: "/root/value/answer/value", value: 1, from: "/ignored", comment: "RFC 6902 ignores it" }]
  });
  assert.equal(patched.isError, false, "an extra operation member is not a schema error");
  assert.equal(patched.envelope.result!.typedJson.root.value.answer.value, 1);

  for (const [name, request] of [
    ["nbt-encode", { typedJson: SMALL_DOCUMENT, bogusKey: 1 }],
    ["nbt-patch", { typedJson: SMALL_DOCUMENT, patch: [{ op: "test", path: "", value: SMALL_DOCUMENT }], bogusKey: 1 }]
  ] as const) {
    const reply = await catalog(name, request);
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", `${name}: an unknown top-level key is a control key`);
    assert.deepEqual(reply.envelope.error?.fieldErrors?.map((entry) => entry.path), ["bogusKey"]);
  }
});

test("nbt-patch rejects an empty patch and operations the format does not have", async () => {
  const empty = await catalog("nbt-patch", { typedJson: SMALL_DOCUMENT, patch: [] });
  assert.deepEqual(empty.envelope.error?.fieldErrors?.map((entry) => entry.path), ["patch"]);
  for (const op of ["move", "copy"]) {
    const reply = await catalog("nbt-patch", { typedJson: SMALL_DOCUMENT, patch: [{ op, from: "/a", path: "/b" }] });
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", op);
    assert.deepEqual(reply.envelope.error?.fieldErrors?.map((entry) => entry.path), ["patch.0.op"]);
  }
});

test("every NBT tool validates its examples and rejects unknown and misspelled keys", async () => {
  const nearMisses: Record<string, [string, string]> = {
    "nbt-decode": ["compresion", "compression"],
    "nbt-encode": ["typedJsn", "typedJson"],
    "nbt-patch": ["patches", "patch"]
  };
  for (const spec of NBT_TOOL_SPECS) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
      const reply = await catalog(spec.name, example);
      assert.equal(reply.isError, false, `${spec.name} example runs: ${JSON.stringify(reply.envelope.error)}`);
    }
    const example = spec.examples[0]! as Record<string, unknown>;

    const unknownTop = await catalog(spec.name, { ...example, bogusKey: 1 });
    assert.equal(unknownTop.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(unknownTop.envelope.error?.fieldErrors?.map((entry) => entry.path), ["bogusKey"], spec.name);

    const [misspelled, declared] = nearMisses[spec.name]!;
    const { [declared]: value, ...rest } = example;
    const nearMiss = await catalog(spec.name, { ...rest, [misspelled]: value ?? "gzip" });
    assert.equal(nearMiss.envelope.error?.code, "ERR_INVALID_INPUT");
    const entry = nearMiss.envelope.error?.fieldErrors?.find((fieldError) => fieldError.path === misspelled);
    assert.ok(entry?.suggestions?.includes(declared), `${spec.name}: "${misspelled}" suggests "${declared}"`);
  }
});

test("the NBT tools are listed as read-only, closed-world tools", async () => {
  const names = new Set(NBT_TOOL_SPECS.map((spec) => spec.name));
  const listed = (await session.listTools()).filter((tool) => names.has(tool.name));
  assert.deepEqual(listed.map((tool) => tool.name).sort(), ["nbt-decode", "nbt-encode", "nbt-patch"]);
  for (const tool of listed) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false }, tool.name);
    const schema = tool.inputSchema as { additionalProperties?: unknown; properties: Record<string, any> };
    assert.equal(schema.additionalProperties, false, `${tool.name}: the top level is a closed control object`);
    if (schema.properties.typedJson !== undefined) {
      assert.equal(schema.properties.typedJson.additionalProperties, undefined, `${tool.name}: typedJson stays open`);
    }
  }
  const patchItems = (listed.find((tool) => tool.name === "nbt-patch")!.inputSchema as any).properties.patch.items;
  assert.notEqual(patchItems.additionalProperties, false, "a patch operation stays open, as RFC 6902 asks");
  assert.deepEqual(patchItems.required, ["op", "path"]);
});
