/**
 * Symbol family (symbol-check, symbol-map, class-mappings, symbol-trace)
 * through the in-process MCP session that serves the catalog and the 8.x
 * tools side by side.
 *
 * Fixtures, all local (every other URL is a 404; nothing reaches the network):
 *  - a stubbed Mojang manifest listing 1.21.10, 1.21.9, 1.21.8 and 1.21.7;
 *  - for 1.21.10: the Mojang client mappings of the mapping-service tests
 *    (`TEST_MOJANG_CLIENT_MAPPINGS`) and their Loom tiny file (`TEST_TINY`)
 *    in GRADLE_USER_HOME, so every namespace pair maps through the real
 *    mapping service, as in tests/mapping/mapping-service-*.test.ts;
 *  - client jars built from class files: `a.b.C` declares `e(I)V` in 1.21.10
 *    and not in 1.21.9; the 1.21.8 jar is missing, so that version cannot be
 *    checked (the lifecycle scan of tests/source-service/trace-symbol-lifecycle);
 *  - the 1.21.7 version document is held back until the test releases it, so
 *    heavy calls on that version keep the shared heavy-tool gate busy;
 *  - a Loom workspace declaring `officialMojangMappings()` and
 *    `minecraft_version=1.21.10`, and one without gradle.properties;
 *  - injected services for service warnings the fixtures cannot produce.
 * Every 8.x counterpart runs on the same fixtures through the same session.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { SYMBOL_TOOL_SPECS } from "../../src/tools/families/symbol.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import { DETAIL_LEVELS } from "../../src/tools/schemas.ts";
import { translateServiceSuggestedCall } from "../../src/tools/translation.ts";
import type { CatalogRuntime, CatalogServices } from "../../src/tools/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withEnv } from "../helpers/env.ts";
import { TEST_MOJANG_CLIENT_MAPPINGS, TEST_TINY } from "../helpers/mapping-service-fixtures.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-symbol-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";
process.env.GRADLE_USER_HOME = join(root, "gradle-home");

const MANIFEST_URL = "https://manifest.test/version_manifest_v2.json";
process.env.MCP_VERSION_MANIFEST_URL = MANIFEST_URL;
const VERSION = "1.21.10";
const OLDER_VERSION = "1.21.9";
const JARLESS_VERSION = "1.21.8";
const HELD_VERSION = "1.21.7";
const clientJars = new Map<string, Buffer>();

let releaseHeld!: () => void;
const heldRelease = new Promise<void>((resolve) => {
  releaseHeld = resolve;
});
let heldStarted!: () => void;
const heldRequested = new Promise<void>((resolve) => {
  heldStarted = resolve;
});

// The source service captures `fetch` when it is first built, which happens
// on the first tool call of this file; everything outside the stub is a 404.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === MANIFEST_URL) {
    return new Response(
      JSON.stringify({
        latest: { release: VERSION, snapshot: VERSION },
        versions: [VERSION, OLDER_VERSION, JARLESS_VERSION, HELD_VERSION].map((id) => ({
          id,
          type: "release",
          url: `https://manifest.test/versions/${id}.json`
        }))
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const versionDocument = /^https:\/\/manifest\.test\/versions\/(.+)\.json$/.exec(url);
  if (versionDocument !== null) {
    const id = versionDocument[1]!;
    if (id === HELD_VERSION) {
      heldStarted();
      await heldRelease;
      return new Response("not found", { status: 404 });
    }
    return new Response(
      JSON.stringify({
        id,
        downloads: {
          client: { url: `https://manifest.test/jars/${id}.jar` },
          ...(id === VERSION ? { client_mappings: { url: `https://manifest.test/mappings/${id}.txt` } } : {})
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const jar = /^https:\/\/manifest\.test\/jars\/(.+)\.jar$/.exec(url);
  if (jar !== null && clientJars.has(jar[1]!)) {
    return new Response(clientJars.get(jar[1]!), { status: 200 });
  }
  if (url === `https://manifest.test/mappings/${VERSION}.txt`) {
    return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const workspace = join(root, "workspace");
const versionlessWorkspace = join(root, "versionless-workspace");

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

type Item = Record<string, any> & { symbol: Record<string, unknown>; status: string };
type Envelope = {
  result?: Record<string, any> & { items?: Item[] };
  error?: Record<string, any> & { fieldErrors?: Array<Record<string, any>> };
  meta: Record<string, any> & {
    warnings?: Array<{ code: string; severity: string; message: string }>;
    nextActions?: Array<{ tool: string; params: Record<string, any>; reason?: string; template?: true }>;
    pagination?: { hasMore: boolean; nextCursor?: string };
    truncation?: Array<{ field: string; limitedBy: string }>;
  };
};

let session: CatalogSession;

before(async () => {
  for (const [version, methods] of [
    [VERSION, [{ name: "e", descriptor: "(I)V", accessFlags: 0x0001 }]],
    [OLDER_VERSION, []]
  ] as const) {
    const path = join(root, `client-${version}.jar`);
    await createJar(path, {
      "a/b/C.class": buildClassFile({
        internalName: "a/b/C",
        fields: [{ name: "d", descriptor: "I", accessFlags: 0x0001 }],
        methods: [...methods]
      })
    });
    clientJars.set(version, readFileSync(path));
  }
  const loomCache = join(root, "gradle-home", "caches", "fabric-loom", VERSION);
  mkdirSync(loomCache, { recursive: true });
  writeFileSync(join(loomCache, "mappings.tiny"), `${TEST_TINY}\n`, "utf8");

  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "gradle.properties"), `minecraft_version=${VERSION}\n`, "utf8");
  writeFileSync(join(workspace, "build.gradle"), "dependencies {\n  mappings loom.officialMojangMappings()\n}\n", "utf8");
  mkdirSync(versionlessWorkspace, { recursive: true });
  writeFileSync(join(versionlessWorkspace, "build.gradle"), "dependencies {}\n", "utf8");

  session = await startCatalogSession(CATALOG_TOOL_SPECS);
});

after(async () => {
  releaseHeld();
  await session.close();
  globalThis.fetch = originalFetch;
});

function envelopeOf(frame: SessionFrame): { envelope: Envelope; isError: boolean; text: string } {
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const result = frame.result as { content: Array<{ text: string }>; structuredContent: Envelope; isError?: boolean };
  return { envelope: result.structuredContent, isError: result.isError === true, text: result.content[0]!.text };
}

function specOf(name: string) {
  const spec = SYMBOL_TOOL_SPECS.find((entry) => entry.name === name);
  assert.ok(spec, `${name} is a symbol spec`);
  return spec;
}

/**
 * Calls a catalog tool. Every reply names the catalog tool (positive control)
 * and no 8.x tool, carries no internal fallback sentence, reports only
 * declared statuses, and publishes only executable next actions for catalog
 * tools or flagged templates.
 */
