/**
 * Search family (source-search) through the in-process MCP session that
 * serves the catalog and the 8.x tools side by side. Every 8.x counterpart
 * (search-class-source, the inspect-minecraft search task) runs on the same
 * fixtures through the same session.
 *
 * Fixtures, all local (every URL but the stubbed manifest is a 404; nothing
 * reaches the network and no Java process runs):
 *  - indexed artifacts seeded into the session's cache database with
 *    seedIndexedArtifact: a Mojang-named artifact, an obfuscated one, one
 *    without a version, one for a version without client mappings, one of an
 *    unobfuscated Minecraft runtime (26.2, stored as obfuscated, reported as
 *    mojang), two Jar-in-Jar shells, one with generic type names in its
 *    source, one whose literal scan exceeds the scan byte budget, and one
 *    whose index candidates overflow the indexed search's window;
 *  - a second source service with indexed search switched off, for the
 *    follow-up a server without the index offers;
 *  - a stubbed Mojang manifest whose 1.21.10 client mappings are those of the
 *    mapping-service tests (`com.mojang.NamedClass -> a.b.C`), so a Mojang
 *    class name translates into the obfuscated artifact through the real
 *    mapping service;
 *  - MCP_SEARCH_SCAN_MAX_BYTES at its lowest accepted value (1024), so the
 *    literal scan of the budget artifact stops early;
 *  - a mapping lookup replaced for one call where the fixtures cannot produce
 *    the outcome (an ambiguous name, an unexpected status, a thrown error);
 *    the replacement checks the request the search service sends;
 *  - injected services for a workspace whose sources omit net.minecraft.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { SourceService } from "../../src/source-service.ts";
import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { SEARCH_TOOL_SPECS } from "../../src/tools/families/search.ts";
import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { finalizeNextActions, requestStringValues } from "../../src/tools/next-actions.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import { DETAIL_LEVELS } from "../../src/tools/schemas.ts";
import { serviceSentenceId, translateToolNamesInText } from "../../src/tools/translation.ts";
import type { CatalogRuntime, CatalogServices } from "../../src/tools/types.ts";
import { TEST_MOJANG_CLIENT_MAPPINGS } from "../helpers/mapping-service-fixtures.ts";
import { seedIndexedArtifact, type ArtifactSeed } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-search-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";
process.env.GRADLE_USER_HOME = join(root, "gradle-home");
process.env.MCP_SEARCH_SCAN_MAX_BYTES = "1024";

const MANIFEST_URL = "https://manifest.test/version_manifest_v2.json";
process.env.MCP_VERSION_MANIFEST_URL = MANIFEST_URL;
const VERSION = "1.21.10";
const VERSION_WITHOUT_MAPPINGS = "1.21.9";

// The source service captures `fetch` when it is first built, which happens
// on the first tool call of this file; everything outside the stub is a 404.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === MANIFEST_URL) {
    return new Response(
      JSON.stringify({
        latest: { release: VERSION, snapshot: VERSION },
        versions: [VERSION, VERSION_WITHOUT_MAPPINGS].map((id) => ({
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
  if (url === `https://manifest.test/mappings/${VERSION}.txt`) {
    return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const ITEM_SOURCE = [
  "package net.minecraft.world.item;",
  "",
  "public class Item {",
  '  public static final String TRANSLATION_KEY = "item.minecraft.stick";',
  "  public int getMaxStackSize(ItemStack itemStack) {",
  "    return itemStack.getCount();",
  "  }",
  "}",
  ""
].join("\n");
const ITEM_STACK_SOURCE = "package net.minecraft.world.item;\n\npublic final class ItemStack {\n  public int getCount() {\n    return 1;\n  }\n}\n";
const ITEMS_SOURCE = 'package net.minecraft.world.item;\n\npublic class Items {\n  public static final Item STICK = register("stick");\n}\n';
const BLOCKS_SOURCE = "package net.minecraft.world.level.block;\n\npublic class Blocks {\n  public static void registerBlocks() {}\n}\n";
const EXAMPLE_ITEM_SOURCE = "package com.example;\n\npublic class Item {}\n";

/** Mojang names, version 1.21.10. */
const MOJANG_ARTIFACT: ArtifactSeed = {
  artifactId: "search-mojang",
  origin: "local-jar",
  requestedMapping: "mojang",
  mappingApplied: "mojang",
  qualityFlags: [],
  version: VERSION,
  files: [
    { filePath: "net/minecraft/world/item/Item.java", content: ITEM_SOURCE },
    { filePath: "net/minecraft/world/item/ItemStack.java", content: ITEM_STACK_SOURCE },
    { filePath: "net/minecraft/world/item/Items.java", content: ITEMS_SOURCE },
    { filePath: "net/minecraft/world/level/block/Blocks.java", content: BLOCKS_SOURCE },
    { filePath: "com/example/Item.java", content: EXAMPLE_ITEM_SOURCE }
  ],
  symbols: [
    { filePath: "net/minecraft/world/item/Item.java", symbolKind: "class", symbolName: "Item", qualifiedName: "net.minecraft.world.item.Item", line: 3 },
    { filePath: "net/minecraft/world/item/Item.java", symbolKind: "field", symbolName: "TRANSLATION_KEY", line: 4 },
    { filePath: "net/minecraft/world/item/Item.java", symbolKind: "method", symbolName: "getMaxStackSize", line: 5 },
    { filePath: "net/minecraft/world/item/ItemStack.java", symbolKind: "class", symbolName: "ItemStack", qualifiedName: "net.minecraft.world.item.ItemStack", line: 3 },
    { filePath: "net/minecraft/world/item/ItemStack.java", symbolKind: "method", symbolName: "getCount", line: 4 },
    { filePath: "net/minecraft/world/item/Items.java", symbolKind: "class", symbolName: "Items", qualifiedName: "net.minecraft.world.item.Items", line: 3 },
    { filePath: "net/minecraft/world/item/Items.java", symbolKind: "field", symbolName: "STICK", line: 4 },
    { filePath: "net/minecraft/world/level/block/Blocks.java", symbolKind: "class", symbolName: "Blocks", qualifiedName: "net.minecraft.world.level.block.Blocks", line: 3 },
    { filePath: "net/minecraft/world/level/block/Blocks.java", symbolKind: "method", symbolName: "registerBlocks", line: 4 },
    { filePath: "com/example/Item.java", symbolKind: "class", symbolName: "Item", qualifiedName: "com.example.Item", line: 3 }
  ]
};

/** Obfuscated names, version 1.21.10: `a.b.C` is `com.mojang.NamedClass` in the client mappings. */
const OBFUSCATED_ARTIFACT: ArtifactSeed = {
  artifactId: "search-obfuscated",
  origin: "local-jar",
  requestedMapping: "obfuscated",
  mappingApplied: "obfuscated",
  qualityFlags: [],
  version: VERSION,
  files: [
    { filePath: "a/b/C.java", content: "package a.b;\n\npublic class C {}\n" },
    { filePath: "d/LevelData.java", content: "package d;\n\npublic class LevelData {}\n" }
  ],
  symbols: [
    { filePath: "a/b/C.java", symbolKind: "class", symbolName: "C", qualifiedName: "a.b.C", line: 3 },
    { filePath: "d/LevelData.java", symbolKind: "class", symbolName: "LevelData", qualifiedName: "d.LevelData", line: 3 }
  ]
};

