/**
 * access-validate and mixin-verify-target through the in-process MCP session
 * that serves the catalog and the 8.x tools side by side. Every 8.x
 * counterpart runs on the same fixtures through the same session; only the
 * I/O boundaries are stubbed (every other URL is a 404; nothing reaches the
 * network and no Java process runs).
 *
 * Fixtures:
 *  - a stubbed Mojang manifest naming client jars built from class files:
 *    1.21.10 (obfuscated names) and 26.1 (an unobfuscated runtime); both hold
 *    `a.b.C` with the private field `d`, the overloads `m()` (public) and
 *    `m(I)` (private), `e(I)`, and the private overloads `f(I)` and
 *    `f(String)`; access widener and transformer files and
 *    texts that check entries against them, as the service-level access
 *    widener and transformer tests do;
 *  - a library jar with an adjacent sources jar holding the same `a.b.C`, so
 *    a `jar` target resolves without decompiling (mixin-verify-target parity);
 *  - the Mojang client mappings of the mapping-service tests
 *    (`TEST_MOJANG_CLIENT_MAPPINGS`) for 1.21.10, so names translate through
 *    the real mapping service of a separate source service;
 *  - for the outcomes the fixtures cannot produce (another version's runtime
 *    jar, names in another namespace than the artifact's, a version target,
 *    per-class mapping outcomes), the tools run on stubbed services through
 *    `runCatalogTool`, as the verify-mixin-target and access widener service
 *    tests stub their dependencies.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { SourceService } from "../../src/source-service.ts";
import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import {
  accessValidateSpec,
  catalogServiceText,
  mixinVerifyTargetSpec
} from "../../src/tools/families/validation.ts";
import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import type { CatalogServices, CatalogToolSpec } from "../../src/tools/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withEnv } from "../helpers/env.ts";
import { TEST_MOJANG_CLIENT_MAPPINGS } from "../helpers/mapping-service-fixtures.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-access-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";
process.env.GRADLE_USER_HOME = join(root, "gradle-home");

const MANIFEST_URL = "https://manifest.test/version_manifest_v2.json";
process.env.MCP_VERSION_MANIFEST_URL = MANIFEST_URL;
const OBF_VERSION = "1.21.10";
const MOJ_VERSION = "26.1";
const VERSIONS = [OBF_VERSION, MOJ_VERSION];
const clientJars = new Map<string, Buffer>();

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === MANIFEST_URL) {
    return new Response(
      JSON.stringify({
        latest: { release: MOJ_VERSION, snapshot: MOJ_VERSION },
        versions: VERSIONS.map((id) => ({ id, type: "release", url: `https://manifest.test/versions/${id}.json` }))
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const versionDocument = /^https:\/\/manifest\.test\/versions\/(.+)\.json$/.exec(url);
  if (versionDocument !== null && VERSIONS.includes(versionDocument[1]!)) {
    const id = versionDocument[1]!;
    return new Response(
      JSON.stringify({
        id,
        downloads: {
          client: { url: `https://manifest.test/jars/${id}.jar` },
          ...(id === OBF_VERSION ? { client_mappings: { url: `https://manifest.test/mappings/${id}.txt` } } : {})
        },
        libraries: []
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const jar = /^https:\/\/manifest\.test\/jars\/(.+)\.jar$/.exec(url);
  if (jar !== null && clientJars.has(jar[1]!)) {
    return new Response(clientJars.get(jar[1]!), { status: 200 });
  }
  if (url === `https://manifest.test/mappings/${OBF_VERSION}.txt`) {
    return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const CLASS_C = {
  internalName: "a/b/C",
  fields: [{ name: "d", descriptor: "I", accessFlags: 0x0002 }],
  methods: [
    { name: "m", descriptor: "()V", accessFlags: 0x0001 },
    { name: "m", descriptor: "(I)V", accessFlags: 0x0002 },
    { name: "e", descriptor: "(I)V", accessFlags: 0x0001 },
    { name: "f", descriptor: "(I)V", accessFlags: 0x0002 },
    { name: "f", descriptor: "(Ljava/lang/String;)V", accessFlags: 0x0002 }
  ]
};

const FILES = join(root, "files");
mkdirSync(FILES, { recursive: true });
const WIDENER = "accessWidener v2 official\naccessible class a/b/C\naccessible field a/b/C d I\naccessible method a/b/C e (I)V\n";
const BAD_WIDENER = "accessWidener v2 official\naccessible class a/b/C\naccessible field a/b/C nope I\n";
const TRANSFORMER = "public a.b.C\npublic a.b.C d\npublic a.b.C e(I)V\n";
const BAD_TRANSFORMER = "public a.b.C\npublic a.b.C missing()V\n";
const WIDENER_FILE = join(FILES, "example.accesswidener");
const BAD_WIDENER_FILE = join(FILES, "bad.accesswidener");
const TRANSFORMER_FILE = join(FILES, "accesstransformer.cfg");
writeFileSync(WIDENER_FILE, WIDENER);
writeFileSync(BAD_WIDENER_FILE, BAD_WIDENER);
writeFileSync(TRANSFORMER_FILE, TRANSFORMER);
/** A Loom-style workspace without any runtime jar in it or in the Gradle home. */
const NO_RUNTIME = join(root, "no-runtime");
mkdirSync(NO_RUNTIME, { recursive: true });
writeFileSync(join(NO_RUNTIME, "gradle.properties"), `minecraft_version=${OBF_VERSION}\n`);

const LIBRARY_JAR = join(root, "lib", "library.jar");

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

type NextAction = { tool: string; params: Record<string, any>; reason?: string; template?: true };
type Envelope = {
  result?: Record<string, any>;
  error?: Record<string, any> & { fieldErrors?: Array<Record<string, any>> };
  meta: Record<string, any> & {
    warnings?: Array<{ code: string; severity: string; message: string }>;
    nextActions?: NextAction[];
  };
};

let session: CatalogSession;

before(async () => {
  for (const version of VERSIONS) {
    const path = join(root, `client-${version}.jar`);
    await createJar(path, {
      ...(version === MOJ_VERSION
        ? {
            "version.json": JSON.stringify({ id: version, name: version }),
            "net/minecraft/SharedConstants.class": buildClassFile({
              internalName: "net/minecraft/SharedConstants",
              accessFlags: 0x0001
            })
          }
        : {}),
      "a/b/C.class": buildClassFile(CLASS_C)
    });
    clientJars.set(version, readFileSync(path));
  }
  mkdirSync(join(root, "lib"), { recursive: true });
  await createJar(LIBRARY_JAR, { "a/b/C.class": buildClassFile(CLASS_C) });
  await createJar(join(root, "lib", "library-sources.jar"), {
    "a/b/C.java": "package a.b;\npublic class C { private int d; public void m() {} private void m(int x) {} public void e(int x) {} }\n"
  });
  session = await startCatalogSession(CATALOG_TOOL_SPECS);
});