async function catalog(name: string, args: unknown) {
  const reply = envelopeOf(await session.callTool(name, args));
  assert.equal(reply.envelope.meta.tool, name);
  assert.ok(reply.text.includes(`"${name}"`), "positive control: the catalog tool name is in the reply");
  assert.doesNotMatch(reply.text, ALIAS_NAME_PATTERN, `no 8.x tool name in the ${name} reply: ${reply.text}`);
  assert.equal(reply.text.includes(FALLBACK_SENTENCE), false);
  const statuses = specOf(name).statuses as readonly string[];
  for (const item of reply.envelope.result?.items ?? []) {
    assert.ok(statuses.includes(item.status), `${name} item status ${item.status} is declared`);
  }
  if (reply.envelope.result?.status !== undefined) {
    assert.ok(statuses.includes(reply.envelope.result.status), `${name} status ${reply.envelope.result.status} is declared`);
  }
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

/** An 8.x symbol reference in the catalog's form. */
function asCatalogSymbol(reference: { kind: string; name: string; owner?: string; descriptor?: string }) {
  if (reference.kind === "class") return { kind: "class", className: reference.name };
  return {
    kind: reference.kind,
    className: reference.owner,
    memberName: reference.name,
    ...(reference.descriptor !== undefined ? { descriptor: reference.descriptor } : {})
  };
}

const STATUS_OF_8X: Record<string, string> = {
  resolved: "ok",
  not_found: "not_found",
  ambiguous: "ambiguous",
  mapping_unavailable: "unavailable"
};

/** The item carries the 8.x resolution: status, match and candidate count. */
function assertSameResolution(item: Item, legacy: Record<string, any>, label: string): void {
  assert.equal(item.status, STATUS_OF_8X[legacy.status], `${label} status`);
  assert.deepEqual(
    item.match,
    legacy.resolvedSymbol === undefined ? undefined : asCatalogSymbol(legacy.resolvedSymbol),
    `${label} match`
  );
  assert.equal(item.candidateCount, legacy.candidateCount, `${label} candidateCount`);
}

const versionTarget = () => ({ kind: "version", version: VERSION });

test("symbol-check matches check-symbol-exists for each symbol", async () => {
  const requests = [
    { symbol: { kind: "class", className: "a.b.C" }, legacy: { kind: "class", name: "a.b.C" } },
    { symbol: { kind: "method", className: "a.b.C", memberName: "e" }, legacy: { kind: "method", owner: "a.b.C", name: "e" } },
    { symbol: { kind: "field", className: "a.b.C", memberName: "d" }, legacy: { kind: "field", owner: "a.b.C", name: "d" } },
    { symbol: { kind: "field", className: "a.b.C", memberName: "missing" }, legacy: { kind: "field", owner: "a.b.C", name: "missing" } }
  ];
  const { envelope } = await catalog("symbol-check", {
    target: versionTarget(),
    mapping: "obfuscated",
    symbols: requests.map((request) => request.symbol)
  });
  assert.equal(envelope.result!.version, VERSION);
  assert.equal(envelope.result!.mapping, "obfuscated");
  const items = envelope.result!.items!;
  for (const [index, request] of requests.entries()) {
    const legacy = (await eightX("check-symbol-exists", { version: VERSION, sourceMapping: "obfuscated", ...request.legacy }))
      .envelope.result!;
    assert.deepEqual(items[index]!.symbol, request.symbol, "the item names the symbol as requested");
    assertSameResolution(items[index]!, legacy, `symbol ${index}`);
  }
  assert.deepEqual(items.map((item) => item.status), ["ok", "ok", "ok", "not_found"], "positive control: found and missing");
  assert.deepEqual(envelope.result!.counts, { total: 4, ok: 3, failed: 0 });

  const unmapped = await catalog("symbol-check", {
    target: { kind: "version", version: OLDER_VERSION },
    mapping: "obfuscated",
    symbols: [{ kind: "class", className: "a.b.C" }]
  });
  const legacyUnmapped = (await eightX("check-symbol-exists", {
    version: OLDER_VERSION,
    kind: "class",
    name: "a.b.C",
    sourceMapping: "obfuscated"
  })).envelope.result!;
  assert.equal(legacyUnmapped.status, "mapping_unavailable", "positive control: the older version has no mappings");
  assertSameResolution(unmapped.envelope.result!.items![0]!, legacyUnmapped, "a version without mappings");
});

test("symbol-map matches find-mapping one by one and batch-mappings for several symbols", async () => {
  const symbols = [
    { kind: "class", className: "a.b.C" },
    { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" },
    { kind: "field", className: "a.b.C", memberName: "d" }
  ];
  const legacyEntries = [
    { kind: "class", name: "a.b.C" },
    { kind: "method", owner: "a.b.C", name: "e", descriptor: "(I)V" },
    { kind: "field", owner: "a.b.C", name: "d" }
  ];
  for (const toMapping of ["mojang", "intermediary", "yarn"]) {
    const { envelope } = await catalog("symbol-map", { target: versionTarget(), mapping: "obfuscated", toMapping, symbols });
    assert.equal(envelope.result!.toMapping, toMapping);
    const batch = (await eightX("batch-mappings", {
      version: VERSION,
      entries: legacyEntries.map((entry) => ({ ...entry, sourceMapping: "obfuscated", targetMapping: toMapping }))
    })).envelope.result!;
    for (const [index, entry] of legacyEntries.entries()) {
      const single = (await eightX("find-mapping", { version: VERSION, sourceMapping: "obfuscated", targetMapping: toMapping, ...entry }))
        .envelope.result!;
      const item = envelope.result!.items![index]!;
      assertSameResolution(item, single, `${toMapping} symbol ${index}`);
      assertSameResolution(item, batch.results[index].result, `${toMapping} batch entry ${index}`);
      assert.equal(item.status, "ok", `positive control: ${toMapping} symbol ${index} maps`);
    }
  }
});

test("symbol-map with exact: true matches resolve-method-mapping-exact", async () => {
  const { envelope } = await catalog("symbol-map", {
    target: versionTarget(),
    mapping: "obfuscated",
    toMapping: "intermediary",
    exact: true,
    symbols: [
      { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" },
      { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(J)V" }
    ]
  });
  for (const [index, descriptor] of ["(I)V", "(J)V"].entries()) {
    const legacy = (await eightX("resolve-method-mapping-exact", {
      version: VERSION,
      owner: "a.b.C",
      name: "e",
      descriptor,
      sourceMapping: "obfuscated",
      targetMapping: "intermediary"
    })).envelope.result!;
    assertSameResolution(envelope.result!.items![index]!, legacy, `descriptor ${descriptor}`);
  }
  assert.deepEqual(
    envelope.result!.items!.map((item) => item.status),
    ["ok", "not_found"],
    "positive control: only the exact descriptor maps"
  );
});

test("symbol-check and symbol-map look a method with a descriptor up as exact unless signatureMode says otherwise", async () => {
  const check = async (descriptor: string | undefined, signatureMode?: string) =>
    (await catalog("symbol-check", {
      target: versionTarget(),
      mapping: "obfuscated",
      ...(signatureMode ? { signatureMode } : {}),
      symbols: [{ kind: "method", className: "a.b.C", memberName: "e", ...(descriptor ? { descriptor } : {}) }]
    })).envelope.result!.items![0]!;
  assert.equal((await check("(J)V")).status, "not_found", "no e(J)V exists, so the descriptor is not ignored");
  assert.equal((await check("(I)V")).status, "ok");
  assert.equal((await check("(J)V", "name-only")).status, "ok", "an explicit name-only still ignores the descriptor");
  assert.equal((await check(undefined)).status, "ok", "a method without a descriptor resolves by name");

  const map = async (descriptor: string | undefined) =>
    (await catalog("symbol-map", {
      target: versionTarget(),
      mapping: "obfuscated",
      toMapping: "intermediary",
      symbols: [{ kind: "method", className: "a.b.C", memberName: "f", ...(descriptor ? { descriptor } : {}) }]
    })).envelope.result!.items![0]!;
  assert.equal((await map("(I)V")).status, "ok", "the descriptor picks one overload instead of ambiguous");
  assert.equal((await map(undefined)).status, "ambiguous", "positive control: without a descriptor the overloads stay ambiguous");
});

test("symbol-map with a workspace target maps to the project's compile names like resolve-workspace-symbol", async () => {
  const symbols = [
    { kind: "class", className: "a.b.C" },
    { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" }
  ];
  const { envelope } = await catalog("symbol-map", {
    target: { kind: "workspace", projectPath: workspace },
    mapping: "obfuscated",
    symbols
  });
  assert.equal(envelope.result!.version, VERSION, "the version comes from gradle.properties");
  assert.equal(envelope.result!.toMapping, "mojang", "toMapping defaults to the compile namespace");
  assert.deepEqual(envelope.result!.workspace, { resolved: true, mappingApplied: "mojang" });
  for (const [index, legacyQuery] of [
    { kind: "class", name: "a.b.C" },
    { kind: "method", owner: "a.b.C", name: "e", descriptor: "(I)V" }
  ].entries()) {
    const legacy = (await eightX("resolve-workspace-symbol", {
      projectPath: workspace,
      version: VERSION,
      sourceMapping: "obfuscated",
      ...legacyQuery
    })).envelope.result!;
    assertSameResolution(envelope.result!.items![index]!, legacy, `workspace symbol ${index}`);
    assert.equal(legacy.workspaceDetection.mappingApplied, "mojang");
  }
  assert.deepEqual(envelope.result!.items![0]!.match, { kind: "class", className: "com.mojang.NamedClass" });

  const full = await catalog("symbol-map", {
    target: { kind: "workspace", projectPath: workspace },
    mapping: "obfuscated",
    symbols: [symbols[0]],
    detail: "full"
  });
  assert.equal(full.envelope.result!.workspace.evidence[0].reason, "officialMojangMappings()");

  const explicit = await catalog("symbol-map", {
    target: { kind: "workspace", projectPath: workspace },
    mapping: "obfuscated",
    toMapping: "yarn",
    symbols: [symbols[0]]
  });
  assert.equal(explicit.envelope.result!.toMapping, "yarn", "an explicit toMapping wins over the compile names");
  assert.equal(explicit.envelope.result!.workspace, undefined);
  assert.deepEqual(explicit.envelope.result!.items![0]!.match, { kind: "class", className: "yarn.pkg.NamedClass" });

  const exact = await catalog("symbol-map", {
    target: { kind: "workspace", projectPath: workspace },
    mapping: "obfuscated",
    exact: true,
    symbols: [symbols[1]]
  });
  const legacyExact = (await eightX("resolve-workspace-symbol", {
    projectPath: workspace,
    version: VERSION,
    sourceMapping: "obfuscated",
    kind: "method",
    owner: "a.b.C",
    name: "e",
    descriptor: "(I)V"
  })).envelope.result!;
  assert.equal(exact.envelope.result!.toMapping, "mojang", "exact: true without toMapping maps to the compile names");
  assertSameResolution(exact.envelope.result!.items![0]!, legacyExact, "workspace exact method");
  assert.deepEqual(exact.envelope.result!.items![0]!.match, {
    kind: "method",
    className: "com.mojang.NamedClass",
    memberName: "namedMethod",
    descriptor: "(I)V"
  });
});

test("symbol-map shares workspace preparation across mixed items and reads fresh mappings on later calls", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");
  const projectPath = mkdtempSync(join(tmpdir(), "symbol-map-batch-"));
  writeFileSync(join(projectPath, "gradle.properties"), `minecraft_version=${VERSION}\n`);
  const buildScript = join(projectPath, "build.gradle");
  writeFileSync(buildScript, "dependencies { mappings loom.officialMojangMappings() }\n");
  const service = new SourceService(buildTestConfig(join(projectPath, "state")));
  t.after(() => service.db.close());
  const detect = service.workspaceMappingService.detectCompileMapping.bind(service.workspaceMappingService);
  let detections = 0;
  t.mock.method(service.workspaceMappingService, "detectCompileMapping", async (input) => {
    detections++;
    return detect(input);
  });
  const readable = t.mock.method(service.workspaceMappingService, "hasReadableBuildScript");
  const matrix = service.mappingService.getClassApiMatrix.bind(service.mappingService);
  t.mock.method(service.mappingService, "getClassApiMatrix", async (input) => {
    if (input.className === "sample.Failed") throw new Error("one class lookup failed");
    return matrix(input);
  });
  const symbols = [
    { kind: "class", className: "a.b.C" },
    { kind: "field", className: "a.b.C", memberName: "d" },
    { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(J)V" },
    { kind: "class", className: "sample.Failed" },
    { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" }
  ];
  const request = { target: { kind: "workspace", projectPath }, mapping: "obfuscated", symbols };
  const run = async (input = request) =>
    (await runCatalogTool(specOf("symbol-map"), input, injectedRuntime(service))).structuredContent as Envelope;
  const first = await run();
  assert.equal(first.error, undefined, "one graph failure stays inside its item");
  assert.deepEqual(first.result!.items!.map((item) => item.symbol), symbols, "concurrent lookups retain input order");
  assert.deepEqual(first.result!.items!.map((item) => item.status), ["ok", "ok", "not_found", "error", "ok"]);
  assert.deepEqual(first.result!.counts, { total: 5, ok: 3, failed: 1 });
  assert.deepEqual(first.result!.items![0]!.match, { kind: "class", className: "com.mojang.NamedClass" });
  assert.equal(first.result!.items![1]!.match.memberName, "namedField");
  assert.equal(first.result!.items![4]!.match.memberName, "namedMethod");
  assert.equal(detections, 1, "all item kinds share the workspace scan");
  assert.equal(readable.mock.callCount(), 0, "a resolved mapping never probes build readability");

  writeFileSync(buildScript, 'dependencies { mappings "net.fabricmc:yarn:1.21.10+build.1:v2" }\n');
  const later = await run({ ...request, symbols: [symbols[0]!] });
  assert.equal(detections, 2, "a later request scans again");
  assert.equal(later.result!.toMapping, "yarn");
  assert.deepEqual(later.result!.items![0]!.match, { kind: "class", className: "yarn.pkg.NamedClass" });
  for (let index = 0; index < 2; index++) {
    const legacy = await service.resolveWorkspaceSymbol({ projectPath, version: VERSION, sourceMapping: "obfuscated", kind: "class", name: "a.b.C" });
    assert.equal(legacy.resolvedSymbol?.name, "yarn.pkg.NamedClass");
  }
  assert.equal(detections, 4, "single-argument service calls keep independent detection");
  const explicit = await runCatalogTool(specOf("symbol-map"), { ...request, toMapping: "mojang", symbols: [symbols[0]!] }, injectedRuntime(service));
  assert.equal(detections, 4, "an explicit destination bypasses workspace detection");
  assert.deepEqual((explicit.structuredContent as Envelope).result!.items![0]!.match, { kind: "class", className: "com.mojang.NamedClass" });
});

test("symbol-map reports one failed workspace detection on every item and retries on the next request", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");
  const projectPath = mkdtempSync(join(tmpdir(), "symbol-map-detection-retry-"));
  writeFileSync(join(projectPath, "gradle.properties"), `minecraft_version=${VERSION}\n`);
  writeFileSync(join(projectPath, "build.gradle"), "dependencies { mappings loom.officialMojangMappings() }\n");
  const service = new SourceService(buildTestConfig(join(projectPath, "state")));
  t.after(() => service.db.close());
  const detect = service.workspaceMappingService.detectCompileMapping.bind(service.workspaceMappingService);
  let detections = 0;
  let fail = true;
  t.mock.method(service.workspaceMappingService, "detectCompileMapping", async (input) => {
    detections++;
    if (fail) throw new Error("workspace scan failed");
    return detect(input);
  });
  const symbols = Array.from({ length: 7 }, (_,index) => ({ kind: "class", className: `sample.Class${index}` }));
  t.mock.method(service.mappingService, "getClassApiMatrix", async (input) => ({ classIdentity: { mojang: input.className }, warnings: [] }));
  const request = { target: { kind: "workspace", projectPath }, mapping: "obfuscated", symbols };
  const run = async () => (await runCatalogTool(specOf("symbol-map"), request, injectedRuntime(service))).structuredContent as Envelope;
  const failed = await run();
  assert.equal(failed.error, undefined);
  assert.deepEqual(failed.result!.items!.map((item) => item.symbol), symbols);
  assert.deepEqual(failed.result!.items!.map((item) => [item.status, item.error.code]), symbols.map(() => ["error", "ERR_INTERNAL"]));
  assert.deepEqual(failed.result!.counts, { total: 7, ok: 0, failed: 7 });
  assert.equal(detections, 1, "the rejected preparation is shared by queued items too");
  fail = false;
  const retried = await run();
  assert.equal(detections, 2, "the next request retries rejected preparation");
  assert.deepEqual(retried.result!.items!.map((item) => item.match.className), symbols.map((symbol) => symbol.className));
  assert.deepEqual(retried.result!.counts, { total: 7, ok: 7, failed: 0 });
});

test("symbol-map shares lazy unobfuscated build readability and retries a failed probe on later requests", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");
  const projectPath = mkdtempSync(join(tmpdir(), "symbol-map-unobfuscated-batch-"));
  writeFileSync(join(projectPath, "gradle.properties"), "minecraft_version=26.1\n");
  writeFileSync(join(projectPath, "build.gradle"), 'plugins { id "fabric-loom" }\n');
  const service = new SourceService(buildTestConfig(join(projectPath, "state")));
  t.after(() => service.db.close());
  const detect = service.workspaceMappingService.detectCompileMapping.bind(service.workspaceMappingService);
  const readable = service.workspaceMappingService.hasReadableBuildScript.bind(service.workspaceMappingService);
  let detections = 0;
  let probes = 0;
  let fail = false;
  t.mock.method(service.workspaceMappingService, "detectCompileMapping", async (input) => { detections++; return detect(input); });
  t.mock.method(service.workspaceMappingService, "hasReadableBuildScript", async (path) => {
    probes++;
    if (fail) throw new Error("readability probe failed");
    return readable(path);
  });
  t.mock.method(service.versionService, "resolveVersionJar", async () => ({ version: "26.1", jarPath: join(projectPath, "client.jar"), source: "downloaded", clientJarUrl: "https://fixture.test/client.jar" }));
  t.mock.method(service.explorerService, "getSignature", async (input) => {
    if (input.fqn === "sample.Missing") throw createError({ code: ERROR_CODES.CLASS_NOT_FOUND, message: "Class missing." });
    return { constructors: [], fields: [], methods: [], warnings: [], context: { minecraftVersion: "26.1", mappingType: "mojang", mappingNamespace: "mojang", jarSignature: "fixture", generatedAt: "2026-11-04T00:00:00Z" } };
  });
  const symbols = ["sample.First", "sample.Missing", "sample.Last"].map((className) => ({ kind: "class", className }));
  const request = { target: { kind: "workspace", projectPath }, mapping: "mojang", symbols };
  const run = async () => (await runCatalogTool(specOf("symbol-map"), request, injectedRuntime(service))).structuredContent as Envelope;
  const first = await run();
  assert.deepEqual(first.result!.items!.map((item) => [item.symbol.className, item.status]), [["sample.First", "ok"], ["sample.Missing", "not_found"], ["sample.Last", "ok"]]);
  assert.deepEqual(first.result!.counts, { total: 3, ok: 2, failed: 0 });
  assert.equal(first.result!.items![0]!.unobfuscatedRuntime, true);
  assert.equal(first.result!.items![0]!.runtimeValidated, true);
  assert.equal(detections, 1);
  assert.equal(probes, 1);
  fail = true;
  const failed = await run();
  assert.equal(failed.error, undefined);
  assert.deepEqual(failed.result!.items!.map((item) => item.status), ["error", "error", "error"]);
  assert.deepEqual(failed.result!.counts, { total: 3, ok: 0, failed: 3 });
  assert.equal(detections, 2);
  assert.equal(probes, 2, "a failed readability promise is shared within the request");
  fail = false;
  assert.deepEqual((await run()).result!.items!.map((item) => item.status), ["ok", "not_found", "ok"]);
  assert.equal(detections, 3);
  assert.equal(probes, 3, "a later request retries the readability probe");
});

test("symbol tools read a workspace given as a Windows drive or \\\\wsl.localhost path on a WSL host", { skip: process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host" }, async () => {
  const distro = "catalog-distro";
  const unc = `\\\\wsl.localhost\\${distro}\\${workspace.replace(/^\//, "").replace(/\//g, "\\")}`;
  await withEnv({ WSL_DISTRO_NAME: distro }, async () => {
    const checked = await catalog("symbol-check", {
      target: { kind: "workspace", projectPath: unc },
      mapping: "obfuscated",
      symbols: [{ kind: "class", className: "a.b.C" }]
    });
    assert.equal(checked.envelope.result?.version, VERSION, `the UNC spelling ${unc} reads the workspace`);
    assert.equal(checked.envelope.result!.items![0]!.status, "ok");

    const mapped = await catalog("symbol-map", {
      target: { kind: "workspace", projectPath: unc },
      mapping: "obfuscated",
      symbols: [{ kind: "class", className: "a.b.C" }]
    });
    assert.equal(mapped.envelope.result?.toMapping, "mojang", "the compile names are read through the normalized path");
    assert.deepEqual(mapped.envelope.result!.items![0]!.match, { kind: "class", className: "com.mojang.NamedClass" });

    const drive = await catalog("symbol-check", {
      target: { kind: "workspace", projectPath: "C:\\symbols\\missing-project" },
      mapping: "obfuscated",
      symbols: [{ kind: "class", className: "a.b.C" }]
    });
    assert.equal(drive.envelope.error?.code, "ERR_WORKSPACE_VERSION_UNRESOLVED");
    assert.match(drive.envelope.error?.detail ?? "", /\/mnt\/c\/symbols\/missing-project/, "the drive path is read as its /mnt path");
  });
});

test("every symbol-map detail level keeps each item's symbol and status", async () => {
  const request = {
    target: versionTarget(),
    mapping: "obfuscated",
    toMapping: "mojang",
    symbols: [
      { kind: "class", className: "a.b.C" },
      { kind: "field", className: "a.b.C", memberName: "missing" }
    ]
  };
  const levels: Record<string, Item[]> = {};
  for (const detail of DETAIL_LEVELS) {
    const { envelope } = await catalog("symbol-map", { ...request, detail });
    levels[detail] = envelope.result!.items!;
    assert.deepEqual(
      levels[detail]!.map((item) => [item.symbol, item.status]),
      [
        [request.symbols[0], "ok"],
        [request.symbols[1], "not_found"]
      ],
      `detail ${detail}`
    );
  }
  assert.equal("candidates" in levels.summary![0]!, false, "summary leaves out a candidate list that repeats the match");
  assert.equal("candidates" in levels.summary![1]!, false, "summary leaves out an empty candidate list");
  assert.equal(levels.standard![0]!.candidates.length, 1);
  assert.deepEqual(levels.standard![1]!.candidates, []);
  assert.equal("mappingContext" in levels.standard![0]!, false);
  assert.equal(levels.full![0]!.mappingContext.version, VERSION);
  assert.equal(levels.full![0]!.provenance.source, "mojang-client-mappings");
});

test("class-mappings matches get-class-api-matrix page by page and its next page is a valid call", async () => {
  const first = await catalog("class-mappings", { version: VERSION, className: "a.b.C", mapping: "obfuscated", limit: 2 });
  const legacyFirst = (await eightX("get-class-api-matrix", {
    version: VERSION,
    className: "a.b.C",
    classNameMapping: "obfuscated",
    maxRows: 2
  })).envelope.result!;
  assert.deepEqual(first.envelope.result!.rows, legacyFirst.rows);
  assert.equal(first.envelope.result!.rowCount, legacyFirst.rowCount);
  assert.deepEqual(first.envelope.result!.classIdentity, legacyFirst.classIdentity);
  assert.equal(first.envelope.result!.classIdentity.mojang, "com.mojang.NamedClass", "positive control: four namespaces");
  assert.deepEqual(first.envelope.meta.pagination, { hasMore: true, nextCursor: legacyFirst.nextCursor });
  assert.deepEqual(first.envelope.meta.truncation, [{ field: "rows", limitedBy: "limit" }]);
  const next = first.envelope.meta.nextActions?.find((action) => action.tool === "class-mappings");
  assert.ok(next, "the next page is offered");

  const second = await catalog("class-mappings", next.params);
  const legacySecond = (await eightX("get-class-api-matrix", {
    version: VERSION,
    className: "a.b.C",
    classNameMapping: "obfuscated",
    maxRows: 2,
    cursor: legacyFirst.nextCursor
  })).envelope.result!;
  assert.deepEqual(second.envelope.result!.rows, legacySecond.rows);
  assert.ok(second.envelope.result!.rows.length > 0);

  const methods = await catalog("class-mappings", { version: VERSION, className: "a.b.C", mapping: "obfuscated", kinds: ["method"] });
  const legacyMethods = (await eightX("get-class-api-matrix", {
    version: VERSION,
    className: "a.b.C",
    classNameMapping: "obfuscated",
    includeKinds: "method"
  })).envelope.result!;
  assert.deepEqual(methods.envelope.result!.rows, legacyMethods.rows);
  assert.ok(methods.envelope.result!.rows.every((row: { kind: string }) => row.kind === "method"));
  assert.deepEqual(methods.envelope.meta.pagination, { hasMore: false });

  // A cursor fits every spelling of the same listing: kinds in another order, or all three kinds for the default.
  const ordered = await catalog("class-mappings", { version: VERSION, className: "a.b.C", mapping: "obfuscated", kinds: ["method", "field"], limit: 1 });
  const cursor = ordered.envelope.meta.pagination?.nextCursor;
  assert.ok(cursor, "positive control: the listing has a next page");
  const reordered = await catalog("class-mappings", { version: VERSION, className: "a.b.C", mapping: "obfuscated", kinds: ["field", "method", "field"], limit: 1, cursor });
  assert.equal(reordered.envelope.meta.warnings?.some((warning) => warning.code === "cursor-ignored") ?? false, false);
  assert.notDeepEqual(reordered.envelope.result!.rows, ordered.envelope.result!.rows, "the cursor moved on to the next row");
  const allKinds = await catalog("class-mappings", { version: VERSION, className: "a.b.C", mapping: "obfuscated", kinds: ["class", "field", "method"], limit: 2, cursor: legacyFirst.nextCursor });
  assert.deepEqual(allKinds.envelope.result!.rows, legacySecond.rows, "all three kinds read the default listing's cursor");
});

test("symbol-trace matches trace-symbol-lifecycle and tells a missing method from an unchecked one", async () => {
  const { envelope } = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" },
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION,
    withTimeline: true
  });
  const legacy = (await eightX("trace-symbol-lifecycle", {
    symbol: "a.b.C.e",
    descriptor: "(I)V",
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION,
    includeTimeline: true
  })).envelope.result!;
  assert.equal(envelope.result!.status, "ok");
  const lifecycle = envelope.result!.lifecycle;
  assert.deepEqual(lifecycle.symbol, { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" });
  assert.equal(lifecycle.mapping, legacy.query.mapping);
  assert.deepEqual(lifecycle.range, legacy.range);
  assert.deepEqual(lifecycle.presence, legacy.presence);
  assert.deepEqual(lifecycle.timeline, legacy.timeline);
  assert.equal(lifecycle.presence.firstSeen, VERSION, "positive control: the method appears in the newer version");

  const withoutTimeline = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" },
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION
  });
  assert.equal("timeline" in withoutTimeline.envelope.result!.lifecycle, false);

  const missing = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "a.b.C", memberName: "absent" },
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION
  });
  assert.equal(missing.envelope.result!.status, "not_found");

  const unchecked = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "a.b.C", memberName: "e" },
    mapping: "obfuscated",
    fromVersion: JARLESS_VERSION,
    toVersion: JARLESS_VERSION
  });
  assert.equal(unchecked.envelope.result!.status, "unavailable", "a version that could not be checked is not a miss");
  assert.ok(unchecked.envelope.meta.warnings?.some((warning) => warning.message.includes(JARLESS_VERSION)));
});