const LEVEL_PATH = "net/minecraft/world/level/Level.java";
const LEVEL_SOURCE = "package net.minecraft.world.level;\n\npublic class Level {}\n";
const levelSymbol = { filePath: LEVEL_PATH, symbolKind: "class", symbolName: "Level", qualifiedName: "net.minecraft.world.level.Level", line: 3 };

/** Obfuscated names without a recorded version: no name can be translated into it. */
const VERSIONLESS_ARTIFACT: ArtifactSeed = {
  artifactId: "search-versionless",
  origin: "local-jar",
  requestedMapping: "obfuscated",
  mappingApplied: "obfuscated",
  qualityFlags: [],
  files: [{ filePath: LEVEL_PATH, content: LEVEL_SOURCE }],
  symbols: [levelSymbol]
};

/** Obfuscated names of a version whose manifest entry has no client mappings. */
const UNMAPPED_VERSION_ARTIFACT: ArtifactSeed = {
  ...VERSIONLESS_ARTIFACT,
  artifactId: "search-unmapped-version",
  version: VERSION_WITHOUT_MAPPINGS
};

/** Version 26.2 runs unobfuscated: stored as `obfuscated`, its names are Mojang's and reported as `mojang`. */
const UNOBFUSCATED_ARTIFACT: ArtifactSeed = {
  artifactId: "search-unobfuscated",
  origin: "local-jar",
  requestedMapping: "obfuscated",
  mappingApplied: "obfuscated",
  qualityFlags: [],
  version: "26.2",
  files: [{ filePath: LEVEL_PATH, content: LEVEL_SOURCE }],
  symbols: [levelSymbol]
};

/** Two files using `List<ItemStack>`, for a query with angle brackets that pages. */
const GENERIC_ARTIFACT: ArtifactSeed = {
  artifactId: "search-generic",
  origin: "local-jar",
  requestedMapping: "mojang",
  mappingApplied: "mojang",
  qualityFlags: [],
  files: ["Inventory", "Container"].map((name) => ({
    filePath: `net/minecraft/world/${name}.java`,
    content: `package net.minecraft.world;\n\npublic class ${name} {\n  List<ItemStack> items;\n}\n`
  })),
  symbols: []
};

const SHELL_ARTIFACT: ArtifactSeed = {
  artifactId: "search-shell",
  origin: "local-jar",
  requestedMapping: "obfuscated",
  mappingApplied: "obfuscated",
  qualityFlags: ["shell-jar"],
  provenance: { nestedJars: ["META-INF/jars/module-1.jar"] },
  files: [],
  symbols: []
};

/** A shell bundling five jars that also indexes one class of its own. */
const SHELL_WITH_OWN_CLASS: ArtifactSeed = {
  ...SHELL_ARTIFACT,
  artifactId: "search-shell-own-class",
  provenance: { nestedJars: [1, 2, 3, 4, 5].map((n) => `META-INF/jars/module-${n}.jar`) },
  files: [{ filePath: LEVEL_PATH, content: LEVEL_SOURCE }],
  symbols: [levelSymbol]
};

/** Three files holding the token, each larger than half the 1024-byte scan budget. */
const BUDGET_ARTIFACT: ArtifactSeed = {
  artifactId: "search-budget",
  origin: "local-jar",
  requestedMapping: "obfuscated",
  mappingApplied: "obfuscated",
  qualityFlags: [],
  files: ["One", "Two", "Three"].map((name) => ({
    filePath: `net/minecraft/a/${name}.java`,
    content: `package net.minecraft.a;\n// budgettoken ${"x".repeat(600)}\n`
  })),
  symbols: []
};

/**
 * 600 early-ranking files fill the indexed search's 500-candidate window
 * without matching: their bodies hold both words but not the phrase, and
 * their paths contain `zzz` without starting with it. The one real match
 * ranks last and falls outside the window.
 */
function windowArtifact(): ArtifactSeed {
  const filler = Array.from({ length: 40 }, (_, index) => `  int filler${index} = ${index};`).join(" ");
  const files = Array.from({ length: 600 }, (_, index) => {
    const n = String(index).padStart(4, "0");
    return { filePath: `aaa/zzz/W${n}.java`, content: `class W${n} { String s = "windowtail windowhead"; }` };
  });
  files.push({ filePath: "zzz/WindowTarget.java", content: `class WindowTarget { String s = "windowhead windowtail"; ${filler} }` });
  return {
    artifactId: "search-window",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files,
    symbols: []
  };
}

/**
 * 1001 methods whose names share a prefix: one more than the symbol search's
 * 1000-candidate window (`MCP_MAX_SEARCH_HITS` 200 × 5), so the last one by
 * name falls outside it. The window's 1000 hits fill five pages of 200
 * exactly, so the last page of the window is a full one.
 */
const SYMBOL_WINDOW_ARTIFACT: ArtifactSeed = {
  artifactId: "search-symbol-window",
  origin: "local-jar",
  requestedMapping: "obfuscated",
  mappingApplied: "obfuscated",
  qualityFlags: [],
  files: [{ filePath: "win/Sym.java", content: "package win;\n\npublic class Sym {}\n" }],
  symbols: Array.from({ length: 1001 }, (_, index) => ({
    filePath: "win/Sym.java",
    symbolKind: "method",
    symbolName: `winSym${String(index).padStart(4, "0")}`,
    qualifiedName: `win.Sym.winSym${String(index).padStart(4, "0")}`,
    line: index + 3
  }))
};

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

type Hit = Record<string, any> & { filePath: string; matchedIn: string };
type Envelope = {
  result?: Record<string, any> & { status?: string; hits?: Hit[] };
  error?: Record<string, any> & { fieldErrors?: Array<Record<string, any>> };
  meta: Record<string, any> & {
    warnings?: Array<{ code: string; severity: string; message: string }>;
    nextActions?: Array<{ tool: string; params: Record<string, any>; reason?: string; template?: true }>;
    pagination?: { hasMore: boolean; nextCursor?: string };
    truncation?: Array<{ field: string; limitedBy: string }>;
  };
};

let session: CatalogSession;
let mappingService: { findMapping: (input: Record<string, unknown>) => Promise<unknown> };
let searchService: CatalogServices["searchClassSource"];