after(async () => {
  await session.close();
  globalThis.fetch = originalFetch;
});

function envelopeOf(frame: SessionFrame): { envelope: Envelope; isError: boolean; text: string } {
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const result = frame.result as { content: Array<{ text: string }>; structuredContent: Envelope; isError?: boolean };
  return { envelope: result.structuredContent, isError: result.isError === true, text: result.content[0]!.text };
}

const SPECS: Record<string, CatalogToolSpec> = {
  "access-validate": accessValidateSpec,
  "mixin-verify-target": mixinVerifyTargetSpec
};

/**
 * Checks one reply: it names the catalog tool (positive control) and no 8.x
 * tool, carries no internal fallback sentence, reports declared statuses
 * only, and publishes only executable next actions for catalog tools or
 * flagged templates.
 */
function checkReply(name: string, reply: { envelope: Envelope; text: string }): void {
  assert.equal(reply.envelope.meta.tool, name);
  assert.ok(reply.text.includes(`"${name}"`), "positive control: the catalog tool name is in the reply");
  assert.doesNotMatch(reply.text, ALIAS_NAME_PATTERN, `no 8.x tool name in the ${name} reply: ${reply.text}`);
  assert.equal(reply.text.includes(FALLBACK_SENTENCE), false);
  const block = name === "access-validate" ? reply.envelope.result?.validation : reply.envelope.result?.verdict;
  if (block !== undefined) {
    assert.ok((SPECS[name]!.statuses as readonly string[]).includes(block.status), `${name} status ${block.status} is declared`);
  }
  for (const action of reply.envelope.meta.nextActions ?? []) {
    assert.ok(CATALOG_TOOL_SPECS.some((spec) => spec.name === action.tool), `${action.tool} is a catalog tool`);
    if (action.template !== true) {
      assert.deepEqual(finalizeNextActions([action]), [action], `next action ${JSON.stringify(action)} validates`);
    }
  }
}

async function catalog(name: string, args: unknown) {
  const reply = envelopeOf(await session.callTool(name, args));
  checkReply(name, reply);
  return reply;
}

async function eightX(name: string, args: unknown) {
  return envelopeOf(await session.callTool(name, args));
}

async function direct(spec: CatalogToolSpec, args: unknown, services: CatalogServices) {
  const reply = await runCatalogTool(spec, args, {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  });
  const envelope = reply.structuredContent as Envelope;
  const text = (reply.content as Array<{ text: string }>)[0]!.text;
  checkReply(spec.name, { envelope, text });
  return { envelope, isError: reply.isError === true, text };
}