test("a symbol whose lookup fails stays inside its item while the other symbols are answered", async () => {
  const reply = await catalog("symbol-map", {
    target: versionTarget(),
    mapping: "obfuscated",
    toMapping: "mojang",
    symbols: [
      { kind: "class", className: "a.b.C" },
      { kind: "method", className: "a.b.C", memberName: "e", descriptor: "not-a-descriptor" }
    ]
  });
  const legacy = (await eightX("find-mapping", {
    version: VERSION,
    kind: "method",
    owner: "a.b.C",
    name: "e",
    descriptor: "not-a-descriptor",
    sourceMapping: "obfuscated",
    targetMapping: "mojang"
  })).envelope.error!;
  assert.equal(reply.isError, false);
  const [mapped, failed] = reply.envelope.result!.items!;
  assert.equal(mapped!.status, "ok");
  assert.equal(failed!.status, "invalid");
  assert.equal(legacy.code, "ERR_INVALID_INPUT", "positive control: the service rejects the descriptor");
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(failed!.error[key], legacy[key], key);
  }
  assert.deepEqual(reply.envelope.result!.counts, { total: 2, ok: 1, failed: 1 });
});

test("the symbol family fails the whole call like the 8.x tools when the version or range cannot be determined", async () => {
  const legacyWorkspace = (await eightX("analyze-symbol", {
    task: "exists",
    subject: { kind: "class", name: "a.b.C" },
    projectPath: versionlessWorkspace,
    sourceMapping: "obfuscated"
  })).envelope.error!;
  assert.equal(legacyWorkspace.code, "ERR_WORKSPACE_VERSION_UNRESOLVED");
  for (const name of ["symbol-check", "symbol-map"]) {
    const { envelope, isError } = await catalog(name, {
      target: { kind: "workspace", projectPath: versionlessWorkspace },
      mapping: "obfuscated",
      symbols: [{ kind: "class", className: "a.b.C" }]
    });
    assert.equal(isError, true, name);
    for (const key of ["code", "retryClass", "issueOrigin"]) {
      assert.equal(envelope.error?.[key], legacyWorkspace[key], `${name} ${key}`);
    }
  }

  const legacyRange = (await eightX("trace-symbol-lifecycle", {
    symbol: "a.b.C.e",
    mapping: "obfuscated",
    fromVersion: "0.0.1",
    toVersion: VERSION
  })).envelope.error!;
  assert.ok(legacyRange?.code, "positive control: an unknown range start fails the 8.x trace");
  const { envelope, isError } = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "a.b.C", memberName: "e" },
    mapping: "obfuscated",
    fromVersion: "0.0.1",
    toVersion: VERSION
  });
  assert.equal(isError, true);
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(envelope.error?.[key], legacyRange[key], `symbol-trace ${key}`);
  }
});