before(async () => {
  session = await startCatalogSession(CATALOG_TOOL_SPECS);
  const { sourceService } = await import("../../src/index.ts");
  for (const seed of [
    MOJANG_ARTIFACT,
    OBFUSCATED_ARTIFACT,
    VERSIONLESS_ARTIFACT,
    UNMAPPED_VERSION_ARTIFACT,
    UNOBFUSCATED_ARTIFACT,
    GENERIC_ARTIFACT,
    SHELL_ARTIFACT,
    SHELL_WITH_OWN_CLASS,
    BUDGET_ARTIFACT,
    SYMBOL_WINDOW_ARTIFACT,
    windowArtifact()
  ]) {
    seedIndexedArtifact(sourceService, seed);
  }
  mappingService = sourceService.mappingService as unknown as typeof mappingService;
  searchService = (input) => sourceService.searchClassSource(input);
});

after(async () => {
  await session.close();
  globalThis.fetch = originalFetch;
});

function envelopeOf(frame: SessionFrame): { envelope: Envelope; isError: boolean; text: string } {
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const result = frame.result as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { envelope: JSON.parse(text) as Envelope, isError: result.isError === true, text };
}

const spec = SEARCH_TOOL_SPECS[0]!;

/**
 * Calls source-search. Every reply names the tool (positive control) and no
 * 8.x tool or 8.x input, carries no internal fallback sentence, reports a
 * declared status, and publishes next actions only for catalog tools, each
 * executable as given unless flagged as a template.
 */
async function search(args: Record<string, unknown>) {
  const reply = envelopeOf(await session.callTool("source-search", args));
  assert.equal(reply.envelope.meta.tool, "source-search");
  assert.ok(reply.text.includes('"source-search"'), "positive control: the catalog tool name is in the reply");
  assert.doesNotMatch(reply.text, ALIAS_NAME_PATTERN, `no 8.x tool name in the reply: ${reply.text}`);
  assert.equal(reply.text.includes(FALLBACK_SENTENCE), false);
  assert.equal(reply.text.includes("queryNamespace"), false, "the reply names no 8.x input");
  if (reply.envelope.result !== undefined) {
    assert.ok(spec.statuses.includes(reply.envelope.result.status as never), `status ${reply.envelope.result.status} is declared`);
    assert.ok(Array.isArray(reply.envelope.result.hits), "every reply keeps hits");
  }
  for (const action of reply.envelope.meta.nextActions ?? []) {
    assert.ok(CATALOG_TOOL_SPECS.some((entry) => entry.name === action.tool), `${action.tool} is a catalog tool`);
    if (action.template !== true) {
      assert.deepEqual(
        finalizeNextActions([action], requestStringValues(args)),
        [action],
        `next action ${JSON.stringify(action)} validates`
      );
    }
  }
  return reply;
}

async function eightX(name: string, args: Record<string, unknown>) {
  return envelopeOf(await session.callTool(name, args));
}

const artifactTarget = (artifactId: string) => ({ kind: "artifact", artifactId });

/** The 8.x request for a catalog request on an artifact target. */
function legacyRequest(args: Record<string, any>): Record<string, unknown> {
  const { target, mapping, detail: _detail, ...rest } = args;
  return { artifactId: target.artifactId, ...rest, ...(mapping !== undefined ? { queryNamespace: mapping } : {}) };
}

function withoutRanking(hits: Hit[]): Hit[] {
  return hits.map(({ score: _score, reasonCodes: _reasonCodes, ...hit }) => hit);
}

function messages(envelope: Envelope): string[] {
  return (envelope.meta.warnings ?? []).map((warning) => warning.message);
}

test("source-search matches search-class-source for each intent and query mode", async () => {
  const cases: Array<Record<string, unknown>> = [
    { query: "Item" },
    { query: "get", match: "contains", symbolKind: "method" },
    { query: "Item", match: "exact", packagePrefix: "com.example" },
    { query: "getCount", intent: "text" },
    { query: "getCount", intent: "text", queryMode: "token" },
    { query: "getCount", intent: "text", queryMode: "literal" },
    { query: "register\\w+\\(", intent: "text", match: "regex" },
    { query: "net/minecraft/world/item/Item", intent: "path" },
    { query: "Items", intent: "path", match: "contains", fileGlob: "net/minecraft/**/*.java" }
  ];
  for (const request of cases) {
    const args = { target: artifactTarget(MOJANG_ARTIFACT.artifactId), ...request };
    const legacy = (await eightX("search-class-source", legacyRequest(args))).envelope.result!;
    assert.ok(legacy.hits.length > 0, `positive control: ${JSON.stringify(request)} finds hits`);

    const full = await search({ ...args, detail: "full" });
    const label = JSON.stringify(request);
    assert.equal(full.isError, false, label);
    assert.equal(full.envelope.result!.status, "ok", label);
    assert.deepEqual(full.envelope.result!.hits, legacy.hits, `${label}: hits equal at detail full`);
    assert.deepEqual(full.envelope.result!.artifactContents, legacy.artifactContents, label);
    assert.deepEqual(full.envelope.result!.artifact, {
      artifactId: MOJANG_ARTIFACT.artifactId,
      version: VERSION,
      mappingApplied: legacy.mappingApplied
    });
    assert.deepEqual(full.envelope.meta.pagination, { hasMore: false });
    assert.equal(full.envelope.meta.nextActions, undefined, `${label}: no follow-up`);

    const standard = await search(args);
    assert.deepEqual(standard.envelope.result!.hits, withoutRanking(legacy.hits), `${label}: hits equal at the default detail`);
  }
});

test("a symbol search reads indexed declarations of every kind with their lines", async () => {
  const { envelope } = await search({ target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "STICK" });
  assert.deepEqual(envelope.result!.hits, [
    {
      filePath: "net/minecraft/world/item/Items.java",
      matchedIn: "symbol",
      symbol: { symbolKind: "field", symbolName: "STICK", line: 4 }
    }
  ]);
});

test("source-search pages with cursor through meta.pagination and a next-page call", async () => {
  const first = { target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "Item", limit: 2 };
  const legacyFirst = (await eightX("search-class-source", legacyRequest(first))).envelope.result!;
  assert.ok(legacyFirst.nextCursor, "positive control: the 8.x search has a second page");

  const page1 = await search(first);
  assert.deepEqual(page1.envelope.result!.hits, withoutRanking(legacyFirst.hits));
  assert.deepEqual(page1.envelope.meta.pagination, { hasMore: true, nextCursor: legacyFirst.nextCursor });
  assert.equal("nextCursor" in page1.envelope.result!, false, "the cursor lives in meta.pagination only");
  assert.deepEqual(page1.envelope.meta.nextActions, [
    {
      tool: "source-search",
      params: {
        target: artifactTarget(MOJANG_ARTIFACT.artifactId),
        query: "Item",
        intent: "symbol",
        match: "prefix",
        queryMode: "auto",
        limit: 2,
        detail: "standard",
        cursor: legacyFirst.nextCursor
      },
      reason: "Read the next page of hits."
    }
  ]);

  const page2 = await search(page1.envelope.meta.nextActions![0]!.params);
  const legacySecond = (await eightX("search-class-source", { ...legacyRequest(first), cursor: legacyFirst.nextCursor }))
    .envelope.result!;
  assert.deepEqual(page2.envelope.result!.hits, withoutRanking(legacySecond.hits));
  assert.equal(page2.envelope.meta.warnings, undefined, "the cursor belongs to this search");
  const seen = new Set(page1.envelope.result!.hits!.map((hit) => `${hit.filePath}#${hit.symbol?.symbolName}`));
  for (const hit of page2.envelope.result!.hits!) {
    assert.equal(seen.has(`${hit.filePath}#${hit.symbol?.symbolName}`), false, "the second page continues after the first");
  }
  assert.deepEqual(page2.envelope.meta.pagination, { hasMore: false }, "four hits end on the second page");
  assert.equal(page2.envelope.meta.nextActions, undefined);
});