function assertSameFailure(actual: Envelope["error"], expected: Envelope["error"], label: string): void {
  assert.ok(expected, `${label}: the 8.x tool fails`);
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(actual?.[key], expected?.[key], `${label}: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// access-validate
// ---------------------------------------------------------------------------

/**
 * An access-validate `validation` block holds the 8.x result unchanged: the
 * same entries, summary, header and namespace (wideners) and provenance,
 * with the verdict flag replaced by `status`; the service warnings move to
 * `meta.warnings`.
 */
function assertSameAccessResult(reply: { envelope: Envelope }, legacy: { envelope: Envelope }, label: string): void {
  const validation = reply.envelope.result!.validation;
  const { valid, warnings: _warnings, ...rest } = legacy.envelope.result!;
  for (const [key, value] of Object.entries(rest)) {
    assert.deepEqual(validation[key], value, `${label}: ${key}`);
  }
  assert.equal(validation.status === "ok", valid === true, `${label}: ok exactly when the 8.x result is valid`);
  for (const warning of legacy.envelope.meta.warnings ?? []) {
    assert.ok(
      reply.envelope.meta.warnings?.some((entry) => entry.message === warning),
      `${label}: the service warning "${warning}" is kept`
    );
  }
}

test("access-validate matches validate-access-widener and validate-access-transformer, from text and from a file", async () => {
  const cases: Array<{
    label: string;
    catalog: Record<string, unknown>;
    legacyTool: string;
    legacy: Record<string, unknown>;
    status: string;
  }> = [
    {
      label: "widener text",
      catalog: { format: "access-widener", content: WIDENER, version: OBF_VERSION, mapping: "obfuscated" },
      legacyTool: "validate-access-widener",
      legacy: { content: WIDENER, version: OBF_VERSION, mapping: "obfuscated" },
      status: "ok"
    },
    {
      label: "widener file",
      catalog: { format: "access-widener", path: BAD_WIDENER_FILE, version: OBF_VERSION, mapping: "obfuscated" },
      legacyTool: "validate-access-widener",
      legacy: { content: BAD_WIDENER, version: OBF_VERSION, mapping: "obfuscated" },
      status: "invalid"
    },
    {
      label: "widener with Mojang names on an unobfuscated version",
      catalog: { format: "access-widener", content: WIDENER.replace("official", "named"), version: MOJ_VERSION, mapping: "mojang" },
      legacyTool: "validate-access-widener",
      legacy: { content: WIDENER.replace("official", "named"), version: MOJ_VERSION, mapping: "mojang" },
      status: "ok"
    },
    {
      label: "transformer file",
      catalog: { format: "access-transformer", path: TRANSFORMER_FILE, version: OBF_VERSION, mapping: "obfuscated" },
      legacyTool: "validate-access-transformer",
      legacy: { content: TRANSFORMER, version: OBF_VERSION, atNamespace: "obfuscated" },
      status: "ok"
    },
    {
      label: "transformer text",
      catalog: { format: "access-transformer", content: BAD_TRANSFORMER, version: OBF_VERSION, mapping: "obfuscated" },
      legacyTool: "validate-access-transformer",
      legacy: { content: BAD_TRANSFORMER, version: OBF_VERSION, atNamespace: "obfuscated" },
      status: "invalid"
    }
  ];
  for (const { label, catalog: request, legacyTool, legacy: legacyRequest, status } of cases) {
    const legacy = await eightX(legacyTool, legacyRequest);
    assert.equal(legacy.isError, false, `${label}: ${JSON.stringify(legacy.envelope.error)}`);
    const reply = await catalog("access-validate", request);
    assert.equal(reply.isError, false, `${label}: ${JSON.stringify(reply.envelope.error)}`);
    assertSameAccessResult(reply, legacy, label);
    assert.equal(reply.envelope.result!.validation.status, status, label);
    assert.equal(reply.envelope.result!.validation.format, request.format, label);
  }

  const widener = (await catalog("access-validate", cases[0]!.catalog)).envelope.result!.validation;
  assert.deepEqual(
    widener.entries.map((entry: Record<string, unknown>) => [entry.targetKind, entry.valid]),
    [["class", true], ["field", true], ["method", true]],
    "positive control: one verdict per entry"
  );
  assert.equal(widener.headerVersion, "v2");
  assert.equal(widener.errors, undefined, "a valid file has no errors");
  const transformer = (await catalog("access-validate", cases[3]!.catalog)).envelope.result!.validation;
  assert.equal(transformer.headerVersion, undefined, "a transformer has no header");
});

test("an invalid access file says why: its failing entries, or its own warnings when no entry fails", async () => {
  const bad = (await catalog("access-validate", { format: "access-widener", path: BAD_WIDENER_FILE, version: OBF_VERSION, mapping: "obfuscated" }))
    .envelope.result!.validation;
  assert.deepEqual(bad.errors, ['line 3: Field "nope" not found in class "a.b.C".']);

  const cases: Array<[string, string, string[]]> = [
    ["header", "accessWidener v99 official\naccessible class a/b/C\n", ['Line 1: Unsupported accessWidener header version "v99" (expected v1 or v2).']],
    ["kind", "accessWidener v2 official\naccessible class a/b/C\nbogus field a/b/C d I\n", ['Line 3: Unknown access kind "bogus".']],
    ["legality", "accessWidener v2 official\naccessible class a/b/C\nextendable field a/b/C d I\n", ['Line 3: "extendable" does not apply to field (only class and method).']]
  ];
  for (const [label, content, errors] of cases) {
    const validation = (await catalog("access-validate", { format: "access-widener", content, version: OBF_VERSION, mapping: "obfuscated" }))
      .envelope.result!.validation;
    assert.equal(validation.status, "invalid", label);
    assert.deepEqual(validation.errors, errors, `${label}: says why, with its line once`);
  }
  const transformer = (await catalog("access-validate", {
    format: "access-transformer",
    content: "public a.b.C\nbogus a.b.C d\n",
    version: OBF_VERSION,
    mapping: "obfuscated"
  })).envelope.result!.validation;
  assert.equal(transformer.status, "invalid", "a rejected transformer line makes the file invalid");
  assert.deepEqual(transformer.errors, ['Line 2: Unsupported access declaration "bogus".']);
});

test("an access entry whose class name could not be mapped is uncertain, not a definite failure", async () => {
  // Intermediary names on 1.21.10 need mapping files, which cannot be downloaded here.
  const uncertainOnly = [
    "accessWidener v2 intermediary",
    "accessible class net/minecraft/class_9999",
    "accessible field a/b/C nope I",
    ""
  ].join("\n");
  const reply = await catalog("access-validate", { format: "access-widener", content: uncertainOnly, version: OBF_VERSION, mapping: "intermediary" });
  const validation = reply.envelope.result!.validation;
  assert.equal(validation.status, "partial", "misses behind unmapped names leave the file's verdict open");
  assert.equal(validation.errors, undefined);
  assert.deepEqual(
    validation.entries.map((entry: Record<string, any>) => [entry.line, entry.valid, entry.confidence]),
    [[2, false, "uncertain"], [3, false, "uncertain"]]
  );
  for (const entry of validation.entries) {
    assert.match(entry.confidenceReason, /^(Could not map class|Mapping lookup failed for class) "(net\.minecraft\.class_9999|a\.b\.C)"/);
    assert.ok(
      reply.envelope.meta.warnings?.some((warning) => warning.message === entry.confidenceReason),
      "the reason is the service's own warning"
    );
  }

  const legacy = await eightX("validate-access-widener", { content: uncertainOnly, version: OBF_VERSION, mapping: "intermediary" });
  assert.equal(legacy.envelope.result!.valid, false, "the 8.x verdict counted both misses as failures");
  assert.deepEqual(validation.summary, legacy.envelope.result!.summary, "the service's counts are kept");

  const mixed = (await catalog("access-validate", {
    format: "access-widener",
    content: `${uncertainOnly}extendable field a/b/C d I\n`,
    version: OBF_VERSION,
    mapping: "intermediary"
  })).envelope.result!.validation;
  assert.equal(mixed.status, "invalid", "positive control: a definite failure beside uncertain ones is invalid");
  assert.equal(mixed.errors[0], 'Line 4: "extendable" does not apply to field (only class and method).');
  assert.equal(mixed.entries.find((entry: Record<string, any>) => entry.line === 4).confidence, undefined, "a rule violation is never uncertain");
  assert.equal(
    mixed.errors.some((error: string) => /^line [23]:/.test(error)),
    false,
    "the uncertain entries are not listed as definite errors"
  );

  const rejected = (await catalog("access-validate", {
    format: "access-widener",
    content: `${uncertainOnly}bogus field a/b/C d I\n`,
    version: OBF_VERSION,
    mapping: "intermediary"
  })).envelope.result!.validation;
  assert.equal(rejected.status, "invalid", "a rejected line beside uncertain entries is invalid");
  assert.ok(rejected.errors.includes('Line 4: Unknown access kind "bogus".'), JSON.stringify(rejected.errors));
});

test("an invalid access file lists only its definite failures and rejected lines as errors", async () => {
  const content = [
    "accessWidener v2 official",
    "accessible class net/minecraft/class_9999",
    "extendable field a/b/C d I",
    "bogus field a/b/C d I",
    ""
  ].join("\n");
  const reply = await catalog("access-validate", { format: "access-widener", content, version: OBF_VERSION, mapping: "intermediary" });
  const validation = reply.envelope.result!.validation;
  assert.equal(validation.status, "invalid");
  assert.deepEqual(validation.errors, [
    'Line 3: "extendable" does not apply to field (only class and method).',
    'Line 4: Unknown access kind "bogus".'
  ]);
  assert.equal(validation.entries[0].confidence, "uncertain", "positive control: the unmapped class's entry is uncertain");
  const warnings = reply.envelope.meta.warnings!.map((warning) => warning.message);
  assert.ok(warnings.includes('Using mapping override "intermediary" instead of header namespace "official".'), "the override stays a warning");
  assert.ok(warnings.some((warning) => /^(Could not map class|Mapping lookup failed for class) "net\.minecraft\.class_9999"/.test(warning)), "the mapping miss stays a warning");
});

/**
 * A source service whose client jar is the 1.21.10 fixture and whose mapping
 * lookups answer per class: `net.minecraft.class_1` maps to `a.b.C`, every
 * other class and every member stays unmapped.
 */
function perClassMappingService(): SourceService {
  const service = new SourceService(buildTestConfig(join(root, "per-class-mapping")));
  const jarPath = join(root, `client-${OBF_VERSION}.jar`);
  (service as unknown as { versionService: unknown }).versionService = {
    resolveVersionJar: async (version: string) => ({ version, jarPath, source: "downloaded", clientJarUrl: "https://example.test/unused" })
  };
  (service as unknown as { mappingService: unknown }).mappingService = {
    findMapping: async (input: { kind: string; name: string }) =>
      input.kind === "class" && input.name === "net.minecraft.class_1"
        ? { resolved: true, status: "resolved", resolvedSymbol: { kind: "class", name: "a.b.C", symbol: "a.b.C" }, candidates: [] }
        : { resolved: false, status: "not_found", candidates: [] },
    resolveMethodMappingExact: async () => ({ resolved: false, status: "not_found", candidates: [] })
  };
  return service;
}

test("only the entry whose own class could not be mapped is uncertain; a mapped class's miss stays definite", async () => {
  const content = [
    "accessWidener v2 intermediary",
    "accessible class net/minecraft/class_9999",
    "accessible field net/minecraft/class_1 nope I",
    ""
  ].join("\n");
  const { envelope } = await direct(
    accessValidateSpec,
    { format: "access-widener", content, version: OBF_VERSION, mapping: "intermediary" },
    perClassMappingService() as unknown as CatalogServices
  );
  const validation = envelope.result!.validation;
  assert.deepEqual(
    validation.entries.map((entry: Record<string, any>) => [entry.line, entry.valid, entry.confidence]),
    [[2, false, "uncertain"], [3, false, undefined]]
  );
  assert.equal(validation.status, "invalid", "the mapped class's missing field is a definite failure");
  assert.deepEqual(validation.errors, ['line 3: Field "nope" not found in class "net.minecraft.class_1".']);
});

test("access-validate reports a widener checked against another version's jar as partial with a version-mismatch warning", async () => {
  const reason = "Runtime evidence comes from Minecraft 1.21.9, not the requested 1.21.10; entries were checked against a different version's bytecode.";
  const services = {
    validateAccessWidener: async () => ({
      headerVersion: "v2",
      namespace: "official",
      valid: true,
      entries: [{ line: 2, kind: "accessible", targetKind: "class", target: "a/b/C", valid: true }],
      summary: { total: 1, valid: 1, invalid: 0 },
      approximate: true,
      approximationReasons: [reason],
      warnings: [reason]
    })
  } as unknown as CatalogServices;
  const { envelope } = await direct(
    accessValidateSpec,
    { format: "access-widener", content: WIDENER, version: OBF_VERSION, mapping: "obfuscated", projectPath: NO_RUNTIME },
    services
  );
  const validation = envelope.result!.validation;
  assert.equal(validation.status, "partial", "another version's evidence is not plain success");
  assert.equal(validation.approximate, true);
  assert.deepEqual(validation.approximationReasons, [reason]);
  assert.deepEqual(envelope.meta.warnings, [
    { code: "version-mismatch", severity: "warning", message: `The file was checked against another version's runtime jar: ${reason}` }
  ], "the reason comes once, as the version-mismatch warning");
});

