/**
 * Operations family (cache-manage, server-metrics) through the in-process MCP
 * session that serves the catalog and the 8.x tools side by side. Every 8.x
 * counterpart runs on the same cache through the same session.
 *
 * Fixtures: a temporary cache directory (MCP_CACHE_DIR) with real files in
 * the downloads, registry, decompiled-source, mod-remap and binary-remap
 * kinds, named with version tokens that keep each test's entries apart, and
 * artifact rows seeded into the server's own SQLite cache database. Nothing
 * reaches the network and no Java process runs.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { after, before } from "node:test";

import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { OPERATIONS_TOOL_SPECS } from "../../src/tools/families/operations.ts";
import { finalizeNextActions, requestStringValues } from "../../src/tools/next-actions.ts";
import { SERVICE_SENTENCE_REWRITES, translateToolNamesInText } from "../../src/tools/translation.ts";
import { withEnv } from "../helpers/env.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-operations-"));
const cacheDir = join(root, "cache");
const sqlitePath = join(cacheDir, "source-cache.db");
process.env.MCP_CACHE_DIR = cacheDir;
process.env.MCP_SQLITE_PATH = sqlitePath;

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

type Envelope = {
  result?: Record<string, any>;
  error?: Record<string, any> & { fieldErrors?: Array<Record<string, any>> };
  meta: Record<string, any> & {
    warnings?: Array<{ code: string; severity: string; message: string }>;
    nextActions?: Array<{ tool: string; params: Record<string, any>; reason?: string; template?: true }>;
    pagination?: { hasMore: boolean; nextCursor?: string };
  };
};

let session: CatalogSession;

/** Writes `content` at `path` under the cache directory, creating directories. */
function cacheFile(path: string, content: string): string {
  const full = join(cacheDir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

before(async () => {
  // Paging: three downloads of version 3.3.3.
  for (const name of ["p1", "p2", "p3"]) cacheFile(`downloads/${name}-3.3.3.jar`, `${name}-bytes`);
  // Delete parity: two sets with the same sizes, 5.5.1 and 5.5.2.
  for (const version of ["5.5.1", "5.5.2"]) {
    cacheFile(`downloads/lib-${version}.jar`, "library-jar");
    cacheFile(`remapped-mods/mod-${version}.jar`, "remapped");
    cacheFile(`decompiled/${version}/Example.java`, "class Example {}");
  }
  // Preview and its follow-up: version 6.6.1.
  cacheFile("downloads/preview-6.6.1.jar", "preview-jar");
  cacheFile("decompiled/6.6.1/Preview.java", "class Preview {}");
  // Verify: one valid and one corrupt registry report.
  cacheFile("registries/4.4.4/registries.json", "{");
  cacheFile("registries/4.4.5/registries.json", "{}");
  // A corrupt binary-remap entry: a directory where a jar belongs.
  cacheFile("remapped/broken-artifact.jar/leftover.class", "partial");

  session = await startCatalogSession(CATALOG_TOOL_SPECS);
  const { sourceService } = await import("../../src/index.ts");
  const binaryJar = cacheFile("jars/with-binary-9.0.1.jar", "binary");
  for (const [artifactId, binaryJarPath] of [
    ["art-with-binary", binaryJar],
    ["art-no-binary", undefined],
    ["art-delete", undefined]
  ] as const) {
    seedIndexedArtifact(sourceService, {
      artifactId,
      origin: "local-jar",
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      qualityFlags: [],
      version: "9.0.1",
      ...(binaryJarPath !== undefined ? { binaryJarPath } : {}),
      files: [{ filePath: "com/example/Probe.java", content: "package com.example;\npublic class Probe {}\n" }],
      symbols: [
        { filePath: "com/example/Probe.java", symbolKind: "class", symbolName: "Probe", qualifiedName: "com.example.Probe", line: 2 }
      ]
    });
  }
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
 * The reply text without the tool names server-metrics reports as data: its
 * per-tool counters are keyed by the name each call was made under, 8.x
 * names included.
 */
function textWithoutCounterNames(name: string, envelope: Envelope, text: string): string {
  const metrics = envelope.result?.metrics;
  if (name !== "server-metrics" || metrics === undefined) return text;
  return JSON.stringify({
    ...envelope,
    result: {
      metrics: {
        ...metrics,
        tool_call_counts: Object.values(metrics.tool_call_counts),
        tool_call_duration_ms: Object.values(metrics.tool_call_duration_ms)
      }
    }
  });
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
  assert.doesNotMatch(
    textWithoutCounterNames(name, reply.envelope, reply.text),
    ALIAS_NAME_PATTERN,
    `no 8.x tool name in the ${name} reply: ${reply.text}`
  );
  assert.equal(reply.text.includes(FALLBACK_SENTENCE), false);
  for (const action of reply.envelope.meta.nextActions ?? []) {
    assert.ok(CATALOG_TOOL_SPECS.some((spec) => spec.name === action.tool), `${action.tool} is a catalog tool`);
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

async function eightX(name: string, args: unknown) {
  return envelopeOf(await session.callTool(name, args));
}

/** Every file under the cache directory except the database, with its size and modification time. */
function cacheFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (!entry.name.startsWith("source-cache.db")) {
        const stats = statSync(full);
        files.push(`${relative(cacheDir, full)} ${stats.size} ${stats.mtimeMs}`);
      }
    }
  };
  walk(cacheDir);
  return files.sort();
}

/** The artifact ids the index holds, read through the 8.x listing. */
async function indexedArtifacts(): Promise<string[]> {
  const listed = await eightX("manage-cache", { action: "list", cacheKinds: ["artifact-index"], detail: "standard" });
  return (listed.envelope.result!.cacheEntries as Array<{ entryId: string }>).map((entry) => entry.entryId).sort();
}

// ---------------------------------------------------------------------------
// cache-manage: summary, list, verify
// ---------------------------------------------------------------------------

test("cache-manage summary returns the per-kind counts, sizes and health of manage-cache, with totals", async () => {
  for (const cacheKinds of [undefined, ["downloads", "decompiled-source"], ["artifact-index"]]) {
    const request = { action: "summary", ...(cacheKinds !== undefined ? { cacheKinds } : {}) };
    const legacy = (await eightX("manage-cache", { ...request, detail: "standard" })).envelope.result!;
    const { envelope, isError } = await catalog("cache-manage", request);
    assert.equal(isError, false, JSON.stringify(envelope.error));
    const cache = envelope.result!.cache;
    assert.deepEqual(cache.kinds, legacy.stats, `${JSON.stringify(cacheKinds)}: the same per-kind stats`);
    assert.equal(cache.entryCount, legacy.summary.counts.entries);
    assert.equal(cache.totalBytes, legacy.summary.counts.bytes);
    assert.equal(cache.action, "summary");
  }
  const downloads = (await catalog("cache-manage", { action: "summary", cacheKinds: ["downloads"] })).envelope.result!.cache;
  assert.ok(downloads.entryCount >= 6, "positive control: the downloads fixtures are counted");
});

test("cache-manage summary is partial only for unhealthy entries, not for an empty kind", async () => {
  const empty = await catalog("cache-manage", { action: "summary", cacheKinds: ["downloads", "nested-jar"] });
  assert.equal(empty.envelope.result!.cache.kinds["nested-jar"].entryCount, 0);
  assert.equal(empty.envelope.result!.cache.kinds["nested-jar"].status, "partial", "the registry's health of an empty kind");
  assert.equal(empty.envelope.result!.cache.status, "ok", "an empty kind leaves the call ok");
  const legacy = (await eightX("manage-cache", { action: "summary", cacheKinds: ["downloads", "nested-jar"] })).envelope.result!;
  assert.equal(legacy.summary.status, "partial", "positive control: manage-cache called the same cache partial");

  const corrupt = await catalog("cache-manage", { action: "summary", cacheKinds: ["binary-remap"] });
  assert.equal(corrupt.envelope.result!.cache.kinds["binary-remap"].status, "corrupt");
  assert.equal(corrupt.envelope.result!.cache.status, "partial");
});

test("cache-manage list returns the entries of manage-cache with a page cursor and one next-page call", async () => {
  const selector = { version: "3.3.3" };
  const legacyFirst = (await eightX("manage-cache", { action: "list", cacheKinds: ["downloads"], selector, limit: 2, detail: "standard" })).envelope;
  const first = await catalog("cache-manage", { action: "list", cacheKinds: ["downloads"], selector, limit: "2" });
  assert.equal(first.isError, false, JSON.stringify(first.envelope.error));
  assert.deepEqual(first.envelope.result!.cache.entries, legacyFirst.result!.cacheEntries, "the same entries");
  assert.deepEqual(
    first.envelope.result!.cache.entries.map((entry: { entryId: string }) => entry.entryId),
    ["p1-3.3.3.jar", "p2-3.3.3.jar"]
  );
  assert.equal(first.envelope.result!.cache.status, "ok");
  assert.deepEqual(first.envelope.meta.pagination, { hasMore: true, nextCursor: legacyFirst.meta.pagination.nextCursor });
  assert.deepEqual(first.envelope.meta.nextActions, [
    {
      tool: "cache-manage",
      params: { action: "list", cacheKinds: ["downloads"], selector, limit: 2, cursor: legacyFirst.meta.pagination.nextCursor },
      reason: "List the next page."
    }
  ]);

  const next = first.envelope.meta.nextActions![0]!;
  const second = await catalog(next.tool, next.params);
  const legacySecond = (await eightX("manage-cache", {
    action: "list",
    cacheKinds: ["downloads"],
    selector,
    limit: 2,
    cursor: legacyFirst.meta.pagination.nextCursor,
    detail: "standard"
  })).envelope;
  assert.deepEqual(second.envelope.result!.cache.entries, legacySecond.result!.cacheEntries);
  assert.deepEqual(second.envelope.result!.cache.entries.map((entry: { entryId: string }) => entry.entryId), ["p3-3.3.3.jar"]);
  assert.deepEqual(second.envelope.meta.pagination, { hasMore: false });
  assert.equal(second.envelope.meta.nextActions, undefined, "the last page offers no further page");

  const inspected = (await eightX("manage-cache", { action: "inspect", cacheKinds: ["downloads"], selector, limit: 2, detail: "standard" })).envelope;
  assert.deepEqual(first.envelope.result!.cache.entries, inspected.result!.cacheEntries, "manage-cache inspect is the first list page");
});

test("cache-manage list returns entries at every call, uses 50 entries per page by default, and an empty listing is ok", async () => {
  const listed = await catalog("cache-manage", { action: "list", cacheKinds: ["downloads"] });
  assert.ok(listed.envelope.result!.cache.entries.length >= 6, "the default page holds every downloads fixture");
  assert.deepEqual(listed.envelope.meta.pagination, { hasMore: false });
  const legacyDefault = (await eightX("manage-cache", { action: "list", cacheKinds: ["downloads"] })).envelope.result!;
  assert.equal("cacheEntries" in legacyDefault, false, "positive control: manage-cache hides the entries at its default detail");

  for (let index = 0; index < 51; index += 1) cacheFile(`decompiled/7.0.${index}/Many${index}.java`, "x");
  const many = await catalog("cache-manage", { action: "list", cacheKinds: ["decompiled-source"] });
  assert.equal(many.envelope.result!.cache.entries.length, 50, "the default limit is 50");
  assert.equal(many.envelope.meta.pagination?.hasMore, true);
  assert.equal(many.envelope.meta.nextActions?.[0]?.params.limit, undefined, "an omitted limit stays omitted");

  const none = await catalog("cache-manage", { action: "list", selector: { version: "0.0.404" } });
  assert.equal(none.isError, false);
  assert.deepEqual(none.envelope.result, { cache: { action: "list", status: "ok", entries: [] } });
  assert.deepEqual(none.envelope.meta.pagination, { hasMore: false });
});

test("cache-manage list is partial when a listed entry is unhealthy", async () => {
  const { envelope } = await catalog("cache-manage", { action: "list", cacheKinds: ["binary-remap"] });
  assert.equal(envelope.result!.cache.status, "partial");
  assert.equal(envelope.result!.cache.entries[0].status, "corrupt");
  assert.equal(envelope.result!.cache.entries[0].meta.artifactId, "broken-artifact");
});

test("cache-manage verify returns the checked and unhealthy counts of manage-cache and its warning", async () => {
  const legacy = (await eightX("manage-cache", { action: "verify", cacheKinds: ["registry"] })).envelope;
  const { envelope, isError } = await catalog("cache-manage", { action: "verify", cacheKinds: ["registry"] });
  assert.equal(isError, false);
  assert.deepEqual(envelope.result, {
    cache: {
      action: "verify",
      status: "partial",
      checkedEntries: legacy.result!.summary.counts.checkedEntries,
      unhealthyEntries: legacy.result!.summary.counts.unhealthyEntries
    }
  });
  assert.deepEqual([envelope.result!.cache.checkedEntries, envelope.result!.cache.unhealthyEntries], [2, 1]);
  assert.deepEqual(
    envelope.meta.warnings?.map((warning) => warning.message),
    ["Detected cache entries with health states: corrupt."]
  );

  const healthy = await catalog("cache-manage", { action: "verify", cacheKinds: ["registry"], selector: { version: "4.4.5" } });
  assert.deepEqual(healthy.envelope.result!.cache, { action: "verify", status: "ok", checkedEntries: 1, unhealthyEntries: 0 });
  assert.equal(healthy.envelope.meta.warnings, undefined);
});

// ---------------------------------------------------------------------------
// cache-manage: delete
// ---------------------------------------------------------------------------

test("cache-manage delete previews without writing and offers exactly the apply call, which deletes the selected entries", async () => {
  const selector = { version: "6.6.1" };
  const before = cacheFiles();
  const preview = await catalog("cache-manage", { action: "delete", selector });
  assert.equal(preview.isError, false, JSON.stringify(preview.envelope.error));
  assert.deepEqual(preview.envelope.result, {
    cache: { action: "delete", status: "ok", applied: false, deletedEntries: 2, deletedBytes: "preview-jar".length + "class Preview {}".length }
  });
  assert.deepEqual(cacheFiles(), before, "the preview wrote nothing");
  assert.deepEqual(preview.envelope.meta.nextActions, [
    {
      tool: "cache-manage",
      params: { action: "delete", selector, apply: true },
      reason: `Delete the 2 matching entries (${"preview-jar".length + "class Preview {}".length} bytes).`
    }
  ]);

  const next = preview.envelope.meta.nextActions![0]!;
  const applied = await catalog(next.tool, next.params);
  assert.deepEqual(applied.envelope.result, { cache: { ...preview.envelope.result!.cache, applied: true } });
  assert.equal(applied.envelope.meta.nextActions, undefined, "an apply offers no further call");
  const gone = before.filter((line) => !cacheFiles().includes(line));
  assert.deepEqual(
    gone.map((line) => line.split(" ")[0]).sort(),
    [join("decompiled", "6.6.1", "Preview.java"), join("downloads", "preview-6.6.1.jar")].sort(),
    "exactly the selected entries were deleted"
  );
});

test("cache-manage delete offers the apply call for an entry whose name holds angle brackets", async () => {
  cacheFile("downloads/angle-<v>-7.7.1.jar", "angle-jar");
  const selector = { entryId: "angle-<v>-7.7.1.jar" };
  const preview = await catalog("cache-manage", { action: "delete", cacheKinds: ["downloads"], selector });
  assert.equal(preview.envelope.result!.cache.deletedEntries, 1, "positive control: the preview finds the entry");
  assert.deepEqual(preview.envelope.meta.nextActions?.map((action) => action.params), [
    { action: "delete", cacheKinds: ["downloads"], selector, apply: true }
  ], "the entry id the caller sent is repeated, not taken for a placeholder");
  const next = preview.envelope.meta.nextActions![0]!;
  const applied = await catalog(next.tool, next.params);
  assert.equal(applied.envelope.result!.cache.deletedEntries, 1);
  assert.equal(existsSync(join(cacheDir, "downloads", "angle-<v>-7.7.1.jar")), false, "the apply deleted it");
});

test("cache-manage delete removes artifact index rows only on apply", async () => {
  const request = { action: "delete", cacheKinds: ["artifact-index"], selector: { artifactId: "art-delete" } };
  const preview = await catalog("cache-manage", request);
  assert.equal(preview.envelope.result!.cache.deletedEntries, 1);
  assert.ok((await indexedArtifacts()).includes("art-delete"), "the preview kept the row");
  const applied = await catalog("cache-manage", { ...request, apply: true });
  assert.equal(applied.envelope.result!.cache.deletedEntries, 1);
  assert.deepEqual(await indexedArtifacts(), ["art-no-binary", "art-with-binary"], "exactly the selected row was deleted");
});

test("cache-manage delete counts and deletes what manage-cache delete and prune do", async () => {
  const kinds = ["downloads", "mod-remap", "decompiled-source"];
  const legacyPreview = (await eightX("manage-cache", { action: "delete", cacheKinds: kinds, selector: { version: "5.5.2" } })).envelope.result!;
  const preview = (await catalog("cache-manage", { action: "delete", cacheKinds: kinds, selector: { version: "5.5.1" } })).envelope.result!;
  assert.equal(preview.cache.deletedEntries, legacyPreview.summary.counts.deletedEntries);
  assert.equal(preview.cache.deletedBytes, legacyPreview.summary.counts.deletedBytes);
  assert.equal(preview.cache.deletedEntries, 3, "positive control: the three files of the set");

  const before = cacheFiles();
  const legacyApply = (await eightX("manage-cache", {
    action: "prune",
    cacheKinds: kinds,
    selector: { version: "5.5.2" },
    executionMode: "apply"
  })).envelope.result!;
  const applied = (await catalog("cache-manage", { action: "delete", cacheKinds: kinds, selector: { version: "5.5.1" }, apply: true })).envelope.result!;
  assert.deepEqual(
    [applied.cache.deletedEntries, applied.cache.deletedBytes],
    [legacyApply.summary.counts.deletedEntries, legacyApply.summary.counts.deletedBytes]
  );
  const removed = before.filter((line) => !cacheFiles().includes(line)).map((line) => line.split(" ")[0]!.replaceAll("5.5.2", "5.5.x").replaceAll("5.5.1", "5.5.x"));
  assert.deepEqual(removed.sort(), [
    join("decompiled", "5.5.x", "Example.java"),
    join("decompiled", "5.5.x", "Example.java"),
    join("downloads", "lib-5.5.x.jar"),
    join("downloads", "lib-5.5.x.jar"),
    join("remapped-mods", "mod-5.5.x.jar"),
    join("remapped-mods", "mod-5.5.x.jar")
  ], "each tool deleted its own set and nothing else");
});

test("cache-manage delete that matches nothing is ok with zero counts and no follow-up", async () => {
  for (const apply of [false, true]) {
    const { envelope } = await catalog("cache-manage", { action: "delete", selector: { version: "0.0.404" }, apply });
    assert.deepEqual(envelope.result, { cache: { action: "delete", status: "ok", applied: apply, deletedEntries: 0, deletedBytes: 0 } });
    assert.equal(envelope.meta.nextActions, undefined);
  }
});

test(
  "cache-manage delete is partial when an apply cannot delete an entry",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const locked = cacheFile("downloads/locked/held-8.8.1.jar", "held-bytes");
    cacheFile("downloads/free-8.8.1.jar", "free-bytes");
    chmodSync(join(cacheDir, "downloads", "locked"), 0o555);
    try {
      const { envelope } = await catalog("cache-manage", {
        action: "delete",
        cacheKinds: ["downloads"],
        selector: { version: "8.8.1" },
        apply: true
      });
      assert.deepEqual(envelope.result, {
        cache: { action: "delete", status: "partial", applied: true, deletedEntries: 1, deletedBytes: "free-bytes".length }
      });
      assert.equal(existsSync(locked), true);
      assert.equal(envelope.meta.warnings?.length, 1);
      assert.ok(envelope.meta.warnings![0]!.message.includes(locked), "the warning names the entry left behind");
    } finally {
      chmodSync(join(cacheDir, "downloads", "locked"), 0o755);
    }
  }
);

test(
  "cache-manage delete fails with ERR_INTERNAL when an apply cannot remove a file other than a cached download",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const removable = cacheFile("decompiled/8.9.1/Removable.java", "class Removable {}");
    const locked = cacheFile("remapped-mods/locked/held-8.9.1.jar", "held");
    chmodSync(join(cacheDir, "remapped-mods", "locked"), 0o555);
    try {
      const { envelope, isError } = await catalog("cache-manage", {
        action: "delete",
        cacheKinds: ["decompiled-source", "mod-remap"],
        selector: { version: "8.9.1" },
        apply: true
      });
      assert.equal(isError, true);
      assert.equal(envelope.error?.code, "ERR_INTERNAL");
      assert.equal(existsSync(removable), false, "the entry listed before it was removed");
      assert.equal(existsSync(locked), true);
    } finally {
      chmodSync(join(cacheDir, "remapped-mods", "locked"), 0o755);
    }
  }
);

test("cache-manage refuses apply outside delete, a delete without a selector, and paging outside list, writing nothing", async () => {
  const before = cacheFiles();
  const rejected: Array<[Record<string, unknown>, string[]]> = [
    [{ action: "summary", apply: true }, ["apply"]],
    [{ action: "list", apply: false }, ["apply"]],
    [{ action: "verify", apply: true }, ["apply"]],
    [{ action: "delete" }, ["selector"]],
    [{ action: "delete", apply: true }, ["selector"]],
    [{ action: "delete", selector: {} }, ["selector"]],
    [{ action: "delete", selector: {}, apply: true }, ["selector"]],
    [{ action: "delete", cacheKinds: ["downloads"], apply: true }, ["selector"]],
    [{ action: "summary", limit: 5 }, ["limit"]],
    [{ action: "delete", selector: { version: "6.6.1" }, cursor: "abc" }, ["cursor"]],
    [{ action: "list", cacheKinds: [] }, ["cacheKinds"]],
    [{ action: "list", selector: { mapping: "official" } }, ["selector.mapping"]],
    [{ action: "list", selector: { scope: "client" } }, ["selector.scope"]],
    [{ action: "list", selector: { status: "broken" } }, ["selector.status"]],
    [{ action: "inspect" }, ["action"]],
    [{ action: "prune", selector: { version: "6.6.1" } }, ["action"]],
    [{ action: "delete", selector: { version: "6.6.1" }, executionMode: "apply" }, ["executionMode"]],
    [{ action: "list", include: ["cacheEntries"] }, ["include"]],
    [{ action: "list", detail: "full" }, ["detail"]]
  ];
  for (const [request, paths] of rejected) {
    const { envelope, isError } = await catalog("cache-manage", request);
    assert.equal(isError, true, JSON.stringify(request));
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT", JSON.stringify(request));
    assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path).sort(), paths, JSON.stringify(request));
  }
  assert.deepEqual(cacheFiles(), before, "no refused call wrote anything");
  const accepted = await catalog("cache-manage", { action: "delete", cacheKinds: ["downloads"], selector: { version: "0.0.404" }, apply: false });
  assert.equal(accepted.isError, false, "positive control: apply: false with a selector is accepted on delete");
});