test("a cursor of another search is ignored with a cursor-ignored warning", async () => {
  const paged = await search({ target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "Item", limit: 2 });
  const cursor = paged.envelope.meta.pagination!.nextCursor!;
  const other = { target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "Blocks", cursor };
  const legacy = (await eightX("search-class-source", legacyRequest(other))).envelope.result!;
  assert.equal(legacy.cursorIgnored, true, "positive control: the 8.x search ignores the cursor");

  const { envelope } = await search(other);
  assert.deepEqual(envelope.result!.hits, withoutRanking(legacy.hits), "the hits start from the first page");
  assert.equal(envelope.result!.status, "ok");
  assert.deepEqual(envelope.meta.warnings, [
    {
      code: "cursor-ignored",
      severity: "warning",
      message: "The cursor does not belong to this search; the hits start from the first page."
    }
  ]);
  assert.equal("cursorIgnored" in envelope.result!, false);
});

test("every detail level keeps hits and status; context from standard, ranking and contents only at full", async () => {
  const text = { target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "getCount", intent: "text" };
  const translated = { target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "com.mojang.NamedClass", mapping: "mojang" };
  for (const detail of DETAIL_LEVELS) {
    const { envelope } = await search({ ...text, detail });
    assert.equal(envelope.result!.status, "ok", detail);
    assert.ok(envelope.result!.hits!.length > 0, detail);
    for (const hit of envelope.result!.hits!) {
      assert.equal(typeof hit.filePath, "string", `${detail}: filePath`);
      assert.equal(hit.matchedIn, "content", `${detail}: matchedIn`);
      assert.equal(typeof hit.line, "number", `${detail}: line`);
      assert.ok("enclosingSymbol" in hit, `${detail}: enclosingSymbol`);
      assert.equal("context" in hit, detail !== "summary", `${detail}: context`);
      assert.equal("score" in hit, detail === "full", `${detail}: score`);
      assert.equal("reasonCodes" in hit, detail === "full", `${detail}: reasonCodes`);
    }
    assert.equal("artifactContents" in envelope.result!, detail === "full", `${detail}: artifactContents`);
    assert.equal(envelope.result!.artifact.artifactId, MOJANG_ARTIFACT.artifactId);

    const symbol = await search({ ...translated, detail });
    assert.equal(symbol.envelope.result!.status, "ok", detail);
    assert.deepEqual(
      symbol.envelope.result!.translatedQuery,
      { original: "com.mojang.NamedClass", translated: "a.b.C", fromNamespace: "mojang", toNamespace: "obfuscated" },
      `${detail}: translatedQuery`
    );
    assert.equal("score" in symbol.envelope.result!.hits![0]!, detail === "full", `${detail}: symbol hit score`);
  }
});

test("mapping names the query's namespace: a Mojang class name finds the obfuscated class", async () => {
  const translated = {
    target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId),
    query: "com.mojang.NamedClass",
    mapping: "mojang",
    detail: "full"
  };
  const legacy = (await eightX("search-class-source", legacyRequest(translated))).envelope;
  assert.deepEqual(legacy.result!.translatedQuery?.translated, "a.b.C", "positive control: the 8.x search translates");

  const { envelope } = await search(translated);
  assert.equal(envelope.result!.status, "ok");
  assert.deepEqual(envelope.result!.hits, legacy.result!.hits);
  assert.deepEqual(envelope.result!.hits!.map((hit) => hit.filePath), ["a/b/C.java"]);
  assert.deepEqual(envelope.result!.translatedQuery, legacy.result!.translatedQuery);
  assert.equal(envelope.result!.artifact.mappingApplied, "obfuscated", "hits keep the artifact's namespace");

  const untranslated = await search({ ...translated, mapping: undefined });
  assert.equal(untranslated.envelope.result!.status, "not_found", "without mapping the name is searched as given");

  // The artifact's own namespace: a qualified name is searched by its simple
  // name inside its package, as search-class-source does with queryNamespace.
  const identity = {
    target: artifactTarget(MOJANG_ARTIFACT.artifactId),
    query: "net.minecraft.world.item.Item",
    match: "exact",
    mapping: "mojang",
    detail: "full"
  };
  const legacyIdentity = (await eightX("search-class-source", legacyRequest(identity))).envelope.result!;
  const sameNamespace = await search(identity);
  assert.deepEqual(sameNamespace.envelope.result!.hits, legacyIdentity.hits);
  assert.deepEqual(sameNamespace.envelope.result!.hits!.map((hit) => hit.filePath), ["net/minecraft/world/item/Item.java"]);
  assert.equal(sameNamespace.envelope.result!.translatedQuery, undefined);
  assert.equal(sameNamespace.envelope.meta.warnings, undefined);
});

/** The catalog wording of each untranslated-query sentence, for the requests below. */
const UNTRANSLATED_CASES: ReadonlyArray<{
  name: string;
  id: string;
  request: Record<string, unknown>;
  message: string;
}> = [
  {
    name: "an artifact without a version",
    id: "search-query-no-version",
    request: { target: artifactTarget(VERSIONLESS_ARTIFACT.artifactId), query: "net.minecraft.world.level.Level", mapping: "mojang" },
    message:
      'mapping "mojang" was not applied to the query: the artifact has no version recorded, and translating a name needs one. ' +
      "The query was searched as given in obfuscated names."
  },
  {
    name: "a name the mappings do not hold",
    id: "search-query-not-found",
    request: { target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "com.mojang.MissingClass", mapping: "mojang" },
    message:
      'mapping "mojang" was not applied to the query: no obfuscated mapping was found for "com.mojang.MissingClass". The query was searched as given.'
  },
  {
    name: "a version without mapping data",
    id: "search-query-mapping-unavailable",
    request: {
      target: artifactTarget(UNMAPPED_VERSION_ARTIFACT.artifactId),
      query: "net.minecraft.world.level.Level",
      mapping: "mojang"
    },
    message: `mapping "mojang" was not applied to the query: mapping data is unavailable for version ${VERSION_WITHOUT_MAPPINGS}. The query was searched as given.`
  },
  {
    name: "a simple name",
    id: "search-query-not-qualified",
    request: { target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "Entity", mapping: "mojang" },
    message:
      'mapping "mojang" was not applied to the query: only a fully qualified class name is translated. ' +
      'The query was searched as given in obfuscated names. Find the fully qualified name of "Entity" with class-find or symbol-map first.'
  }
];