test("access-validate fails like validate-access-widener when no runtime jar is found, with the hint and no retry call", async () => {
  const content = "accessWidener v2 official\naccessible class a/b/C\n";
  const legacy = await eightX("validate-access-widener", { content, version: OBF_VERSION, projectPath: NO_RUNTIME, scope: "loader", mapping: "obfuscated" });
  for (const [label, form] of [["content", { content }], ["path", { path: WIDENER_FILE }]] as const) {
    const reply = await catalog("access-validate", {
      format: "access-widener",
      ...form,
      version: OBF_VERSION,
      mapping: "obfuscated",
      projectPath: NO_RUNTIME
    });
    assert.equal(reply.isError, true, label);
    assertSameFailure(reply.envelope.error, legacy.envelope.error, label);
    assert.equal(reply.envelope.error!.code, "ERR_CONTEXT_UNRESOLVED");
    assert.equal(reply.envelope.meta.nextActions, undefined, `${label}: repeating the same call would fail the same way`);
    assert.deepEqual(reply.envelope.error!.hints, ["Run Gradle tasks that populate the Loom cache before retrying."]);
  }
});

test("access-validate fails like the 8.x tools on a classTweaker file and an SRG transformer without a runtime jar, in catalog terms", async () => {
  const tweaker = "classTweaker v1 official\naccessible class a/b/C\n";
  const legacyTweaker = await eightX("validate-access-widener", { content: tweaker, version: OBF_VERSION, mapping: "obfuscated" });
  const replyTweaker = await catalog("access-validate", { format: "access-widener", content: tweaker, version: OBF_VERSION, mapping: "obfuscated" });
  assertSameFailure(replyTweaker.envelope.error, legacyTweaker.envelope.error, "classTweaker");
  assert.equal(replyTweaker.envelope.error!.code, "ERR_INVALID_INPUT");
  assert.equal(replyTweaker.envelope.error!.detail, legacyTweaker.envelope.error!.detail);

  const legacySrg = await eightX("validate-access-transformer", { content: TRANSFORMER, version: OBF_VERSION, atNamespace: "srg" });
  const replySrg = await catalog("access-validate", { format: "access-transformer", content: TRANSFORMER, version: OBF_VERSION, mapping: "srg" });
  assertSameFailure(replySrg.envelope.error, legacySrg.envelope.error, "srg");
  assert.equal(replySrg.envelope.error!.detail, 'An SRG access transformer needs scope "loader" so a Forge runtime jar can be resolved.');
  assert.doesNotMatch(replySrg.text, /atNamespace/);
});

test("access-validate names path when the file cannot be read", async () => {
  const missing = join(FILES, "missing.accesswidener");
  const { envelope, isError } = await catalog("access-validate", { format: "access-widener", path: missing, version: OBF_VERSION, mapping: "obfuscated" });
  assert.equal(isError, true);
  assert.equal(envelope.error!.code, "ERR_INVALID_INPUT");
  assert.deepEqual(envelope.error!.fieldErrors!.map((entry) => entry.path), ["path"]);
  assert.match(envelope.error!.detail, new RegExp(`Could not read the access widener file "${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}": ENOENT`));
});