test("cache-manage refuses a selector path that names the file system root, in every action", async () => {
  const before = cacheFiles();
  const rootSpellings = ["/", "///", "\\", "\\\\"];
  for (const action of ["summary", "list", "verify", "delete"]) {
    for (const key of ["jarPath", "projectPath"]) {
      for (const path of rootSpellings) {
        for (const apply of action === "delete" ? [false, true] : [undefined]) {
          const request = { action, selector: { [key]: path }, ...(apply !== undefined ? { apply } : {}) };
          const { envelope } = await catalog("cache-manage", request);
          assert.equal(envelope.error?.code, "ERR_INVALID_INPUT", JSON.stringify(request));
          assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), [`selector.${key}`], JSON.stringify(request));
        }
      }
    }
  }
  assert.deepEqual(cacheFiles(), before, "no refused call wrote anything");

  const legacy = (await eightX("manage-cache", { action: "delete", selector: { jarPath: "/" } })).envelope.result!;
  assert.ok(legacy.summary.counts.deletedEntries > 10, "positive control: the registry reads the root as every entry");

  for (const [key, path] of [["jarPath", "/x.jar"], ["projectPath", join(cacheDir, "downloads")]] as const) {
    const preview = await catalog("cache-manage", { action: "delete", selector: { [key]: path } });
    assert.equal(preview.isError, false, `${key} ${path} is accepted: ${JSON.stringify(preview.envelope.error)}`);
  }
  const underDownloads = await catalog("cache-manage", { action: "list", selector: { projectPath: join(cacheDir, "downloads") } });
  assert.ok(underDownloads.envelope.result!.cache.entries.length > 0, "a real directory still selects the entries under it");
  assert.ok(
    underDownloads.envelope.result!.cache.entries.every((entry: { path: string }) => entry.path.startsWith(join(cacheDir, "downloads"))),
    "and only those"
  );
});