test("every symbol tool validates its examples and rejects unknown, misspelled and misplaced keys", async () => {
  for (const spec of SYMBOL_TOOL_SPECS) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
      const reply = await catalog(spec.name, example);
      assert.notEqual(reply.envelope.error?.detail, "Request validation failed.", `${spec.name} example passes validation`);
    }
    const example = spec.examples[0]! as Record<string, unknown>;

    const unknownTop = await catalog(spec.name, { ...example, bogusKey: 1 });
    assert.equal(unknownTop.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.ok(unknownTop.envelope.error?.fieldErrors?.some((entry) => entry.path === "bogusKey"), spec.name);

    if (example.target !== undefined) {
      const unknownTarget = await catalog(spec.name, {
        ...example,
        target: { ...(example.target as Record<string, unknown>), bogusKey: 1 }
      });
      assert.equal(unknownTarget.envelope.error?.code, "ERR_INVALID_INPUT");
      assert.ok(
        unknownTarget.envelope.error?.fieldErrors?.some((entry) => entry.path === "target.bogusKey"),
        `${spec.name} names target.bogusKey`
      );
    }

    const { mapping, ...withoutMapping } = example;
    const missingMapping = await catalog(spec.name, withoutMapping);
    assert.equal(missingMapping.envelope.error?.code, "ERR_INVALID_INPUT", `${spec.name} without mapping`);
    assert.deepEqual(
      missingMapping.envelope.error?.fieldErrors?.map((entry) => entry.path),
      ["mapping"],
      `${spec.name}: a missing mapping fails naming mapping`
    );

    const misspelled = await catalog(spec.name, { ...withoutMapping, maping: mapping });
    assert.equal(misspelled.envelope.error?.code, "ERR_INVALID_INPUT");
    const suggestion = misspelled.envelope.error?.fieldErrors?.find((entry) => entry.path === "maping");
    assert.ok(suggestion?.suggestions?.includes("mapping"), `${spec.name}: "maping" suggests "mapping"`);
  }

  const rejected: Array<[string, Record<string, unknown>, string[]]> = [
    [
      "symbol-map",
      {
        target: versionTarget(),
        mapping: "obfuscated",
        toMapping: "intermediary",
        exact: true,
        symbols: [{ kind: "method", className: "a.b.C", memberName: "e" }]
      },
      ["symbols.0.descriptor"]
    ],
    [
      "symbol-map",
      {
        target: versionTarget(),
        mapping: "obfuscated",
        toMapping: "intermediary",
        exact: true,
        symbols: [{ kind: "field", className: "a.b.C", memberName: "d" }]
      },
      ["symbols.0.kind"]
    ],
    ["symbol-map", { target: versionTarget(), mapping: "obfuscated", symbols: [{ kind: "class", className: "a.b.C" }] }, ["toMapping"]],
    [
      "symbol-trace",
      { symbol: { kind: "method", className: "a.b", memberName: "C.e" }, mapping: "obfuscated", fromVersion: OLDER_VERSION, toVersion: VERSION },
      ["symbol.memberName"]
    ],
    [
      "symbol-check",
      { target: versionTarget(), mapping: "obfuscated", symbols: [{ kind: "method", className: "a.b.C", memberName: "e(I)V" }] },
      ["symbols.0.memberName"]
    ],
    [
      "symbol-check",
      { target: versionTarget(), mapping: "obfuscated", symbols: [{ kind: "field", className: "a.b.C", memberName: "d", descriptor: "I" }] },
      ["symbols.0.descriptor"]
    ],
    [
      "symbol-map",
      {
        target: versionTarget(),
        mapping: "obfuscated",
        toMapping: "intermediary",
        symbols: [{ kind: "class", className: "a.b.C" }, { kind: "field", className: "a.b.C", memberName: "d", descriptor: "I" }]
      },
      ["symbols.1.descriptor"]
    ],
    [
      "symbol-check",
      { target: versionTarget(), mapping: "obfuscated", nameMode: "fqcn", symbols: [{ kind: "class", className: "C" }] },
      ["symbols.0.className"]
    ],
    [
      "symbol-map",
      { target: { kind: "workspace", projectPath: workspace }, mapping: "obfuscated", symbols: [{ kind: "class", className: "C" }] },
      ["symbols.0.className"]
    ],
    [
      "symbol-map",
      { target: { kind: "workspace", projectPath: workspace }, mapping: "obfuscated", symbols: [{ kind: "method", className: "a.b.C", memberName: "e" }] },
      ["symbols.0.descriptor"]
    ],
    [
      "symbol-check",
      { target: versionTarget(), mapping: "obfuscated", signatureMode: "exact", symbols: [{ kind: "class", className: "a.b.C" }, { kind: "method", className: "a.b.C", memberName: "e" }] },
      ["symbols.1.descriptor"]
    ],
    [
      "symbol-check",
      { target: { ...versionTarget(), projectPath: workspace }, mapping: "obfuscated", symbols: [{ kind: "class", className: "a.b.C" }] },
      ["target.projectPath"]
    ],
    [
      "symbol-map",
      { target: { ...versionTarget(), scope: "vanilla" }, mapping: "obfuscated", toMapping: "mojang", symbols: [{ kind: "class", className: "a.b.C" }] },
      ["target.scope"]
    ],
    ["symbol-check", { target: { kind: "artifact", artifactId: "a1" }, mapping: "obfuscated", symbols: [{ kind: "class", className: "a.b.C" }] }, ["target.kind", "target.artifactId"]],
    ["symbol-trace", { symbol: { kind: "class", className: "a.b.C" }, mapping: "obfuscated" }, ["symbol.kind"]],
    ["class-mappings", { version: VERSION, className: "a.b.C", mapping: "obfuscated", kinds: ["constructor"] }, ["kinds.0"]]
  ];
  for (const [name, request, paths] of rejected) {
    const reply = await catalog(name, request);
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", `${name} ${JSON.stringify(request)}`);
    assert.deepEqual(reply.envelope.error?.fieldErrors?.map((entry) => entry.path), paths, `${name} names ${paths.join(", ")}`);
  }

  const legacyFqcn = (await eightX("check-symbol-exists", {
    version: VERSION,
    kind: "class",
    name: "C",
    nameMode: "fqcn",
    sourceMapping: "obfuscated"
  })).envelope.error!;
  assert.equal(legacyFqcn.code, "ERR_INVALID_INPUT", "8.x rejects a dotless class under fqcn at validation too");
  assert.deepEqual(legacyFqcn.fieldErrors?.map((entry: { path: string }) => entry.path), ["name"]);
  const constructor = await catalog("symbol-check", {
    target: versionTarget(),
    mapping: "obfuscated",
    symbols: [{ kind: "method", className: "a.b.C", memberName: "<init>" }]
  });
  assert.equal(constructor.isError, false, "<init> is a simple member name");

  const accepted = await catalog("symbol-map", {
    target: { ...versionTarget(), projectPath: workspace },
    mapping: "obfuscated",
    toMapping: "mojang",
    symbols: [{ kind: "class", className: "a.b.C" }]
  });
  assert.equal(accepted.envelope.result!.items![0]!.status, "ok", "symbol-map takes projectPath with a version target");
  const tooMany = await catalog("symbol-check", {
    target: versionTarget(),
    mapping: "obfuscated",
    symbols: Array.from({ length: 51 }, () => ({ kind: "class", className: "a.b.C" }))
  });
  assert.equal(tooMany.envelope.error?.code, "ERR_INVALID_INPUT");
});