for (const { name, id, request, message } of UNTRANSLATED_CASES) {
  test(`a symbol search without hits is unavailable when the query could not be translated: ${name}`, async () => {
    const legacy = (await eightX("search-class-source", legacyRequest(request))).envelope;
    assert.deepEqual(legacy.result!.hits, []);
    assert.ok(
      (legacy.meta.warnings as string[]).some((warning) => serviceSentenceId(warning) === id),
      `positive control: the search service reports ${id}: ${JSON.stringify(legacy.meta.warnings)}`
    );

    const { envelope } = await search(request);
    assert.equal(envelope.result!.status, "unavailable");
    assert.deepEqual(envelope.result!.hits, []);
    assert.ok(messages(envelope).includes(message), `rewritten sentence: ${JSON.stringify(envelope.meta.warnings)}`);
    assert.equal(envelope.meta.nextActions, undefined);
  });
}

test("an untranslated query that still finds hits is ok, and only a symbol search without hits is unavailable", async () => {
  const withHit = await search({ target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "Level", mapping: "mojang" });
  assert.equal(withHit.envelope.result!.status, "ok");
  assert.deepEqual(withHit.envelope.result!.hits!.map((hit) => hit.filePath), ["d/LevelData.java"]);
  assert.ok(messages(withHit.envelope).some((entry) => entry.startsWith('mapping "mojang" was not applied to the query')));

  // The same versionless artifact with a text search: the service reports the
  // same sentence, but a text search matches the query as given anyway.
  const text = await search({
    target: artifactTarget(VERSIONLESS_ARTIFACT.artifactId),
    query: "net.minecraft.world.level.Level",
    intent: "text",
    mapping: "mojang"
  });
  assert.equal(text.envelope.result!.status, "not_found");
  assert.ok(messages(text.envelope).some((entry) => entry.includes("the artifact has no version recorded")), "positive control");

  const plain = await search({ target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "Entity" });
  assert.equal(plain.envelope.result!.status, "not_found", "no mapping, nothing to translate");
  assert.equal(plain.envelope.meta.warnings, undefined);

  const pathIntent = await search({ target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "zzz/", intent: "path", mapping: "mojang" });
  assert.equal(pathIntent.envelope.result!.status, "not_found");
  assert.ok(
    messages(pathIntent.envelope).includes(
      'mapping "mojang" does not apply with intent "path": path search matches the query as given against the artifact\'s obfuscated index. ' +
        'Use intent "symbol" with a fully qualified class name to translate it.'
    ),
    JSON.stringify(pathIntent.envelope.meta.warnings)
  );
});

/** Replaces the mapping lookup for one call; the replacement checks the request the search service sends. */
async function withMappingLookup<T>(outcome: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const original = mappingService.findMapping;
  const requests: Array<Record<string, unknown>> = [];
  mappingService.findMapping = async (input) => {
    requests.push(input);
    assert.equal(input.version, VERSION);
    assert.equal(input.kind, "class");
    assert.equal(input.sourceMapping, "mojang");
    assert.equal(input.targetMapping, "obfuscated");
    assert.equal(typeof input.name, "string");
    assert.ok((input.name as string).includes("."), "only a qualified name is looked up");
    return outcome();
  };
  try {
    const result = await run();
    assert.equal(requests.length, 2, "the 8.x search and source-search each looked the name up once");
    return result;
  } finally {
    mappingService.findMapping = original;
  }
}

const unresolved = (status: string, extra: Record<string, unknown> = {}) => async () => ({
  resolved: false,
  status,
  candidates: [],
  candidateCount: 0,
  warnings: [],
  querySymbol: { kind: "class", name: "com.mojang.Shared", symbol: "com.mojang.Shared" },
  mappingContext: { version: VERSION, sourceMapping: "mojang", targetMapping: "obfuscated", sourcePriorityApplied: "loom-first" },
  ...extra
});

for (const { name, id, outcome, message } of [
  {
    name: "an ambiguous name",
    id: "search-query-ambiguous",
    outcome: unresolved("ambiguous", { candidateCount: 2 }),
    message:
      'mapping "mojang" was not applied to the query: "com.mojang.Shared" maps to 2 classes. The query was searched as given. ' +
      "Use a more specific fully qualified class name, or list the candidates with symbol-map."
  },
  {
    name: "another lookup status",
    id: "search-query-untranslated",
    outcome: unresolved("unsupported"),
    message:
      'mapping "mojang" was not applied to the query: "com.mojang.Shared" could not be translated to obfuscated. The query was searched as given.'
  },
  {
    name: "a failed lookup",
    id: "search-query-translation-failed",
    outcome: async () => {
      throw new Error("mapping graph unreadable");
    },
    message: 'mapping "mojang" was not applied to the query: translation failed (mapping graph unreadable). The query was searched as given.'
  }
]) {
  test(`a symbol search without hits is unavailable when the mapping lookup gives ${name}`, async () => {
    const request = { target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "com.mojang.Shared", mapping: "mojang" };
    await withMappingLookup(outcome, async () => {
      const legacy = (await eightX("search-class-source", legacyRequest(request))).envelope;
      assert.ok(
        (legacy.meta.warnings as string[]).some((warning) => serviceSentenceId(warning) === id),
        `positive control: the search service reports ${id}: ${JSON.stringify(legacy.meta.warnings)}`
      );
      const { envelope } = await search(request);
      assert.equal(envelope.result!.status, "unavailable");
      assert.ok(messages(envelope).includes(message), JSON.stringify(envelope.meta.warnings));
    });
  });
}

test("an incomplete search is partial and names its limit in meta.truncation", async () => {
  const cases = [
    {
      request: { target: artifactTarget("search-window"), query: "windowhead windowtail", intent: "text" },
      limitedBy: "candidateWindow",
      sentence: /candidate window/
    },
    {
      request: { target: artifactTarget("search-window"), query: "zzz", intent: "path" },
      limitedBy: "candidateWindow",
      sentence: /candidate window/
    },
    {
      request: { target: artifactTarget(BUDGET_ARTIFACT.artifactId), query: "budgettoken", intent: "text", queryMode: "literal" },
      limitedBy: "scanBudget",
      sentence: /scan budget of 1024 bytes/
    }
  ];
  for (const { request, limitedBy, sentence } of cases) {
    const legacy = (await eightX("search-class-source", legacyRequest(request))).envelope;
    const serviceSentence = (legacy.meta.warnings as string[]).find((warning) => sentence.test(warning));
    assert.ok(serviceSentence, `positive control: the search service reports the cut: ${JSON.stringify(legacy.meta.warnings)}`);

    const { envelope } = await search(request);
    const label = `${request.intent} ${limitedBy}`;
    assert.equal(envelope.result!.status, "partial", label);
    assert.deepEqual(envelope.result!.hits, withoutRanking(legacy.result!.hits), label);
    assert.deepEqual(envelope.meta.truncation, [{ field: "hits", limitedBy }], label);
    assert.ok(messages(envelope).includes(serviceSentence), `${label}: the service sentence stays a warning`);
  }

  const budgetHits = await search(cases[2]!.request);
  assert.ok(budgetHits.envelope.result!.hits!.length > 0, "a cut scan keeps the hits it found");

  const complete = await search({ target: artifactTarget("search-window"), query: "windowhead", intent: "text", packagePrefix: "zzz" });
  assert.equal(complete.envelope.result!.status, "ok", "a scope inside the window is complete");
  assert.equal(complete.envelope.meta.truncation, undefined);
});