test("access-validate reads a file given as a \\\\wsl.localhost or drive path on a WSL host", { skip: process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host" }, async () => {
  const distro = "access-distro";
  const unc = `\\\\wsl.localhost\\${distro}\\${WIDENER_FILE.replace(/^\//, "").replace(/\//g, "\\")}`;
  await withEnv({ WSL_DISTRO_NAME: distro }, async () => {
    const plain = (await catalog("access-validate", { format: "access-widener", path: WIDENER_FILE, version: OBF_VERSION, mapping: "obfuscated" }))
      .envelope.result!.validation;
    const viaUnc = await catalog("access-validate", { format: "access-widener", path: unc, version: OBF_VERSION, mapping: "obfuscated" });
    assert.equal(viaUnc.isError, false, JSON.stringify(viaUnc.envelope.error));
    assert.deepEqual(viaUnc.envelope.result!.validation, plain, `the UNC spelling ${unc} reads the same file`);

    const drive = await catalog("access-validate", { format: "access-widener", path: "C:\\checks\\missing.accesswidener", version: OBF_VERSION, mapping: "obfuscated" });
    assert.equal(drive.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.match(drive.envelope.error!.detail, /"\/mnt\/c\/checks\/missing\.accesswidener"/, "the drive path is read as its /mnt path");
  });
});

// ---------------------------------------------------------------------------
// Input rules of both tools
// ---------------------------------------------------------------------------

const VERIFY_REQUEST = {
  target: { kind: "jar", jarPath: LIBRARY_JAR },
  className: "a.b.C",
  kind: "field",
  memberName: "d",
  mapping: "obfuscated"
};

test("access-validate takes exactly one of content and path, and a mapping its format has", async () => {
  const base = { format: "access-widener", version: OBF_VERSION, mapping: "obfuscated" };
  const cases: Array<{ request: Record<string, unknown>; paths: string[]; message: RegExp }> = [
    { request: base, paths: ["$"], message: /exactly one of content, path/ },
    { request: { ...base, content: WIDENER, path: WIDENER_FILE }, paths: ["content", "path"], message: /exactly one of content, path; this request has both/ },
    { request: { ...base, content: WIDENER, mapping: "srg" }, paths: ["mapping"], message: /"srg" is not a namespace of format "access-widener"/ },
    {
      request: { ...base, format: "access-transformer", content: TRANSFORMER, mapping: "yarn" },
      paths: ["mapping"],
      message: /"yarn" is not a namespace of format "access-transformer"; it takes obfuscated, mojang, srg/
    },
    {
      request: { ...base, format: "access-transformer", content: TRANSFORMER, mapping: "intermediary" },
      paths: ["mapping"],
      message: /"intermediary" is not a namespace/
    },
    { request: { format: "access-widener", content: WIDENER, version: OBF_VERSION }, paths: ["mapping"], message: /./ },
    { request: { ...base, content: "   " }, paths: ["content"], message: /./ }
  ];
  for (const { request, paths, message } of cases) {
    const { envelope, isError } = await catalog("access-validate", request);
    assert.equal(isError, true, JSON.stringify(request));
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), paths, JSON.stringify(request));
    for (const fieldError of envelope.error!.fieldErrors!) assert.match(fieldError.message, message);
  }
  const srg = accessValidateSpec.inputSchema.safeParse({ format: "access-transformer", content: TRANSFORMER, version: OBF_VERSION, mapping: "srg" });
  assert.equal(srg.success, true, "positive control: srg is a transformer namespace");
  const yarn = accessValidateSpec.inputSchema.safeParse({ format: "access-widener", content: WIDENER, version: OBF_VERSION, mapping: "yarn" });
  assert.equal(yarn.success, true, "positive control: yarn is a widener namespace");
});

test("both tools reject unknown keys, suggest near misses and accept their examples", async () => {
  for (const spec of [accessValidateSpec, mixinVerifyTargetSpec]) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
    }
    const unknown = await catalog(spec.name, { ...spec.examples[0]!, bogusKey: 1 });
    assert.equal(unknown.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(unknown.envelope.error?.fieldErrors?.map((entry) => entry.path), ["bogusKey"]);
  }
  const unknownTarget = await catalog("mixin-verify-target", { ...VERIFY_REQUEST, target: { ...VERIFY_REQUEST.target, bogus: 1 } });
  assert.deepEqual(unknownTarget.envelope.error?.fieldErrors?.map((entry) => entry.path), ["target.bogus"]);
  const artifactKind = await catalog("mixin-verify-target", { ...VERIFY_REQUEST, target: { kind: "artifact", artifactId: "x" } });
  assert.ok(
    artifactKind.envelope.error?.fieldErrors?.some((entry) => entry.path === "target.kind"),
    "the artifact kind is not a target here"
  );

  const nearMisses: Array<[string, Record<string, unknown>, string, string]> = [
    ["access-validate", { format: "access-widener", contnet: WIDENER, version: OBF_VERSION, mapping: "obfuscated" }, "contnet", "content"],
    ["access-validate", { format: "access-widener", content: WIDENER, version: OBF_VERSION, mappings: "obfuscated" }, "mappings", "mapping"],
    ["mixin-verify-target", { ...VERIFY_REQUEST, memberNme: "d" }, "memberNme", "memberName"],
    ["mixin-verify-target", { ...VERIFY_REQUEST, autoRemapp: false }, "autoRemapp", "autoRemap"],
    ["mixin-verify-target", { ...VERIFY_REQUEST, target: { kind: "jar", jarPth: LIBRARY_JAR } }, "target.jarPth", "jarPath"]
  ];
  for (const [name, request, key, suggestion] of nearMisses) {
    const { envelope } = await catalog(name, request);
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT", `${name} ${key}`);
    const fieldError = envelope.error?.fieldErrors?.find((entry) => entry.path === key);
    assert.ok(fieldError, `${name}: ${key} is named`);
    assert.ok(fieldError.suggestions?.includes(suggestion), `${name}: ${key} suggests ${suggestion}`);
  }

  for (const [request, path] of [
    [{ ...VERIFY_REQUEST, memberName: "a.b.C.d" }, "memberName"],
    [{ ...VERIFY_REQUEST, memberName: "m()V" }, "memberName"],
    [{ ...VERIFY_REQUEST, mapping: undefined }, "mapping"],
    [{ ...VERIFY_REQUEST, kind: "class" }, "kind"]
  ] as const) {
    const { envelope } = await catalog("mixin-verify-target", request);
    assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), [path], JSON.stringify(request));
  }
  const constructor = await catalog("mixin-verify-target", { ...VERIFY_REQUEST, kind: "method", memberName: "<init>" });
  assert.equal(constructor.isError, false, "positive control: <init> is a simple member name");
});

// ---------------------------------------------------------------------------
// mixin-verify-target
// ---------------------------------------------------------------------------