test("service suggestions naming the replaced 8.x symbol tools become valid catalog calls", () => {
  const cases: Array<[{ tool: string; params: Record<string, unknown> }, { tool: string; params: Record<string, unknown> }]> = [
    [
      {
        tool: "check-symbol-exists",
        params: { kind: "field", owner: "a.b.C", name: "d", version: VERSION, sourceMapping: "mojang", sourcePriority: "loom-first" }
      },
      {
        tool: "symbol-check",
        params: {
          target: { kind: "version", version: VERSION },
          mapping: "mojang",
          symbols: [{ kind: "field", className: "a.b.C", memberName: "d" }]
        }
      }
    ],
    [
      {
        tool: "check-symbol-exists",
        params: { kind: "class", name: "a.b.C", version: VERSION, sourceMapping: "obfuscated", nameMode: "auto" }
      },
      {
        tool: "symbol-check",
        params: {
          target: { kind: "version", version: VERSION },
          mapping: "obfuscated",
          symbols: [{ kind: "class", className: "a.b.C" }],
          nameMode: "auto"
        }
      }
    ],
    [
      {
        tool: "find-mapping",
        params: {
          version: VERSION,
          kind: "method",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "yarn",
          signatureMode: "exact",
          maxCandidates: 10,
          projectPath: "/work/mod"
        }
      },
      {
        tool: "symbol-map",
        params: {
          target: { kind: "version", version: VERSION, projectPath: "/work/mod" },
          mapping: "obfuscated",
          toMapping: "yarn",
          symbols: [{ kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" }],
          signatureMode: "exact",
          maxCandidates: 10
        }
      }
    ],
    [
      {
        tool: "resolve-method-mapping-exact",
        params: { version: VERSION, owner: "a.b.C", name: "e", descriptor: "(I)V", sourceMapping: "obfuscated", targetMapping: "mojang" }
      },
      {
        tool: "symbol-map",
        params: {
          target: { kind: "version", version: VERSION },
          mapping: "obfuscated",
          toMapping: "mojang",
          symbols: [{ kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" }],
          exact: true
        }
      }
    ],
    [
      {
        tool: "get-class-api-matrix",
        params: { version: VERSION, className: "a.b.C", classNameMapping: "obfuscated", includeKinds: "field, method", maxRows: 5 }
      },
      {
        tool: "class-mappings",
        params: { version: VERSION, className: "a.b.C", mapping: "obfuscated", kinds: ["field", "method"], limit: 5 }
      }
    ]
  ];
  for (const [service, expected] of cases) {
    const translated = translateServiceSuggestedCall(service);
    assert.deepEqual(translated, expected, service.tool);
    assert.deepEqual(finalizeNextActions([translated!]), [expected], `${expected.tool} call validates`);
  }
  assert.equal(
    translateServiceSuggestedCall({ tool: "check-symbol-exists", params: { kind: "class", name: "a.b.C", version: VERSION } }),
    undefined,
    "a suggestion without a namespace has no catalog form"
  );
  assert.equal(
    translateServiceSuggestedCall({ tool: "get-class-api-matrix", params: { version: VERSION, className: "a.b.C" } }),
    undefined,
    "a class suggestion without its namespace has no catalog form"
  );
});

function injectedRuntime(services: CatalogServices): CatalogRuntime {
  return {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  };
}

const OWNER_STRICT =
  'Exact method resolution is owner-strict: "a.b.C" does not itself declare e(I)V. 1 candidate(s) with that name and ' +
  "descriptor are declared by other classes (intermediary: a.b.D). An inherited or relocated member cannot resolve " +
  "here — use find-mapping for an owner-agnostic lookup, or query the declaring class directly.";
const REJECTED =
  "2 further name-matched candidate(s) were rejected before the verdict (2 by owner, 0 by descriptor) and are not reported; use find-mapping for the unfiltered list.";
const NAME_ONLY_RETRY =
  'Retry with signatureMode="exact" plus a JVM descriptor, or pass disambiguation.descriptorHint, or raise maxCandidates up to 200 to inspect the full candidate list.';
const OWNER_HINT = "Raise maxCandidates up to 200 to inspect the full candidate list, or use disambiguation.ownerHint to narrow the search.";
const EXACT_HINT =
  "Raise maxCandidates up to 200 to inspect the full candidate list, or narrow the lookup via find-mapping disambiguation hints.";
const OVERLOADS =
  'Multiple method overloads matched name "sourceMapping" in owner "a.targetMapping.C". Retry with signatureMode="exact" plus a JVM descriptor to pick one overload.';
/** Service text that names `sourceMapping` only inside a path and a symbol name; it is data, not advice. */
const DATA_SENTENCES = [
  'Loom tiny mappings for "1.21.10" hit the 100-entry index budget while reading "/home/u/sourceMapping/classNameMapping/mappings.tiny"; 1 of 2 selected file(s) were left unread and some symbols may be missing. Raise MCP_LOOM_TINY_MAX_INDEX_ENTRIES or start the server with a larger --max-old-space-size.',
  'Multiple class symbols matched short name "targetMapping". Provide fully-qualified class name.'
];

function resolution(warnings: string[]) {
  return async () => ({
    querySymbol: { kind: "method", name: "e", owner: "a.b.C", symbol: "a.b.C.e" },
    mappingContext: { version: VERSION, sourceMapping: "obfuscated", targetMapping: "mojang", sourcePriorityApplied: "loom-first" },
    resolved: false,
    status: "ambiguous",
    candidates: [],
    candidateCount: 2,
    warnings
  });
}

async function warningMessages(name: string, args: unknown, services: CatalogServices): Promise<string[]> {
  const reply = await runCatalogTool(specOf(name), args, injectedRuntime(services));
  return ((reply.structuredContent as Envelope).meta.warnings ?? []).map((warning) => warning.message);
}

test("mapping-service advice names the catalog inputs, while paths and symbol names stay unchanged", async () => {
  const unobfuscated =
    'sourceMapping "yarn" has no names on unobfuscated Minecraft 26.1; pass sourceMapping "mojang" (or "obfuscated") to resolve against runtime names.';
  const services = {
    findMapping: resolution([
      "Ambiguous mapping: 2 candidates matched. Provide a stricter symbol input or disambiguation hints.",
      NAME_ONLY_RETRY,
      OWNER_HINT,
      OVERLOADS,
      unobfuscated,
      ...DATA_SENTENCES
    ]),
    resolveMethodMappingExact: resolution([EXACT_HINT, REJECTED, OWNER_STRICT, ...DATA_SENTENCES])
  } as unknown as CatalogServices;
  const request = {
    target: versionTarget(),
    mapping: "obfuscated",
    toMapping: "mojang",
    symbols: [{ kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" }]
  };
  assert.deepEqual(await warningMessages("symbol-map", request, services), [
    "Ambiguous mapping: 2 candidates matched. Provide a stricter symbol input.",
    'Retry with signatureMode="exact" plus a JVM descriptor, or raise maxCandidates up to 200 to inspect the full candidate list.',
    "Raise maxCandidates up to 200 to inspect the full candidate list.",
    OVERLOADS,
    'mapping "yarn" has no names on unobfuscated Minecraft 26.1; pass mapping "mojang" (or "obfuscated") to resolve against runtime names.',
    ...DATA_SENTENCES
  ]);
  assert.deepEqual(await warningMessages("symbol-map", { ...request, exact: true }, services), [
    "Raise maxCandidates up to 200 to inspect the full candidate list.",
    "2 further name-matched candidate(s) were rejected before the verdict (2 by owner, 0 by descriptor) and are not reported; use symbol-map with toMapping and without exact for the unfiltered list.",
    OWNER_STRICT.replace(
      "use find-mapping for an owner-agnostic lookup",
      "use symbol-map with toMapping and without exact for an owner-agnostic lookup"
    ),
    ...DATA_SENTENCES
  ]);
});

test("symbol-trace advice names its own inputs and leaves out advice it cannot act on", async () => {
  const services = {
    traceSymbolLifecycle: async () => ({
      query: { className: "a.b.C", methodName: "e", mapping: "obfuscated" },
      range: { fromVersion: OLDER_VERSION, toVersion: VERSION, scannedCount: 2 },
      presence: { missingBetween: [], existsNow: false },
      timeline: [{ version: VERSION, exists: false }],
      warnings: [NAME_ONLY_RETRY, OWNER_HINT, EXACT_HINT, REJECTED, OWNER_STRICT, OVERLOADS, ...DATA_SENTENCES]
    })
  } as unknown as CatalogServices;
  const messages = await warningMessages(
    "symbol-trace",
    { symbol: { kind: "method", className: "a.b.C", memberName: "e" }, mapping: "obfuscated" },
    services
  );
  assert.deepEqual(messages, [
    "Pass symbol.descriptor to pick one overload.",
    "2 further name-matched candidate(s) were rejected before the verdict (2 by owner, 0 by descriptor) and are not reported.",
    OWNER_STRICT.replace("use find-mapping for an owner-agnostic lookup, or query", "query"),
    'Multiple method overloads matched name "sourceMapping" in owner "a.targetMapping.C". Pass symbol.descriptor to pick one overload.',
    ...DATA_SENTENCES
  ]);
});

test("the owner-strict advice for a className without a package asks for a fully qualified className", async () => {
  const unqualified =
    OWNER_STRICT.replace('"a.b.C"', '"C"') +
    ' "C" is also not fully qualified: an unqualified owner cannot be projected into intermediary and can never match, ' +
    "so supply the fully-qualified owner.";
  const catalogTail =
    ' "C" is also not fully qualified: an unqualified className cannot be projected into intermediary and can never match, ' +
    "so pass a fully qualified className.";
  const mapped = await warningMessages(
    "symbol-map",
    {
      target: versionTarget(),
      mapping: "obfuscated",
      toMapping: "mojang",
      exact: true,
      symbols: [{ kind: "method", className: "C", memberName: "e", descriptor: "(I)V" }]
    },
    { resolveMethodMappingExact: resolution([unqualified]) } as unknown as CatalogServices
  );
  assert.deepEqual(mapped, [
    OWNER_STRICT.replace('"a.b.C"', '"C"').replace(
      "use find-mapping for an owner-agnostic lookup",
      "use symbol-map with toMapping and without exact for an owner-agnostic lookup"
    ) + catalogTail
  ]);

  const traced = await warningMessages(
    "symbol-trace",
    { symbol: { kind: "method", className: "C", memberName: "e" }, mapping: "obfuscated" },
    {
      traceSymbolLifecycle: async () => ({
        query: { className: "C", methodName: "e", mapping: "obfuscated" },
        range: { fromVersion: OLDER_VERSION, toVersion: VERSION, scannedCount: 2 },
        presence: { missingBetween: [], existsNow: false },
        timeline: [{ version: VERSION, exists: false }],
        warnings: [unqualified]
      })
    } as unknown as CatalogServices
  );
  assert.deepEqual(traced, [
    OWNER_STRICT.replace('"a.b.C"', '"C"').replace("use find-mapping for an owner-agnostic lookup, or query", "query") + catalogTail
  ]);
  for (const message of [...mapped, ...traced]) {
    assert.doesNotMatch(message, /\bowner\b(?!-)/, "no advice names the owner input");
  }
});

test("symbol-trace reports a symbol it cannot read in terms of its symbol object, like the 8.x trace's error", async () => {
  const reply = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "a.b.C", memberName: "Inner" },
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION
  });
  const legacy = (await eightX("trace-symbol-lifecycle", {
    symbol: "a.b.C.Inner",
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION
  })).envelope.error!;
  assert.equal(legacy.code, "ERR_INVALID_INPUT", "positive control: the service rejects a class-like member");
  assert.equal(reply.isError, true);
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(reply.envelope.error?.[key], legacy[key], key);
  }
  assert.match(reply.envelope.error!.detail, /symbol\.memberName "Inner"/);
  assert.doesNotMatch(reply.text, /Class\.method/);
  const check = reply.envelope.meta.nextActions?.find((action) => action.tool === "symbol-check");
  assert.deepEqual(check?.params.symbols, [{ kind: "class", className: "a.b.C.Inner" }], "the class lookup is offered");
});

test("symbol-trace reports a scan cut at maxVersions in meta.truncation", async () => {
  const request = {
    symbol: { kind: "method", className: "a.b.C", memberName: "e", descriptor: "(I)V" },
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION
  };
  const cut = await catalog("symbol-trace", { ...request, maxVersions: 1 });
  assert.deepEqual(cut.envelope.meta.truncation, [{ field: "lifecycle.range", limitedBy: "maxVersions" }]);
  assert.equal(cut.envelope.result!.lifecycle.range.fromVersion, VERSION);
  assert.ok(cut.envelope.meta.warnings?.some((warning) => warning.message.includes(`Effective fromVersion is now "${VERSION}"`)));
  const whole = await catalog("symbol-trace", request);
  assert.equal(whole.envelope.meta.truncation, undefined, "positive control: an uncut scan reports no truncation");
});

test("an ambiguous method keeps the 8.x candidates, reasons and maxCandidates cut", async () => {
  const { envelope } = await catalog("symbol-map", {
    target: versionTarget(),
    mapping: "obfuscated",
    toMapping: "intermediary",
    maxCandidates: 1,
    symbols: [
      { kind: "class", className: "a.b.C" },
      { kind: "method", className: "a.b.C", memberName: "f" }
    ]
  });
  const legacy = (await eightX("find-mapping", {
    version: VERSION,
    kind: "method",
    owner: "a.b.C",
    name: "f",
    sourceMapping: "obfuscated",
    targetMapping: "intermediary",
    maxCandidates: 1,
    detail: "full"
  })).envelope.result!;
  const item = envelope.result!.items![1]!;
  assert.equal(item.status, "ambiguous");
  assertSameResolution(item, legacy, "overloaded f");
  assert.equal(item.candidateCount, 2);
  assert.deepEqual(
    item.candidates,
    legacy.candidates.map((candidate: Record<string, any>) => ({
      ...asCatalogSymbol(candidate as { kind: string; name: string }),
      matchKind: candidate.matchKind,
      confidence: candidate.confidence
    }))
  );
  assert.equal(item.candidates.length, 1);
  assert.deepEqual(item.ambiguityReasons, legacy.ambiguityReasons);
  assert.deepEqual(envelope.meta.truncation, [{ field: "items[1].candidates", limitedBy: "maxCandidates" }]);
});

test("class-mappings ignores a cursor from another listing with a cursor-ignored warning", async () => {
  const first = await catalog("class-mappings", { version: VERSION, className: "a.b.C", mapping: "obfuscated", limit: 2 });
  const cursor = first.envelope.meta.pagination?.nextCursor;
  assert.ok(cursor);
  const other = await catalog("class-mappings", {
    version: VERSION,
    className: "a.b.C",
    mapping: "obfuscated",
    kinds: ["field"],
    cursor
  });
  assert.ok(other.envelope.meta.warnings?.some((warning) => warning.code === "cursor-ignored"));
  assert.ok(other.envelope.result!.rows.length > 0, "the rows start from the first row");
});

test("heavy catalog tools queue on the server's shared heavy-tool gate with the 8.x heavy tools", async () => {
  const held = [
    session.callTool("class-mappings", { version: HELD_VERSION, className: "a.b.C", mapping: "obfuscated" }),
    session.callTool("find-mapping", {
      version: HELD_VERSION,
      kind: "class",
      name: "a.b.C",
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    }),
    session.callTool("symbol-map", {
      target: { kind: "version", version: HELD_VERSION },
      mapping: "obfuscated",
      toMapping: "mojang",
      symbols: [{ kind: "class", className: "a.b.C" }]
    })
  ];
  // One call runs (held on the version document) and the other two wait in the queue.
  await heldRequested;
  const queue = (heavyToolExecutionGate as unknown as { queue: unknown[] }).queue;
  for (let waited = 0; queue.length < 2 && waited < 5_000; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(queue.length, 2, "the two other heavy calls wait in the shared queue");

  const fourth = session.callTool("symbol-trace", {
    symbol: { kind: "method", className: "a.b.C", memberName: "e" },
    mapping: "obfuscated",
    fromVersion: OLDER_VERSION,
    toVersion: VERSION
  });
  let timer: NodeJS.Timeout | undefined;
  const answered = await Promise.race([
    fourth.then((frame) => envelopeOf(frame)),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 5_000);
    })
  ]);
  clearTimeout(timer);
  assert.ok(answered, "a fourth heavy call is answered at once instead of waiting in the queue");
  assert.equal(answered.isError, true);
  assert.equal(answered.envelope.meta.tool, "symbol-trace");
  assert.equal(answered.envelope.error?.code, "ERR_LIMIT_EXCEEDED", "a fourth heavy call overflows the shared queue");
  assert.match(answered.envelope.error?.detail ?? "", /"symbol-trace" was not started/);
  assert.doesNotMatch(answered.text, ALIAS_NAME_PATTERN);

  const light = await catalog("symbol-check", {
    target: versionTarget(),
    mapping: "obfuscated",
    symbols: [{ kind: "class", className: "a.b.C" }]
  });
  assert.equal(light.envelope.result!.items![0]!.status, "ok", "symbol-check is not heavy and runs at once");

  releaseHeld();
  await fourth;
  const replies = (await Promise.all(held)).map(envelopeOf);
  for (const reply of replies) {
    assert.notEqual(reply.envelope.error?.code, "ERR_LIMIT_EXCEEDED", "the held and queued calls ran");
  }
});