test("a symbol search cut at its candidate window is partial on the window's last page, even a full one", async () => {
  let request: Record<string, unknown> = { target: artifactTarget(SYMBOL_WINDOW_ARTIFACT.artifactId), query: "winSym", limit: 200 };
  const names: string[] = [];
  for (let page = 1; ; page += 1) {
    const { envelope } = await search(request);
    names.push(...envelope.result!.hits!.map((hit) => hit.symbol.symbolName as string));
    const next = envelope.meta.nextActions?.find((action) => action.params.cursor !== undefined);
    if (next === undefined) {
      assert.equal(page, 5, "five pages of 200 hold the window");
      assert.equal(envelope.result!.hits!.length, 200, "the last page of the window is full");
      assert.equal(envelope.result!.status, "partial");
      assert.deepEqual(envelope.meta.truncation, [{ field: "hits", limitedBy: "candidateWindow" }]);
      assert.ok(messages(envelope).some((message) => /^indexed symbol search examined only its candidate window \(the first 1000 matching symbols by name\)/.test(message)));
      break;
    }
    assert.equal(envelope.result!.status, "ok", `page ${page} has a next page`);
    assert.equal(envelope.meta.truncation, undefined);
    request = next.params;
  }
  assert.equal(names.length, 1000);
  assert.equal(names.includes("winSym1000"), false, "positive control: the symbol past the window is not returned");

  const complete = await search({ target: artifactTarget(SYMBOL_WINDOW_ARTIFACT.artifactId), query: "winSym099", limit: 200 });
  assert.equal(complete.envelope.result!.status, "ok", "a query whose matches fit the window is complete");
  assert.equal(complete.envelope.result!.hits!.length, 10);
  assert.equal(complete.envelope.meta.truncation, undefined);

  const legacy = (await eightX("search-class-source", legacyRequest({ target: artifactTarget(SYMBOL_WINDOW_ARTIFACT.artifactId), query: "winSym", limit: 200 }))).envelope;
  assert.ok(legacy.result!.nextCursor, "the first page of the cut search has a next page");
});

test("source-search rejects a token text search with a regular expression, which would run no search", async () => {
  const { envelope } = await search({ target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "get.*", intent: "text", queryMode: "token", match: "regex" });
  assert.equal(envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), ["queryMode"]);
  const symbolRegex = await search({ target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "Item.*", queryMode: "token", match: "regex" });
  assert.notEqual(symbolRegex.envelope.error?.code, "ERR_INVALID_INPUT", "queryMode does not shape a symbol search");
});

test("a text search without hits for a query with a separator offers the same search as a literal scan", async () => {
  const request = { target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "Stack.getCount", intent: "text" };
  const { envelope } = await search(request);
  assert.equal(envelope.result!.status, "not_found");
  const retry = {
    target: artifactTarget(MOJANG_ARTIFACT.artifactId),
    query: "Stack.getCount",
    intent: "text",
    match: "prefix",
    queryMode: "literal",
    limit: 20,
    detail: "standard"
  };
  assert.deepEqual(envelope.meta.nextActions, [
    {
      tool: "source-search",
      params: retry,
      reason: 'The index splits a query at ".", "_" and "$"; a literal scan matches the query as written.'
    }
  ]);

  const entry = (await eightX("inspect-minecraft", {
    task: "search",
    subject: {
      kind: "search",
      query: "Stack.getCount",
      intent: "text",
      artifact: { type: "resolved-id", artifactId: MOJANG_ARTIFACT.artifactId }
    }
  })).envelope.result!;
  assert.equal(entry.summary.status, "not_found");
  assert.ok(
    entry.summary.nextActions.some((action: { params: { subject?: { queryMode?: string } } }) => action.params.subject?.queryMode === "literal"),
    "positive control: the entry tool offers the literal retry"
  );

  const literal = await search(retry);
  const legacyLiteral = (await eightX("search-class-source", legacyRequest(retry))).envelope.result!;
  assert.equal(literal.envelope.result!.status, "ok");
  assert.deepEqual(literal.envelope.result!.hits, withoutRanking(legacyLiteral.hits));
  assert.deepEqual(literal.envelope.result!.hits!.map((hit) => hit.filePath), ["net/minecraft/world/item/Item.java"]);
  assert.equal(literal.envelope.meta.nextActions, undefined, "the literal scan is not offered again");

  for (const [label, other] of [
    ["a query without a separator", { ...request, query: "nosuchtoken" }],
    ["a token search", { ...request, queryMode: "token" }],
    ["a symbol search", { ...request, intent: "symbol" }],
    ["a path search", { ...request, intent: "path" }],
    // A regular expression already scans every file in auto mode.
    ["a regular expression", { ...request, query: "no\\.such_thing", match: "regex" }],
    // A literal scan skips the same files as the indexed one.
    ["a scope that matches no indexed path", { ...request, fileGlob: "data/**/*.json" }]
  ] as const) {
    const reply = await search(other);
    assert.equal(reply.envelope.result!.status, "not_found", label);
    assert.equal(reply.envelope.meta.nextActions, undefined, `${label}: no literal retry`);
  }
});

test("a server with indexed search switched off offers no literal retry, since every search already scans", async () => {
  const missing = { target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "No.such_thing", intent: "text" };
  const indexed = await search(missing);
  assert.equal(indexed.envelope.result!.status, "not_found");
  assert.equal(indexed.envelope.meta.nextActions?.[0]?.params.queryMode, "literal", "positive control: the indexed server offers it");

  const config = buildTestConfig(mkdtempSync(join(tmpdir(), "catalog-search-index-off-")), { indexedSearchEnabled: false });
  const service = new SourceService(config);
  seedIndexedArtifact(service, MOJANG_ARTIFACT);
  const runtime: CatalogRuntime = {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: config.sqlitePath,
    services: service,
    config
  };
  const run = async (args: Record<string, unknown>) =>
    JSON.parse(((await runCatalogTool(spec, args, runtime)).content[0] as { text: string }).text) as Envelope;

  const scanned = await run(missing);
  assert.equal(scanned.result!.status, "not_found");
  assert.equal(scanned.meta.nextActions, undefined);
  const found = await run({ ...missing, query: "Stack.getCount" });
  assert.deepEqual(
    found.result!.hits!.map((hit) => hit.filePath),
    ["net/minecraft/world/item/Item.java"],
    "without the index, auto mode scans every file and finds what the literal scan finds"
  );
});