test("mixin-verify-target matches verify-mixin-target and maps its outcome to ok, ambiguous or not_found", async () => {
  const cases: Array<{ label: string; member: Record<string, unknown>; mixinMemberName?: string; status: string }> = [
    { label: "one field", member: { kind: "field", name: "d" }, status: "ok" },
    { label: "one overload by descriptor", member: { kind: "method", name: "m", descriptor: "(I)V" }, mixinMemberName: "invokeM", status: "ok" },
    { label: "two overloads", member: { kind: "method", name: "m" }, status: "ambiguous" },
    { label: "a near name", member: { kind: "field", name: "dd" }, status: "not_found" },
    { label: "another descriptor", member: { kind: "method", name: "m", descriptor: "(J)V" }, status: "not_found" }
  ];
  for (const { label, member, mixinMemberName, status } of cases) {
    const legacy = await eightX("verify-mixin-target", {
      target: { kind: "jar", value: LIBRARY_JAR },
      owner: "a.b.C",
      member,
      mapping: "obfuscated",
      ...(mixinMemberName !== undefined ? { mixinMemberName } : {})
    });
    assert.equal(legacy.isError, false, `${label}: ${JSON.stringify(legacy.envelope.error)}`);
    const reply = await catalog("mixin-verify-target", {
      target: { kind: "jar", jarPath: LIBRARY_JAR },
      className: "a.b.C",
      kind: member.kind,
      memberName: member.name,
      ...(member.descriptor !== undefined ? { descriptor: member.descriptor } : {}),
      ...(mixinMemberName !== undefined ? { mixinMemberName } : {}),
      mapping: "obfuscated"
    });
    assert.equal(reply.isError, false, `${label}: ${JSON.stringify(reply.envelope.error)}`);
    const expected = legacy.envelope.result!;
    const { verdict, artifact } = reply.envelope.result!;
    assert.equal(verdict.status, status, label);
    assert.equal(expected.exists, status !== "not_found", `${label}: the 8.x verdict agrees`);
    assert.deepEqual(
      { className: verdict.className, mapping: verdict.mapping, matches: verdict.matches, candidates: verdict.candidates, advice: verdict.advice },
      {
        className: expected.resolvedOwner.className,
        mapping: expected.resolvedOwner.mapping,
        matches: expected.matches,
        candidates: expected.candidates,
        advice: expected.accessorAdvice
      },
      `${label}: same verdict`
    );
    assert.equal(verdict.kind, member.kind);
    assert.equal(verdict.memberName, member.name);
    assert.equal(artifact.artifactId, expected.provenance.artifactId, `${label}: the artifact the 8.x tool read`);
    assert.equal(artifact.mappingApplied, "obfuscated");
  }
});

test("an ambiguous verdict offers a template that asks for the descriptor, and filling it in verifies one overload", async () => {
  const request = { target: { kind: "jar", jarPath: LIBRARY_JAR }, className: "a.b.C", kind: "method", memberName: "m", mapping: "obfuscated" };
  const reply = await catalog("mixin-verify-target", request);
  const { verdict } = reply.envelope.result!;
  assert.equal(verdict.status, "ambiguous");
  assert.deepEqual(verdict.matches.map((match: Record<string, unknown>) => match.descriptor), ["()V", "(I)V"]);
  assert.equal(verdict.advice, undefined, "no advice without one match");
  const [template] = reply.envelope.meta.nextActions!;
  assert.deepEqual(template, {
    tool: "mixin-verify-target",
    params: { ...request, descriptor: "<descriptor>" },
    reason: "Verify one overload: put one of verdict.matches[].descriptor in place of <descriptor>.",
    template: true
  });
  const filled = await catalog("mixin-verify-target", { ...template!.params, descriptor: verdict.matches[1].descriptor });
  assert.equal(filled.envelope.result!.verdict.status, "ok");
  assert.equal(filled.envelope.result!.verdict.advice.suggestedAnnotation, null, "a private method without mixinMemberName gets both options");
  assert.equal(filled.envelope.meta.nextActions, undefined, "one match needs no follow-up");
});

test("mixin-verify-target fails like verify-mixin-target on a class the jar lacks, with a class-find next action", async () => {
  const legacy = await eightX("verify-mixin-target", {
    target: { kind: "jar", value: LIBRARY_JAR },
    owner: "a.b.Nope",
    member: { kind: "field", name: "d" },
    mapping: "obfuscated"
  });
  const reply = await catalog("mixin-verify-target", { ...VERIFY_REQUEST, className: "a.b.Nope" });
  assertSameFailure(reply.envelope.error, legacy.envelope.error, "missing class");
  assert.equal(reply.envelope.error!.code, "ERR_CLASS_NOT_FOUND");
  const artifactId = legacy.envelope.error!.suggestedCall.params.artifactId;
  assert.deepEqual(reply.envelope.meta.nextActions, [
    { tool: "class-find", params: { target: { kind: "artifact", artifactId }, className: "Nope" } }
  ]);
  assert.deepEqual(reply.envelope.error!.hints, ['Use class-find to locate the canonical FQCN for "a.b.Nope" before retrying mixin-verify-target.']);
});

/** Services for a mixin-verify-target call whose artifact and mapping data are stubbed. */
function verifyServices(options: {
  mappingApplied: string;
  version?: string;
  approximatedFrom?: string;
  translate?: Record<string, { name: string; descriptor?: string }>;
  methods?: Array<{ name: string; descriptor: string; accessFlags: number }>;
  resolveInputs?: unknown[];
}): CatalogServices {
  const member = (entry: { name: string; descriptor: string; accessFlags: number }) => ({
    ownerFqn: "a.b.C",
    name: entry.name,
    jvmDescriptor: entry.descriptor,
    javaSignature: `${entry.name}${entry.descriptor}`,
    accessFlags: entry.accessFlags,
    isSynthetic: false
  });
  return {
    resolveArtifact: async (input: unknown) => {
      options.resolveInputs?.push(input);
      return {
        artifactId: "stub-artifact",
        artifactAlias: "stub",
        origin: "local-jar",
        isDecompiled: false,
        binaryJarPath: "/stub/client.jar",
        version: options.version,
        requestedMapping: options.mappingApplied,
        mappingApplied: options.mappingApplied,
        provenance: options.approximatedFrom !== undefined
          ? { versionApproximation: { requestedVersion: options.approximatedFrom, servedVersion: options.version, sourceJarPath: "/stub/sources.jar" } }
          : {},
        qualityFlags: options.approximatedFrom !== undefined ? ["version-approximated"] : [],
        artifactContents: {},
        warnings: []
      };
    },
    findMapping: async (input: { name: string; owner?: string }) => {
      const key = input.owner !== undefined ? `${input.owner}#${input.name}` : input.name;
      const symbol = options.translate?.[key];
      return symbol !== undefined ? { resolved: true, resolvedSymbol: symbol } : { resolved: false, candidates: [] };
    },
    explorerService: {
      getSignature: async () => ({
        classAccessFlags: 0x0001,
        constructors: [],
        methods: (options.methods ?? [{ name: "m", descriptor: "()V", accessFlags: 0x0001 }]).map(member),
        fields: [member({ name: "d", descriptor: "I", accessFlags: 0x0002 })],
        warnings: []
      })
    }
  } as unknown as CatalogServices;
}