test(
  "cache-manage refuses the WSL root spelling of a selector path",
  { skip: process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host" },
  async () => {
    await withEnv({ WSL_DISTRO_NAME: "catalog-distro" }, async () => {
      const { envelope } = await catalog("cache-manage", { action: "delete", selector: { jarPath: "\\\\wsl.localhost\\catalog-distro\\" } });
      assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), ["selector.jarPath"]);
      const below = await catalog("cache-manage", { action: "list", selector: { jarPath: "\\\\wsl.localhost\\catalog-distro\\x.jar" } });
      assert.equal(below.isError, false, "positive control: a path below the root is accepted");
    });
  }
);

test("cache-manage fails like manage-cache on an invalid olderThan and an invalid cursor", async () => {
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ action: "list", selector: { olderThan: "30 days" } }, { action: "list", selector: { olderThan: "30 days" } }],
    [{ action: "list", cursor: "not-a-cursor" }, { action: "list", cursor: "not-a-cursor" }]
  ];
  for (const [request, legacyRequest] of cases) {
    const legacy = (await eightX("manage-cache", legacyRequest)).envelope.error;
    const { envelope } = await catalog("cache-manage", request);
    assert.ok(legacy, "positive control: manage-cache refuses it");
    for (const key of ["code", "retryClass", "issueOrigin", "detail"]) {
      assert.equal(envelope.error?.[key], legacy?.[key], `${JSON.stringify(request)}: ${key}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The binary-jar hint names cache-manage
// ---------------------------------------------------------------------------

const SERVICE_HINT_TAIL =
  'call manage-cache with action="inspect", selector: { artifactId: ... } and include: ["cacheEntries"]';

test("a member read of an artifact without a binary jar points at a cache-manage listing that works", async () => {
  const legacy = (await eightX("get-class-members", {
    target: { kind: "artifact", artifactId: "art-no-binary" },
    className: "com.example.Probe"
  })).envelope;
  assert.ok(
    legacy.error?.hints?.some((hint: string) => hint.includes(SERVICE_HINT_TAIL)),
    "positive control: the service hint names manage-cache with include"
  );

  const { envelope, text } = await catalog("member-list", {
    target: { kind: "artifact", artifactId: "art-no-binary" },
    classes: ["com.example.Probe"]
  });
  const item = envelope.result!.items[0];
  assert.equal(item.error.code, "ERR_CONTEXT_UNRESOLVED");
  const hint = item.error.hints.join(" ");
  assert.ok(
    hint.includes(
      'To tell whether an artifact carries one, call cache-manage with action: "list", cacheKinds: ["artifact-index"] and selector: { artifactId: ... }: ' +
        "the listed entry reports meta.binaryJarPath from the artifact's stored row - the same row this lookup reads - and omits it when the row has none."
    ),
    hint
  );
  assert.equal(text.includes("include"), false, "the hint names no include");
  assert.equal(text.includes("inspect"), false, "nor the inspect action");

  const without = await catalog("cache-manage", { action: "list", cacheKinds: ["artifact-index"], selector: { artifactId: "art-no-binary" } });
  const listedWithout = JSON.parse(without.text).result.cache.entries;
  assert.equal(listedWithout.length, 1);
  assert.equal("binaryJarPath" in listedWithout[0].meta, false, "no binary jar, no field in the reply");
  const withJar = await catalog("cache-manage", { action: "list", cacheKinds: ["artifact-index"], selector: { artifactId: "art-with-binary" } });
  assert.equal(withJar.envelope.result!.cache.entries[0].meta.binaryJarPath, join(cacheDir, "jars", "with-binary-9.0.1.jar"));
});

test("only the whole known service sentence is reworded; other text keeps its words", () => {
  const sentence = SERVICE_SENTENCE_REWRITES.find((entry) => entry.id === "member-binary-jar");
  assert.ok(sentence !== undefined && "service" in sentence, "the member lookup sentence is a fixed sentence");
  const prefix = "Resolve with a jar target or use an artifact that has a binary jar. ";
  assert.equal(translateToolNamesInText(prefix + sentence.service, "member-list"), prefix + sentence.catalog);
  const altered = sentence.service.replace("The include is required: ", "");
  assert.equal(
    translateToolNamesInText(altered, "member-list"),
    altered.replaceAll("manage-cache", "cache-manage"),
    "a sentence that is not known word for word only has its tool names replaced"
  );
});

// ---------------------------------------------------------------------------
// server-metrics
// ---------------------------------------------------------------------------

/** The snapshot without one tool's call count and duration. */
function withoutTool(metrics: Record<string, any>, tool: string): Record<string, any> {
  const { [tool]: _count, ...counts } = metrics.tool_call_counts;
  const { [tool]: _duration, ...durations } = metrics.tool_call_duration_ms;
  return { ...metrics, tool_call_counts: counts, tool_call_duration_ms: durations };
}

test("server-metrics returns the get-runtime-metrics snapshot, with catalog tools in the call counts", async () => {
  await catalog("cache-manage", { action: "summary", cacheKinds: ["downloads"] });
  const legacy = (await eightX("get-runtime-metrics", {})).envelope.result!;
  const { envelope, isError } = await catalog("server-metrics", {});
  assert.equal(isError, false);
  assert.deepEqual(Object.keys(envelope.result!), ["metrics"]);
  const metrics = envelope.result!.metrics;
  // Between the two snapshots only the get-runtime-metrics call itself was recorded.
  assert.deepEqual(withoutTool(metrics, "get-runtime-metrics"), withoutTool(legacy, "get-runtime-metrics"), "the same snapshot");
  assert.equal(metrics.tool_call_counts["get-runtime-metrics"], (legacy.tool_call_counts["get-runtime-metrics"] ?? 0) + 1);
  assert.equal(
    metrics.tool_call_duration_ms["get-runtime-metrics"].count,
    (legacy.tool_call_duration_ms["get-runtime-metrics"]?.count ?? 0) + 1
  );
  assert.ok(metrics.tool_call_counts["cache-manage"] >= 1, "a catalog tool is counted under its own name");
  assert.ok(metrics.tool_call_counts["manage-cache"] >= 1, "an 8.x tool is counted under its 8.x name, as data");

  const again = await catalog("server-metrics", {});
  assert.deepEqual(withoutTool(again.envelope.result!.metrics, "server-metrics"), withoutTool(metrics, "server-metrics"));
  assert.equal(again.envelope.result!.metrics.tool_call_counts["server-metrics"], (metrics.tool_call_counts["server-metrics"] ?? 0) + 1);
});

test("server-metrics rejects any input key, which get-runtime-metrics ignored", async () => {
  const legacy = await eightX("get-runtime-metrics", { verbose: true });
  assert.equal(legacy.isError, false, "positive control: the 8.x tool ignores the key");
  const { envelope, isError } = await catalog("server-metrics", { verbose: true });
  assert.equal(isError, true);
  assert.equal(envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), ["verbose"]);
});

// ---------------------------------------------------------------------------
// Strict input and listing
// ---------------------------------------------------------------------------

test("every operations tool validates its examples and rejects unknown and misspelled keys", async () => {
  const before = cacheFiles();
  for (const spec of OPERATIONS_TOOL_SPECS) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
      const reply = await catalog(spec.name, example);
      assert.equal(reply.isError, false, `${spec.name} example runs: ${JSON.stringify(reply.envelope.error)}`);
    }
    const example = spec.examples[spec.examples.length - 1]! as Record<string, unknown>;
    const unknownTop = await catalog(spec.name, { ...example, bogusKey: 1 });
    assert.equal(unknownTop.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(unknownTop.envelope.error?.fieldErrors?.map((entry) => entry.path), ["bogusKey"], spec.name);
  }
  assert.deepEqual(cacheFiles(), before, "the examples preview without writing");

  const nearMiss = await catalog("cache-manage", { action: "list", cacheKind: ["downloads"] });
  assert.ok(
    nearMiss.envelope.error?.fieldErrors?.find((entry) => entry.path === "cacheKind")?.suggestions?.includes("cacheKinds")
  );
  const selectorKey = await catalog("cache-manage", { action: "list", selector: { artifctId: "a" } });
  assert.deepEqual(selectorKey.envelope.error?.fieldErrors?.map((entry) => entry.path), ["selector.artifctId"]);
  assert.ok(selectorKey.envelope.error?.fieldErrors?.[0]?.suggestions?.includes("artifactId"));
});

test("cache-manage is listed as a destructive writer and server-metrics as a read-only, closed-world tool", async () => {
  const listed = new Map((await session.listTools()).map((tool) => [tool.name, tool]));
  assert.deepEqual(listed.get("cache-manage")?.annotations, { readOnlyHint: false, destructiveHint: true });
  assert.deepEqual(listed.get("server-metrics")?.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(listed.get("server-metrics")?.inputSchema, { type: "object", properties: {}, additionalProperties: false });
});