test("a workspace whose sources omit net.minecraft warns, for a class-like query without a Minecraft hit, that class-find confirms it", async () => {
  const resolveRequests: Array<Record<string, any>> = [];
  const artifactOf: Record<string, string> = {
    "/workspace/mod-only": OBFUSCATED_ARTIFACT.artifactId,
    "/workspace/with-vanilla": MOJANG_ARTIFACT.artifactId
  };
  const services = {
    resolveArtifact: async (input: Record<string, any>) => {
      resolveRequests.push(input);
      assert.ok(["workspace", "version"].includes(input.target.kind), "a workspace or version target is resolved");
      return {
        artifactId: artifactOf[input.projectPath] ?? OBFUSCATED_ARTIFACT.artifactId,
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: "obfuscated",
        mappingApplied: "obfuscated",
        version: VERSION,
        provenance: { target: input.target, resolvedAt: "", resolvedFrom: { origin: "local-jar" }, transformChain: [] },
        qualityFlags: ["partial-source-no-net-minecraft"],
        artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "partial" },
        warnings: []
      };
    },
    searchClassSource: (input: Parameters<CatalogServices["searchClassSource"]>[0]) => searchService(input)
  } as unknown as CatalogServices;
  const runtime: CatalogRuntime = {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services,
    config: {} as CatalogRuntime["config"]
  };
  const run = async (args: Record<string, unknown>) =>
    JSON.parse(((await runCatalogTool(spec, args, runtime)).content[0] as { text: string }).text) as Envelope;
  const modOnly = { kind: "workspace", projectPath: "/workspace/mod-only" };
  const coverageWarning = {
    code: "source-coverage-partial",
    severity: "warning",
    message:
      "The workspace sources omit net.minecraft, so this search cannot find Minecraft classes; class-find confirms a Minecraft class in the binary jar."
  };

  const missing = await run({ target: modOnly, query: "Item" });
  assert.deepEqual(resolveRequests[0]!.target, { kind: "workspace" });
  assert.equal(resolveRequests[0]!.projectPath, "/workspace/mod-only");
  assert.equal(missing.result!.status, "not_found");
  assert.deepEqual(missing.meta.warnings, [coverageWarning]);

  const modHitOnly = await run({ target: modOnly, query: "LevelData" });
  assert.equal(modHitOnly.result!.status, "ok");
  assert.deepEqual(modHitOnly.result!.hits!.map((hit) => hit.filePath), ["d/LevelData.java"]);
  assert.deepEqual(modHitOnly.meta.warnings, [coverageWarning], "hits in mod classes only still get the warning");

  for (const [label, args] of [
    ["a text search for mod content", { target: modOnly, query: "registerModItems", intent: "text" }],
    ["a path search", { target: modOnly, query: "com/example/", intent: "path" }],
    ["a hit in the Minecraft namespace", { target: { kind: "workspace", projectPath: "/workspace/with-vanilla" }, query: "Item" }],
    ["a version target", { target: { kind: "version", version: VERSION }, query: "Item" }]
  ] as const) {
    const reply = await run(args);
    assert.equal(reply.meta.warnings, undefined, `${label}: no coverage warning`);
  }
});

test("the Jar-in-Jar shell warning names the catalog tools", async () => {
  const legacy = (await eightX("search-class-source", { artifactId: SHELL_ARTIFACT.artifactId, query: "Level", intent: "text" }))
    .envelope;
  const serviceWarning = (legacy.meta.warnings as string[]).find((warning) => warning.includes("Jar-in-Jar shell"));
  assert.ok(serviceWarning?.includes("find-class"), "positive control: the service names the 8.x tools");

  const { envelope } = await search({ target: artifactTarget(SHELL_ARTIFACT.artifactId), query: "Level", intent: "text" });
  assert.equal(envelope.result!.status, "unavailable", "a shell cannot show that a bundled class is absent");
  assert.deepEqual(messages(envelope), [translateToolNamesInText(serviceWarning, "source-search")]);
  assert.ok(messages(envelope)[0]!.includes("Use class-find on this artifact"));
  assert.ok(messages(envelope)[0]!.includes("source-read and member-list read a found class from its nested jar"));

  const ownClass = { target: artifactTarget(SHELL_WITH_OWN_CLASS.artifactId) };
  const found = await search({ ...ownClass, query: "Level" });
  assert.equal(found.envelope.result!.status, "ok", "a shell's own class is found");
  assert.ok(messages(found.envelope)[0]!.includes("It bundles 5 jars"), "positive control: the shell warning stays");
  const missing = await search({ ...ownClass, query: "Missing" });
  assert.equal(missing.envelope.result!.status, "unavailable");
  const plain = await search({ target: artifactTarget(OBFUSCATED_ARTIFACT.artifactId), query: "Missing" });
  assert.equal(plain.envelope.result!.status, "not_found", "an artifact that is no shell stays not_found");
});

test("source-search fails like search-class-source on an unknown artifact and an invalid regular expression", async () => {
  for (const [label, request] of [
    ["unknown artifact", { target: artifactTarget("no-such-artifact"), query: "Item" }],
    ["invalid regex", { target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "Item(", match: "regex" }],
    ["regex too long", { target: artifactTarget(MOJANG_ARTIFACT.artifactId), query: "a".repeat(201), match: "regex" }]
  ] as const) {
    const legacy = (await eightX("search-class-source", legacyRequest(request))).envelope.error!;
    const { envelope, isError } = await search(request);
    assert.equal(isError, true, label);
    for (const key of ["code", "retryClass", "issueOrigin"]) {
      assert.equal(envelope.error?.[key], legacy[key], `${label} ${key}`);
    }
  }
});