const MOJANG_REQUEST = {
  target: { kind: "version", version: OBF_VERSION },
  className: "net.minecraft.Thing",
  kind: "field",
  memberName: "count",
  mapping: "mojang"
};
const TRANSLATIONS = { "net.minecraft.Thing": { name: "a.b.C" }, "net.minecraft.Thing#count": { name: "d" } };

test("mixin-verify-target translates names into the artifact's namespace by default", async () => {
  const translated = await direct(mixinVerifyTargetSpec, MOJANG_REQUEST, verifyServices({ mappingApplied: "obfuscated", version: OBF_VERSION, translate: TRANSLATIONS }));
  assert.equal(translated.isError, false, JSON.stringify(translated.envelope.error));
  assert.deepEqual(
    (({ status, className, memberName, mapping }) => ({ status, className, memberName, mapping }))(translated.envelope.result!.verdict),
    { status: "ok", className: "a.b.C", memberName: "d", mapping: "obfuscated" },
    "the verdict names the member in the artifact's namespace"
  );
  assert.ok(
    translated.envelope.meta.warnings?.some((warning) => warning.message.startsWith("autoRemap translated the target from mojang to obfuscated")),
    "the translation is reported"
  );

  const off = await direct(mixinVerifyTargetSpec, { ...MOJANG_REQUEST, autoRemap: false }, verifyServices({ mappingApplied: "obfuscated", version: OBF_VERSION, translate: TRANSLATIONS }));
  assert.equal(off.envelope.error?.code, "ERR_NAMESPACE_MISMATCH", "positive control: without translation the namespaces clash");
  assert.equal(
    off.envelope.error!.detail,
    'With autoRemap: false, className and memberName must be in the artifact\'s namespace ("obfuscated"), but the request has mapping "mojang". ' +
      'Omit autoRemap (it defaults to true) to translate the names, or pass mapping "obfuscated" with the names in that namespace.'
  );
  assert.deepEqual(off.envelope.error!.hints, [
    'Retry without autoRemap: false, or with mapping "obfuscated" and className and memberName in that namespace (symbol-map translates them).'
  ]);
  assert.doesNotMatch(off.text, /owner\+member|owner\/member|member\.name|autoRemap=true|find-mapping/);
});

test("a name autoRemap cannot translate stays a namespace error, not a miss", async () => {
  const unknownClass = await direct(mixinVerifyTargetSpec, MOJANG_REQUEST, verifyServices({ mappingApplied: "obfuscated", version: OBF_VERSION, translate: {} }));
  assert.equal(unknownClass.envelope.error?.code, "ERR_NAMESPACE_MISMATCH");
  assert.equal(unknownClass.envelope.result, undefined, "no not_found verdict");
  assert.equal(unknownClass.envelope.error!.detail, 'autoRemap could not translate class "net.minecraft.Thing" from mojang to obfuscated.');
  assert.deepEqual(unknownClass.envelope.error!.hints, [
    `Confirm "net.minecraft.Thing" exists in mojang for ${OBF_VERSION}, or pass mapping "obfuscated" with className and memberName in that namespace.`
  ]);
  const unknownMember = await direct(
    mixinVerifyTargetSpec,
    MOJANG_REQUEST,
    verifyServices({ mappingApplied: "obfuscated", version: OBF_VERSION, translate: { "net.minecraft.Thing": { name: "a.b.C" } } })
  );
  assert.equal(unknownMember.envelope.error?.code, "ERR_NAMESPACE_MISMATCH");
  assert.match(unknownMember.envelope.error!.detail, /autoRemap could not translate field "count" of "net\.minecraft\.Thing" from mojang to obfuscated\./);
});

test("an ambiguous verdict after translation asks again in the artifact's namespace", async () => {
  const request = { ...MOJANG_REQUEST, kind: "method", memberName: "tick" };
  const services = verifyServices({
    mappingApplied: "obfuscated",
    version: OBF_VERSION,
    translate: { "net.minecraft.Thing": { name: "a.b.C" }, "net.minecraft.Thing#tick": { name: "m" } },
    methods: [
      { name: "m", descriptor: "()V", accessFlags: 0x0001 },
      { name: "m", descriptor: "(I)V", accessFlags: 0x0002 }
    ]
  });
  const { envelope } = await direct(mixinVerifyTargetSpec, request, services);
  assert.equal(envelope.result!.verdict.status, "ambiguous");
  assert.deepEqual(envelope.meta.nextActions, [
    {
      tool: "mixin-verify-target",
      params: {
        target: request.target,
        className: "a.b.C",
        kind: "method",
        memberName: "m",
        descriptor: "<descriptor>",
        mapping: "obfuscated"
      },
      reason: "Verify one overload: put one of verdict.matches[].descriptor in place of <descriptor>.",
      template: true
    }
  ], "the matches' descriptors are in the artifact's namespace, so the retry is too");
});