test("source-search validates its examples and rejects unknown, misspelled and misplaced keys", async () => {
  for (const example of spec.examples) {
    assert.equal(spec.inputSchema.safeParse(example).success, true, JSON.stringify(example));
    const reply = await search(example);
    assert.notEqual(reply.envelope.error?.detail, "Request validation failed.", `${JSON.stringify(example)} passes validation`);
  }
  const example = spec.examples[0]!;

  const unknownTop = await search({ ...example, bogusKey: 1 });
  assert.equal(unknownTop.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.ok(unknownTop.envelope.error?.fieldErrors?.some((entry) => entry.path === "bogusKey"));

  const unknownTarget = await search({ ...example, target: { ...(example.target as Record<string, unknown>), bogusKey: 1 } });
  assert.equal(unknownTarget.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.ok(unknownTarget.envelope.error?.fieldErrors?.some((entry) => entry.path === "target.bogusKey"));

  for (const [misspelled, declared] of [
    ["qeury", "query"],
    ["mapings", "mapping"],
    ["symbolKnd", "symbolKind"]
  ] as const) {
    const { query, ...rest } = example as Record<string, unknown>;
    const args = misspelled === "qeury" ? { ...rest, qeury: query } : { ...example, [misspelled]: "x" };
    const reply = await search(args);
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", misspelled);
    const entry = reply.envelope.error?.fieldErrors?.find((fieldError) => fieldError.path === misspelled);
    assert.ok(entry?.suggestions?.includes(declared), `"${misspelled}" suggests "${declared}": ${JSON.stringify(entry)}`);
  }

  // The 8.x inputs are unknown keys, not aliases.
  for (const retired of ["queryNamespace", "artifactId", "include", "sourcePriority"]) {
    const reply = envelopeOf(await session.callTool("source-search", { ...example, [retired]: "mojang" }));
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", retired);
    assert.ok(reply.envelope.error?.fieldErrors?.some((entry) => entry.path === retired), retired);
  }

  const mojang = artifactTarget(MOJANG_ARTIFACT.artifactId);
  const misplacedKind = await search({ ...example, intent: "text", symbolKind: "method" });
  assert.equal(misplacedKind.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(misplacedKind.envelope.error?.fieldErrors?.map((entry) => entry.path), ["symbolKind"]);
  const defaultIntent = await search({ target: mojang, query: "Item", symbolKind: "class" });
  assert.equal(defaultIntent.envelope.error, undefined, "symbolKind is accepted with the default symbol intent");
  assert.equal(defaultIntent.envelope.result!.status, "ok");

  const regexLimit = await search({ ...example, match: "regex", limit: 101 });
  assert.equal(regexLimit.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(regexLimit.envelope.error?.fieldErrors?.map((entry) => entry.path), ["limit"]);
  for (const accepted of [
    { match: "regex", limit: 100 },
    { limit: 200 },
    { limit: "50" }
  ]) {
    const reply = await search({ ...example, target: mojang, ...accepted });
    assert.equal(reply.envelope.error, undefined, JSON.stringify(accepted));
  }
  const overLimit = await search({ ...example, limit: 201 });
  assert.deepEqual(overLimit.envelope.error?.fieldErrors?.map((entry) => entry.path), ["limit"]);
  const blank = await search({ ...example, query: "   " });
  assert.deepEqual(blank.envelope.error?.fieldErrors?.map((entry) => entry.path), ["query"]);
});

test("mapping equal to the artifact's reported namespace translates nothing: misses are not_found without translation warnings", async () => {
  const target = artifactTarget(UNOBFUSCATED_ARTIFACT.artifactId);
  const miss = await search({ target, query: "NoSuchName", mapping: "mojang" });
  assert.equal(miss.envelope.result!.artifact.mappingApplied, "mojang", "the stored obfuscated label is reported as mojang");
  assert.equal(miss.envelope.result!.status, "not_found");
  assert.equal(miss.envelope.meta.warnings, undefined, "no not-qualified sentence");
  const legacyMiss = (await eightX("search-class-source", legacyRequest({ target, query: "NoSuchName", mapping: "mojang" }))).envelope;
  assert.ok(
    (legacyMiss.meta.warnings as string[]).some((warning) => serviceSentenceId(warning) === "search-query-not-qualified"),
    "positive control: the search service reports the query as untranslated"
  );

  const text = await search({ target, query: "Level", intent: "text", mapping: "mojang" });
  assert.equal(text.envelope.result!.status, "ok");
  assert.equal(text.envelope.meta.warnings, undefined, "no intent sentence");

  const dotted = await search({ target, query: "net.minecraft.world.level.Level", match: "exact", mapping: "mojang" });
  assert.equal(dotted.envelope.result!.status, "ok");
  assert.deepEqual(dotted.envelope.result!.hits!.map((hit) => hit.filePath), [LEVEL_PATH], "a dotted name is still split");

  const other = await search({ target, query: "NoSuchName", mapping: "intermediary" });
  assert.equal(other.envelope.result!.status, "unavailable", "another namespace stays unavailable");
  assert.ok(messages(other.envelope).some((entry) => entry.startsWith('mapping "intermediary" was not applied')));
});

test("a search for a query with angle brackets pages through its next-page call", async () => {
  const first = await search({ target: artifactTarget(GENERIC_ARTIFACT.artifactId), query: "List<ItemStack>", intent: "text", limit: 1 });
  assert.equal(first.envelope.result!.hits!.length, 1);
  assert.equal(first.envelope.meta.pagination?.hasMore, true);
  const next = first.envelope.meta.nextActions?.[0];
  assert.equal(next?.params.query, "List<ItemStack>", "the caller's query is repeated, not taken for a placeholder");
  const second = await search(next!.params);
  assert.equal(second.envelope.result!.hits!.length, 1);
  assert.notEqual(second.envelope.result!.hits![0]!.filePath, first.envelope.result!.hits![0]!.filePath);
  assert.equal(second.envelope.meta.warnings, undefined);

  // Positive control: a placeholder the producer introduced is still caught.
  const own = { ...next!, params: { ...next!.params, fileGlob: "<descriptor>" } };
  const strings = requestStringValues({ query: "List<ItemStack>" });
  assert.deepEqual(finalizeNextActions([next!], strings), [next], "the caller's string passes");
  assert.deepEqual(finalizeNextActions([own], strings), [], "a producer placeholder is dropped");
  assert.deepEqual(finalizeNextActions([next!]), [], "without the request strings the query reads as a placeholder");
});

test("an identity search with mapping pages through its next-page calls without losing the cursor", async () => {
  let args: Record<string, any> | undefined = {
    target: artifactTarget(MOJANG_ARTIFACT.artifactId),
    query: "net.minecraft.world.item.Item",
    mapping: "mojang",
    limit: 1
  };
  const seen: string[] = [];
  while (args !== undefined) {
    const { envelope } = await search(args);
    assert.equal(envelope.meta.warnings, undefined, "no cursor-ignored warning");
    seen.push(...envelope.result!.hits!.map((hit) => `${hit.filePath}#${hit.symbol?.symbolName}`));
    args = envelope.meta.nextActions?.[0]?.params;
    assert.ok(seen.length <= 10, "the pages end");
  }
  assert.deepEqual(seen.sort(), [
    "net/minecraft/world/item/Item.java#Item",
    "net/minecraft/world/item/ItemStack.java#ItemStack",
    "net/minecraft/world/item/Items.java#Items"
  ]);
});

test("an untranslated-query sentence is rewritten only as the whole text", () => {
  const sentence =
    'queryNamespace=mojang: no obfuscated mapping found for "com.mojang.Missing"; running literal search instead.';
  assert.equal(serviceSentenceId(sentence), "search-query-not-found");
  assert.equal(
    translateToolNamesInText(sentence, "source-search"),
    'mapping "mojang" was not applied to the query: no obfuscated mapping was found for "com.mojang.Missing". The query was searched as given.'
  );
  const embedded = `Earlier note. ${sentence}`;
  assert.equal(serviceSentenceId(embedded), undefined);
  assert.equal(translateToolNamesInText(embedded, "source-search"), embedded, "a sentence inside other text keeps its words");
});