test("mixin-verify-target places each target kind's fields where resolution reads them and reports version honesty", async () => {
  const cases: Array<{ target: Record<string, unknown>; expected: Record<string, unknown> }> = [
    {
      target: { kind: "version", version: OBF_VERSION, projectPath: NO_RUNTIME, scope: "merged" },
      expected: { target: { kind: "version", value: OBF_VERSION }, mapping: "obfuscated", projectPath: NO_RUNTIME, scope: "merged" }
    },
    {
      target: { kind: "workspace", projectPath: NO_RUNTIME, scope: "loader" },
      expected: { target: { kind: "workspace", scope: "loader" }, mapping: "obfuscated", projectPath: NO_RUNTIME }
    },
    {
      target: { kind: "dependency", group: "g", name: "n", projectPath: NO_RUNTIME },
      expected: { target: { kind: "dependency", group: "g", name: "n", versionFromProject: true }, mapping: "obfuscated", projectPath: NO_RUNTIME }
    },
    {
      target: { kind: "dependency", group: "g", name: "n", dependencyVersion: "1.0" },
      expected: { target: { kind: "dependency", group: "g", name: "n", version: "1.0" }, mapping: "obfuscated" }
    },
    { target: { kind: "coordinate", coordinate: "g:n:1.0" }, expected: { target: { kind: "coordinate", value: "g:n:1.0" }, mapping: "obfuscated" } }
  ];
  for (const { target, expected } of cases) {
    const resolveInputs: unknown[] = [];
    const reply = await direct(
      mixinVerifyTargetSpec,
      { ...VERIFY_REQUEST, target },
      verifyServices({ mappingApplied: "obfuscated", version: OBF_VERSION, resolveInputs })
    );
    assert.equal(reply.isError, false, JSON.stringify(reply.envelope.error));
    assert.deepEqual(resolveInputs, [expected], JSON.stringify(target));
  }

  const approximated = await direct(
    mixinVerifyTargetSpec,
    { ...VERIFY_REQUEST, target: { kind: "version", version: "1.21.11" } },
    verifyServices({ mappingApplied: "obfuscated", version: OBF_VERSION, approximatedFrom: "1.21.11" })
  );
  assert.deepEqual(approximated.envelope.result!.artifact, {
    artifactId: "stub-artifact",
    version: OBF_VERSION,
    mappingApplied: "obfuscated",
    requestedVersion: "1.21.11",
    versionApproximated: true
  });
  assert.deepEqual(
    approximated.envelope.meta.warnings?.filter((warning) => warning.code === "version-mismatch").map((warning) => warning.severity),
    ["warning"]
  );
});

/**
 * Services for a call on the obfuscated 1.21.10 client jar whose names are
 * translated by the real mapping service of a separate source service from
 * the Mojang client mappings (`com.mojang.NamedClass` is `a.b.C`, its field
 * `namedField` is `d`, and the overloads `overloaded(int)` and
 * `overloaded(String)` are both `f`).
 */
function realMappingServices(): CatalogServices {
  const mapping = new SourceService(buildTestConfig(join(root, "real-mapping")));
  return {
    resolveArtifact: async () => ({
      artifactId: "client-artifact",
      artifactAlias: "client",
      origin: "local-jar",
      isDecompiled: false,
      binaryJarPath: join(root, `client-${OBF_VERSION}.jar`),
      version: OBF_VERSION,
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      provenance: {},
      qualityFlags: [],
      artifactContents: {},
      warnings: []
    }),
    findMapping: (input: Parameters<SourceService["findMapping"]>[0]) => mapping.findMapping(input),
    explorerService: mapping.explorerService
  } as unknown as CatalogServices;
}

const NAMED_REQUEST = {
  target: { kind: "version", version: OBF_VERSION },
  className: "com.mojang.NamedClass",
  mapping: "mojang"
};

test("a field with a descriptor and a method overload by descriptor translate through the real mapping service", async () => {
  const field = await direct(
    mixinVerifyTargetSpec,
    { ...NAMED_REQUEST, kind: "field", memberName: "namedField", descriptor: "I" },
    realMappingServices()
  );
  assert.equal(field.isError, false, JSON.stringify(field.envelope.error));
  assert.deepEqual(
    (({ status, className, memberName, mapping }) => ({ status, className, memberName, mapping }))(field.envelope.result!.verdict),
    { status: "ok", className: "a.b.C", memberName: "d", mapping: "obfuscated" }
  );
  assert.ok(
    field.envelope.meta.warnings?.some((warning) =>
      warning.message.startsWith('autoRemap could not translate the descriptor for field "namedField" into obfuscated; matching by name only.')
    ),
    "a field is translated by name, and its descriptor is dropped with a warning"
  );

  const overload = await direct(
    mixinVerifyTargetSpec,
    { ...NAMED_REQUEST, kind: "method", memberName: "overloaded", descriptor: "(I)V" },
    realMappingServices()
  );
  assert.equal(overload.isError, false, JSON.stringify(overload.envelope.error));
  const verdict = overload.envelope.result!.verdict;
  assert.equal(verdict.status, "ok", "the descriptor picks one of the two overloads");
  assert.deepEqual(verdict.matches.map((match: Record<string, unknown>) => [match.name, match.descriptor]), [["f", "(I)V"]]);

  const nameOnly = await direct(
    mixinVerifyTargetSpec,
    { ...NAMED_REQUEST, kind: "method", memberName: "overloaded" },
    realMappingServices()
  );
  assert.equal(nameOnly.envelope.error?.code, "ERR_NAMESPACE_MISMATCH", "without a descriptor the two overloads cannot be told apart");
});

test("catalogServiceText rewrites the access and mixin target sentences that name 8.x inputs", () => {
  const cases: Array<[string, string]> = [
    [
      "Point gradleUserHome at the Gradle home holding this workspace's own fabric runtime jars, or run the Gradle task that generates them. " +
        "Omitting projectPath validates against the vanilla jar instead of another loader's.",
      "Point the server's GRADLE_USER_HOME at the Gradle home holding this workspace's own fabric runtime jars, or run the Gradle task that generates them. " +
        "Omitting projectPath and scope validates against the vanilla jar instead of another loader's."
    ],
    [
      'Searched the workspace "/p" and the Gradle caches but found no runtime jar for Minecraft 1.21.10 (the workspace declares 1.21.1; retry with version="1.21.1" or preferProjectVersion=true). Run the Gradle task.',
      'Searched the workspace "/p" and the Gradle caches but found no runtime jar for Minecraft 1.21.10 (the workspace declares 1.21.1; retry with version="1.21.1"). Run the Gradle task.'
    ],
    [
      'verify-mixin-target reads the target\'s members from bytecode, so it needs an artifact with a binary jar. Re-target with target: { kind: "jar", value: "<path to the jar>" }, or with a version whose artifact carries one (resolve-artifact reports binaryJarPath for the target you pass).',
      'verify-mixin-target reads the target\'s members from bytecode, so it needs an artifact with a binary jar. Re-target with target: { kind: "jar", jarPath: "<path to the jar>" }, or with a version whose artifact carries one (artifact-resolve with detail "standard" reports binaryJarPath for the target you pass).'
    ],
    [
      'autoRemap could not translate owner "net.minecraft.Thing" from mojang to obfuscated.',
      'autoRemap could not translate class "net.minecraft.Thing" from mojang to obfuscated.'
    ]
  ];
  for (const [input, expected] of cases) {
    assert.equal(catalogServiceText(input), expected);
  }
  const other = "Retry with mapping=obfuscated to use the runtime obfuscated namespace.";
  assert.equal(catalogServiceText(other), other, "any other sentence is kept as written");
});
