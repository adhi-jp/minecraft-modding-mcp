/**
 * Comparison family (version-compare, class-diff, registry-read) through the
 * in-process MCP session that serves the catalog and the 8.x tools side by
 * side. Every 8.x counterpart runs on the same fixtures through the same
 * session; only the I/O boundaries are stubbed (every other URL is a 404;
 * nothing reaches the network).
 *
 * Fixtures per tool:
 *  - version-compare: a stubbed Mojang manifest whose version documents name
 *    a client jar and a library list; client jars built from class files with
 *    packaged names, so no mapping is loaded (the local-jar fixtures of
 *    tests/runtime/version-diff-service.test.ts); registries.json snapshots
 *    seeded in the registry cache (as tests/runtime/registry-service.test.ts
 *    seeds them); 1.21.8 has a client jar but no seeded registries and no
 *    server download, so its registry comparison fails; 9.9.1 and 9.9.2 have
 *    seeded registries but are missing from the manifest, so their library
 *    lists cannot be read (the libraries fetch stub of
 *    tests/runtime/version-service.test.ts).
 *  - class-diff: the same manifest and client jars; `a.b.C` changes members
 *    between 1.21.9 and 1.21.10 and `a.b.New` exists only in 1.21.10.
 *  - registry-read: the seeded registries.json snapshots.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, mock } from "node:test";

import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { COMPARISON_TOOL_SPECS } from "../../src/tools/families/comparison.ts";
import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import { DETAIL_LEVELS } from "../../src/tools/schemas.ts";
import type { CatalogServices } from "../../src/tools/types.ts";
import { buildClassFile, type ClassFileSpec } from "../helpers/classfile.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-comparison-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";
process.env.GRADLE_USER_HOME = join(root, "gradle-home");

const MANIFEST_URL = "https://manifest.test/version_manifest_v2.json";
process.env.MCP_VERSION_MANIFEST_URL = MANIFEST_URL;
const NEW = "1.21.10";
const OLD = "1.21.9";
const NO_REGISTRY = "1.21.8";
const UNLISTED_FROM = "9.9.1";
const UNLISTED_TO = "9.9.2";

const LIBRARIES: Record<string, string[]> = {
  [OLD]: ["org.lwjgl:lwjgl-glfw:3.3.3", "org.lwjgl:lwjgl:3.3.3", "com.google.guava:guava:32.1.2"],
  [NEW]: ["org.lwjgl:lwjgl:3.3.4", "org.libsdl:sdl3:3.2.0", "com.google.guava:guava:32.1.2"],
  [NO_REGISTRY]: []
};
const clientJars = new Map<string, Buffer>();

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === MANIFEST_URL) {
    return new Response(
      JSON.stringify({
        latest: { release: NEW, snapshot: NEW },
        versions: [NEW, OLD, NO_REGISTRY].map((id) => ({
          id,
          type: "release",
          url: `https://manifest.test/versions/${id}.json`
        }))
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const versionDocument = /^https:\/\/manifest\.test\/versions\/(.+)\.json$/.exec(url);
  if (versionDocument !== null && LIBRARIES[versionDocument[1]!] !== undefined) {
    const id = versionDocument[1]!;
    return new Response(
      JSON.stringify({
        id,
        downloads: { client: { url: `https://manifest.test/jars/${id}.jar` } },
        libraries: LIBRARIES[id]!.map((name) => ({ name }))
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const jar = /^https:\/\/manifest\.test\/jars\/(.+)\.jar$/.exec(url);
  if (jar !== null && clientJars.has(jar[1]!)) {
    return new Response(clientJars.get(jar[1]!), { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

type RegistrySnapshot = Record<string, { default?: string; entries: Record<string, { protocol_id: number }> }>;

function registry(names: string[], defaultEntry?: string) {
  return {
    ...(defaultEntry !== undefined ? { default: defaultEntry } : {}),
    entries: Object.fromEntries(names.map((name, index) => [name, { protocol_id: index }]))
  };
}

const REGISTRIES: Record<string, RegistrySnapshot> = {
  [OLD]: {
    "minecraft:block": registry(["minecraft:air", "minecraft:old_block", "minecraft:stone"], "minecraft:air"),
    "minecraft:item": registry(["minecraft:stick"]),
    "minecraft:old_registry": registry(["minecraft:gone"])
  },
  [NEW]: {
    "minecraft:block": registry(["minecraft:air", "minecraft:new_block", "minecraft:stone"], "minecraft:air"),
    "minecraft:item": registry(["minecraft:stick"]),
    "minecraft:new_registry": registry(["minecraft:fresh"])
  },
  [UNLISTED_FROM]: { "minecraft:block": registry(["minecraft:air"]) },
  [UNLISTED_TO]: { "minecraft:block": registry(["minecraft:air", "minecraft:stone"]) }
};

const PUBLIC = 0x0001;
const PRIVATE = 0x0002;

function classFile(internalName: string, members: Partial<ClassFileSpec> = {}): Buffer {
  return buildClassFile({ internalName, ...members });
}

const CLIENT_CLASSES: Record<string, Record<string, Buffer>> = {
  [OLD]: {
    "com/example/Alpha.class": classFile("com/example/Alpha"),
    "com/example/Removed.class": classFile("com/example/Removed"),
    "com/example/Shared.class": classFile("com/example/Shared"),
    "org/other/Outside.class": classFile("org/other/Outside"),
    "a/b/C.class": classFile("a/b/C", {
      fields: [{ name: "d", descriptor: "I", accessFlags: PUBLIC }],
      methods: [
        { name: "m", descriptor: "()V", accessFlags: PUBLIC },
        { name: "gone", descriptor: "()V", accessFlags: PUBLIC }
      ]
    })
  },
  [NEW]: {
    "com/example/Added.class": classFile("com/example/Added"),
    "com/example/Beta.class": classFile("com/example/Beta"),
    "com/example/Shared.class": classFile("com/example/Shared"),
    "org/other/Outside.class": classFile("org/other/Outside"),
    "a/b/C.class": classFile("a/b/C", {
      fields: [{ name: "d", descriptor: "I", accessFlags: PRIVATE }],
      methods: [
        { name: "m", descriptor: "()V", accessFlags: PUBLIC },
        { name: "e", descriptor: "(I)V", accessFlags: PUBLIC }
      ]
    }),
    "a/b/New.class": classFile("a/b/New", { methods: [{ name: "run", descriptor: "()V", accessFlags: PUBLIC }] })
  },
  [NO_REGISTRY]: {
    "com/example/Shared.class": classFile("com/example/Shared")
  }
};

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
    truncation?: Array<{ field: string; limitedBy: string }>;
  };
};

let session: CatalogSession;

before(async () => {
  for (const [version, entries] of Object.entries(CLIENT_CLASSES)) {
    const path = join(root, `client-${version}.jar`);
    await createJar(path, entries);
    clientJars.set(version, readFileSync(path));
  }
  for (const [version, snapshot] of Object.entries(REGISTRIES)) {
    const reports = join(root, "cache", "registries", version, "reports");
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, "registries.json"), JSON.stringify(snapshot), "utf8");
  }
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

function specOf(name: string) {
  const spec = COMPARISON_TOOL_SPECS.find((entry) => entry.name === name);
  assert.ok(spec, `${name} is a comparison spec`);
  return spec;
}

/** The `status` a reply carries, wherever the tool puts it. */
function statusOf(name: string, envelope: Envelope): string | undefined {
  if (name === "version-compare") return envelope.result?.comparison?.status;
  if (name === "class-diff") return envelope.result?.diff?.status;
  return undefined;
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
  const status = statusOf(name, reply.envelope);
  if (status !== undefined) {
    assert.ok((specOf(name).statuses as readonly string[]).includes(status), `${name} status ${status} is declared`);
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

// ---------------------------------------------------------------------------
// version-compare
// ---------------------------------------------------------------------------

test("version-compare matches compare-versions for classes and registries", async () => {
  const legacy = (await eightX("compare-versions", { fromVersion: OLD, toVersion: NEW, packageFilter: "com.example" }))
    .envelope.result!;
  assert.deepEqual(legacy.classes.added, ["com.example.Added", "com.example.Beta"], "positive control: classes were added");

  const full = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, packageFilter: "com.example", detail: "full" });
  const comparison = full.envelope.result!.comparison;
  assert.equal(comparison.status, "ok");
  assert.equal(comparison.fromVersion, OLD);
  assert.equal(comparison.toVersion, NEW);
  assert.deepEqual(comparison.classes, {
    addedCount: legacy.classes.addedCount,
    removedCount: legacy.classes.removedCount,
    unchanged: legacy.classes.unchanged,
    mappingApplied: legacy.classes.namespace,
    packageFilter: {
      value: legacy.classes.packageFilter.value,
      matchedFrom: legacy.classes.packageFilter.matchedFrom,
      matchedTo: legacy.classes.packageFilter.matchedTo
    },
    added: legacy.classes.added,
    removed: legacy.classes.removed
  });
  assert.deepEqual(comparison.registry, {
    summary: legacy.registry.summary,
    newRegistries: legacy.registry.newRegistries,
    removedRegistries: legacy.registry.removedRegistries,
    changed: {
      "minecraft:block": { added: 1, removed: 1 },
      "minecraft:new_registry": { added: 1, removed: 0 },
      "minecraft:old_registry": { added: 0, removed: 1 }
    },
    added: legacy.registry.added,
    removed: legacy.registry.removed
  });
  assert.deepEqual(comparison.registry.added["minecraft:block"], ["minecraft:new_block"]);
  assert.equal(full.envelope.meta.nextActions, undefined, "full asks for no further level");
  assert.equal(full.envelope.meta.truncation, undefined, "positive control: nothing was cut");
});

test("version-compare answers with counts at summary and offers the lowest detail level that adds names", async () => {
  const { envelope } = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW });
  const comparison = envelope.result!.comparison;
  assert.equal(comparison.status, "ok");
  assert.deepEqual(Object.keys(comparison.classes).sort(), ["addedCount", "mappingApplied", "removedCount", "unchanged"]);
  assert.equal(comparison.classes.mappingApplied, "mojang", "the namespace of the compared names is reported at summary");
  assert.deepEqual(Object.keys(comparison.registry).sort(), ["changed", "newRegistries", "removedRegistries", "summary"]);
  assert.deepEqual(envelope.meta.nextActions, [
    {
      tool: "version-compare",
      params: { fromVersion: OLD, toVersion: NEW, detail: "standard" },
      reason: "List the added and removed names."
    }
  ]);

  const standard = await catalog("version-compare", envelope.meta.nextActions![0]!.params);
  const legacy = (await eightX("compare-versions", { fromVersion: OLD, toVersion: NEW })).envelope.result!;
  assert.deepEqual(standard.envelope.result!.comparison.classes.added, legacy.classes.added);
  assert.deepEqual(standard.envelope.result!.comparison.classes.removed, legacy.classes.removed);
  assert.equal("added" in standard.envelope.result!.comparison.registry, false, "registry entries come at full");
  assert.equal(standard.envelope.meta.nextActions, undefined);

  const unchanged = await catalog("version-compare", { fromVersion: NEW, toVersion: NEW });
  assert.equal(unchanged.envelope.result!.comparison.classes.addedCount, 0);
  assert.equal(unchanged.envelope.meta.nextActions, undefined, "no names to list, no follow-up");

  const registryOnly = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, category: "registry" });
  assert.deepEqual(
    registryOnly.envelope.meta.nextActions,
    [
      {
        tool: "version-compare",
        params: { fromVersion: OLD, toVersion: NEW, category: "registry", detail: "full" },
        reason: "List the added and removed registry entries."
      }
    ],
    "standard adds no list to a registry comparison, so the follow-up asks for full"
  );
  const entries = await catalog("version-compare", registryOnly.envelope.meta.nextActions![0]!.params);
  assert.deepEqual(entries.envelope.result!.comparison.registry.added["minecraft:block"], ["minecraft:new_block"]);
});

test("every version-compare detail level keeps the comparison and its status", async () => {
  for (const detail of DETAIL_LEVELS) {
    const { envelope } = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, withLibraries: true, detail });
    const comparison = envelope.result!.comparison;
    assert.equal(comparison.status, "ok", detail);
    assert.equal(comparison.fromVersion, OLD, detail);
    assert.equal(typeof comparison.classes.addedCount, "number", detail);
    assert.equal(typeof comparison.registry.summary.registriesChanged, "number", detail);
    assert.equal(typeof comparison.libraries.addedCount, "number", detail);
    assert.equal("added" in comparison.classes, detail !== "summary", `${detail}: class names`);
    assert.equal("added" in comparison.libraries, detail !== "summary", `${detail}: library names`);
    assert.equal("added" in comparison.registry, detail === "full", `${detail}: registry entries`);
  }
});

test("version-compare reports a limit cut of the class lists in meta.truncation where the lists are returned", async () => {
  const request = { fromVersion: OLD, toVersion: NEW, category: "classes", packageFilter: "com.example", limit: 1 };
  const legacy = (await eightX("compare-versions", { ...request, maxClassResults: 1, limit: undefined })).envelope.result!;
  const cut = await catalog("version-compare", { ...request, detail: "standard" });
  const classes = cut.envelope.result!.comparison.classes;
  assert.deepEqual(classes.added, legacy.classes.added);
  assert.deepEqual(classes.removed, legacy.classes.removed);
  assert.equal(classes.added.length, 1);
  assert.equal(classes.addedCount, 2);
  assert.deepEqual(cut.envelope.meta.truncation, [
    { field: "comparison.classes.added", limitedBy: "limit" },
    { field: "comparison.classes.removed", limitedBy: "limit" }
  ]);
  assert.ok(cut.envelope.meta.warnings?.some((warning) => warning.message.startsWith("Class additions truncated")));
  assert.equal(cut.envelope.result!.comparison.registry, undefined, "category classes leaves the registries out");

  const summary = await catalog("version-compare", request);
  assert.equal(summary.envelope.meta.truncation, undefined, "summary returns no list to cut");
  assert.equal(
    summary.envelope.meta.warnings?.some((warning) => warning.message.startsWith("Class additions truncated")) ?? false,
    false,
    "summary leaves out the cut notice"
  );
  assert.deepEqual(summary.envelope.meta.nextActions?.[0]?.params, {
    fromVersion: OLD,
    toVersion: NEW,
    category: "classes",
    packageFilter: "com.example",
    limit: 1,
    detail: "standard"
  });

  const whole = await catalog("version-compare", { ...request, limit: 2, detail: "standard" });
  assert.equal(whole.envelope.meta.truncation, undefined, "positive control: a limit that fits cuts nothing");
});

test("version-compare narrows the registry delta to one registry and tells an unchanged registry from an unknown one", async () => {
  const legacy = (await eightX("compare-versions", { fromVersion: OLD, toVersion: NEW, category: "registry" })).envelope.result!;
  const narrowed = await catalog("version-compare", {
    fromVersion: OLD,
    toVersion: NEW,
    category: "registry",
    registry: "block",
    detail: "full"
  });
  assert.deepEqual(narrowed.envelope.result!.comparison.registry, {
    name: "minecraft:block",
    summary: { registriesChanged: 1, totalAdded: 1, totalRemoved: 1 },
    newRegistries: [],
    removedRegistries: [],
    changed: { "minecraft:block": { added: 1, removed: 1 } },
    added: { "minecraft:block": legacy.registry.added["minecraft:block"] },
    removed: { "minecraft:block": legacy.registry.removed["minecraft:block"] }
  });
  assert.equal(narrowed.envelope.result!.comparison.status, "ok");

  const newRegistry = await catalog("version-compare", {
    fromVersion: OLD,
    toVersion: NEW,
    category: "registry",
    registry: "minecraft:new_registry"
  });
  assert.deepEqual(newRegistry.envelope.result!.comparison.registry.newRegistries, ["minecraft:new_registry"]);

  const unchanged = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, category: "registry", registry: "item" });
  assert.equal(unchanged.envelope.result!.comparison.status, "ok", "an existing, unchanged registry is ok");
  assert.deepEqual(unchanged.envelope.result!.comparison.registry.summary, { registriesChanged: 0, totalAdded: 0, totalRemoved: 0 });
  assert.equal(unchanged.envelope.meta.warnings?.some((warning) => warning.code === "registry-not-found") ?? false, false);

  const unknown = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, registry: "blok" });
  assert.equal(unknown.isError, false);
  assert.equal(unknown.envelope.result!.comparison.status, "not_found", "a registry in neither version is not_found");
  assert.equal(unknown.envelope.result!.comparison.registry.name, "minecraft:blok");
  assert.equal(typeof unknown.envelope.result!.comparison.classes.addedCount, "number", "registry does not change category");
  const warning = unknown.envelope.meta.warnings?.find((entry) => entry.code === "registry-not-found");
  assert.ok(warning, "a warning names the unknown registry");
  assert.equal(warning.severity, "warning");
  assert.match(warning.message, /"minecraft:blok" exists in neither 1\.21\.9 nor 1\.21\.10; registry-read without registry lists/);
  assert.deepEqual(
    unknown.envelope.meta.nextActions,
    [{ tool: "registry-read", params: { version: NEW }, reason: "List the registry names." }],
    "the registry names are offered instead of a call that repeats the miss"
  );
});

test("version-compare reports partial when the registry or library comparison fails, keeping the rest", async () => {
  const legacy = (await eightX("compare-versions", { fromVersion: NO_REGISTRY, toVersion: NEW })).envelope;
  const registryWarning = (legacy.meta.warnings as string[]).find((warning) => warning.startsWith("Registry comparison failed"));
  assert.ok(registryWarning, "positive control: the 8.x tool reports the failed registry comparison");

  const noRegistry = await catalog("version-compare", { fromVersion: NO_REGISTRY, toVersion: NEW });
  assert.equal(noRegistry.envelope.result!.comparison.status, "partial");
  assert.equal(noRegistry.envelope.result!.comparison.registry, undefined);
  assert.equal(noRegistry.envelope.result!.comparison.classes.addedCount, legacy.result!.classes.addedCount);
  assert.deepEqual(
    noRegistry.envelope.meta.warnings?.find((warning) => warning.code === "registry-unavailable"),
    { code: "registry-unavailable", severity: "warning", message: registryWarning }
  );

  const registryOnly = await catalog("version-compare", { fromVersion: NO_REGISTRY, toVersion: NEW, category: "registry" });
  const legacyRegistryOnly = (await eightX("compare-versions", { fromVersion: NO_REGISTRY, toVersion: NEW, category: "registry" }))
    .envelope.error!;
  assert.equal(registryOnly.isError, true, "with category registry the failure fails the call");
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(registryOnly.envelope.error?.[key], legacyRegistryOnly[key], key);
  }

  const noLibraries = await catalog("version-compare", {
    fromVersion: UNLISTED_FROM,
    toVersion: UNLISTED_TO,
    category: "registry",
    withLibraries: true
  });
  const comparison = noLibraries.envelope.result!.comparison;
  assert.equal(comparison.status, "partial");
  assert.equal(comparison.libraries, undefined);
  assert.deepEqual(comparison.registry.changed, { "minecraft:block": { added: 1, removed: 0 } }, "the registry answer stays");
  const libraryWarning = noLibraries.envelope.meta.warnings?.find((warning) => warning.code === "libraries-unavailable");
  assert.equal(libraryWarning?.severity, "warning");
  assert.match(libraryWarning?.message ?? "", /^Could not compare libraries between 9\.9\.1 and 9\.9\.2: /);

  const both = await catalog("version-compare", {
    fromVersion: UNLISTED_FROM,
    toVersion: UNLISTED_TO,
    category: "registry",
    registry: "missing",
    withLibraries: true
  });
  assert.equal(both.envelope.result!.comparison.status, "not_found", "an unknown registry wins over a library failure");
  assert.deepEqual(
    both.envelope.meta.warnings?.map((warning) => warning.code).sort(),
    ["libraries-unavailable", "registry-not-found"],
    "both failures are reported"
  );
});

test("version-compare goes on without the libraries when their fetch passes the 5-second deadline", async () => {
  const services = {
    compareVersions: async () => ({
      fromVersion: OLD,
      toVersion: NEW,
      classes: { added: ["a.B"], removed: [], addedCount: 1, removedCount: 0, unchanged: 3, namespace: "mojang" },
      warnings: []
    }),
    getVersionLibraries: () => new Promise<string[]>(() => {})
  } as unknown as CatalogServices;
  const runtime = {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const pending = runCatalogTool(
      specOf("version-compare"),
      { fromVersion: OLD, toVersion: NEW, category: "classes", withLibraries: true },
      runtime
    ).then((reply) => {
      settled = true;
      return reply;
    });
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(4_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the call waits for the libraries until the deadline");
    mock.timers.tick(1);
    const envelope = (await pending).structuredContent as Envelope;
    const comparison = envelope.result!.comparison;
    assert.equal(comparison.status, "partial");
    assert.equal(comparison.libraries, undefined);
    assert.equal(comparison.classes.addedCount, 1, "the class answer stays");
    assert.deepEqual(envelope.meta.warnings, [
      {
        code: "libraries-unavailable",
        severity: "warning",
        message: `Library comparison between ${OLD} and ${NEW} timed out after 5000ms.`
      }
    ]);
  } finally {
    mock.timers.reset();
  }
});

test("version-compare reads the libraries after the comparison, so they come from the version documents it loaded", async () => {
  const order: string[] = [];
  let releaseComparison!: () => void;
  const comparisonGate = new Promise<void>((resolve) => {
    releaseComparison = resolve;
  });
  const services = {
    compareVersions: async () => {
      order.push("compare:start");
      await comparisonGate;
      order.push("compare:end");
      return {
        fromVersion: OLD,
        toVersion: NEW,
        classes: { added: [], removed: [], addedCount: 0, removedCount: 0, unchanged: 3, namespace: "mojang" },
        warnings: []
      };
    },
    getVersionLibraries: async (version: string) => {
      order.push(`libraries:${version}`);
      return LIBRARIES[version]!;
    }
  } as unknown as CatalogServices;
  const runtime = {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  };
  const pending = runCatalogTool(
    specOf("version-compare"),
    { fromVersion: OLD, toVersion: NEW, category: "classes", withLibraries: true },
    runtime
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["compare:start"], "no library fetch races the comparison's own version document loads");
  releaseComparison();
  const envelope = (await pending).structuredContent as Envelope;
  assert.deepEqual(order, ["compare:start", "compare:end", `libraries:${OLD}`, `libraries:${NEW}`]);
  assert.equal(envelope.result!.comparison.status, "ok");
  assert.equal(envelope.result!.comparison.libraries.addedCount, 1);
});

test("version-compare withLibraries matches the migration-overview library delta", async () => {
  const legacy = (await eightX("compare-minecraft", {
    task: "migration-overview",
    subject: { kind: "version-pair", fromVersion: OLD, toVersion: NEW },
    detail: "full"
  })).envelope.result!;
  const legacyLibraries = legacy.migration.libraries;
  assert.ok(legacyLibraries.addedCount > 0, "positive control: a library was added");

  const standard = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, withLibraries: true, detail: "standard" });
  assert.deepEqual(standard.envelope.result!.comparison.libraries, legacyLibraries);
  assert.deepEqual(standard.envelope.result!.comparison.libraries.added, ["org.libsdl:sdl3:3.2.0"]);

  const summary = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, withLibraries: true });
  assert.deepEqual(summary.envelope.result!.comparison.libraries, {
    addedCount: legacyLibraries.addedCount,
    removedCount: legacyLibraries.removedCount,
    versionChangedCount: legacyLibraries.versionChangedCount
  });
  assert.equal(summary.envelope.meta.nextActions?.[0]?.params.withLibraries, true, "the follow-up keeps withLibraries");

  const without = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW });
  assert.equal(without.envelope.result!.comparison.libraries, undefined, "libraries only with withLibraries");
});

// ---------------------------------------------------------------------------
// class-diff
// ---------------------------------------------------------------------------

test("class-diff matches diff-class-signatures at full and standard", async () => {
  const request = { className: "a.b.C", fromVersion: OLD, toVersion: NEW, mapping: "obfuscated" };
  const legacy = (await eightX("diff-class-signatures", request)).envelope.result!;
  assert.equal(legacy.summary.total.added, 1, "positive control: a method was added");

  const full = await catalog("class-diff", request);
  const diff = full.envelope.result!.diff;
  assert.equal(diff.status, "ok");
  assert.equal(diff.className, "a.b.C");
  assert.equal(diff.fromVersion, OLD);
  assert.equal(diff.toVersion, NEW);
  assert.equal(diff.mappingApplied, legacy.query.mapping);
  assert.equal(diff.classChange, legacy.classChange);
  assert.deepEqual(diff.summary, legacy.summary);
  for (const kind of ["constructors", "methods", "fields"]) {
    assert.deepEqual(diff[kind], legacy[kind], `full ${kind}`);
  }
  assert.ok(diff.fields.modified[0].from, "full keeps the before/after members");
  assert.deepEqual(diff.fields.modified[0].changed, ["accessFlags", "javaSignature"]);

  const legacyCompact = (await eightX("diff-class-signatures", { ...request, includeFullDiff: false })).envelope.result!;
  const standard = await catalog("class-diff", { ...request, detail: "standard" });
  for (const kind of ["constructors", "methods", "fields"]) {
    assert.deepEqual(standard.envelope.result!.diff[kind], legacyCompact[kind], `standard ${kind}`);
  }
  assert.equal(standard.envelope.result!.diff.fields.modified[0].from, undefined);

  const added = await catalog("class-diff", { ...request, className: "a.b.New" });
  const legacyAdded = (await eightX("diff-class-signatures", { ...request, className: "a.b.New" })).envelope.result!;
  assert.equal(added.envelope.result!.diff.classChange, "added");
  assert.equal(added.envelope.result!.diff.status, "ok");
  assert.deepEqual(added.envelope.result!.diff.methods, legacyAdded.methods);
});

test("every class-diff detail level keeps the diff, its status and the counts", async () => {
  const request = { className: "a.b.C", fromVersion: OLD, toVersion: NEW, mapping: "obfuscated" };
  for (const detail of DETAIL_LEVELS) {
    const { envelope } = await catalog("class-diff", { ...request, detail });
    const diff = envelope.result!.diff;
    assert.equal(diff.status, "ok", detail);
    assert.equal(diff.classChange, "present_in_both", detail);
    assert.equal(diff.summary.total.added, 1, detail);
    assert.equal("methods" in diff, detail !== "summary", `${detail}: member deltas`);
  }
});

test("class-diff reports a class that neither version has as not_found", async () => {
  const request = { className: "a.b.Missing", fromVersion: OLD, toVersion: NEW, mapping: "obfuscated" };
  const legacy = (await eightX("diff-class-signatures", request)).envelope.result!;
  assert.equal(legacy.classChange, "absent_in_both");
  const { envelope, isError } = await catalog("class-diff", request);
  assert.equal(isError, false);
  assert.equal(envelope.result!.diff.status, "not_found");
  assert.equal(envelope.result!.diff.classChange, "absent_in_both");
  assert.ok(envelope.meta.warnings?.some((warning) => warning.message.includes('"a.b.Missing" was not found')));
});

test("class-diff reports a class whose versions' mapping data could not be loaded as unavailable, not as missing or added", async () => {
  const request = { className: "x.y.Missing", fromVersion: OLD, toVersion: NEW, mapping: "mojang" };
  const legacy = (await eightX("diff-class-signatures", request)).envelope;
  assert.equal(legacy.result!.classChange, "absent_in_both", "positive control: the unmapped name misses in both jars");
  const { envelope, isError } = await catalog("class-diff", request);
  assert.equal(isError, false);
  assert.equal(envelope.result!.diff.classChange, "absent_in_both");
  assert.equal(envelope.result!.diff.status, "unavailable");
  assert.ok(
    envelope.meta.warnings?.some((warning) => /^(Could not map|Mapping lookup failed for) class "x\.y\.Missing"/.test(warning.message)),
    "the warning says why the name could not be mapped"
  );

  const added = await catalog("class-diff", { ...request, className: "a.b.New" });
  assert.equal(added.envelope.result!.diff.classChange, "added", "positive control: the unmapped name is found in the newer jar only");
  assert.equal(added.envelope.result!.diff.status, "unavailable", "the class may exist under its mapped name in the older version");

  const present = await catalog("class-diff", { ...request, className: "a.b.C" });
  const legacyPresent = (await eightX("diff-class-signatures", { ...request, className: "a.b.C" })).envelope;
  assert.equal(present.envelope.result!.diff.status, "ok", "a class found under its unmapped name is answered");
  assert.equal(present.envelope.result!.diff.mappingApplied, "mojang");
  assert.deepEqual(present.envelope.result!.diff.fields, legacyPresent.result!.fields);
  assert.ok(
    present.envelope.meta.warnings?.some((warning) => warning.message.startsWith("Could not remap")),
    "the members that keep their jar names are named in a remap warning"
  );
});

test("class-diff fails like diff-class-signatures on an unknown version and offers version-list", async () => {
  const request = { className: "a.b.C", fromVersion: "0.0.1", toVersion: NEW, mapping: "obfuscated" };
  const legacy = (await eightX("diff-class-signatures", request)).envelope.error!;
  assert.equal(legacy.code, "ERR_VERSION_NOT_FOUND", "positive control: the 8.x tool rejects the version");
  const { envelope, isError } = await catalog("class-diff", request);
  assert.equal(isError, true);
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(envelope.error?.[key], legacy[key], key);
  }
  assert.equal(envelope.error?.suggestedCall, undefined, "recovery calls live in meta.nextActions");
  assert.ok(
    envelope.meta.nextActions?.some((action) => action.tool === "version-list"),
    "the version list is offered"
  );
});

type MappingAnswer = "resolved" | "not_found" | "mapping_unavailable" | "throws";

/**
 * class-diff on stubbed services between `fromVersion` and `toVersion`
 * (default the two fixture versions): the diff service reports `classChange`
 * for `com.mojang.Gone` (with its unmapped-class sentence unless `sentence` is
 * false), and findMapping answers per version as `answers` says, recording
 * each lookup it receives.
 */
async function stubbedClassDiff(
  classChange: "added" | "removed" | "absent_in_both",
  answers: Record<string, MappingAnswer>,
  { sentence = true, fromVersion = OLD, toVersion = NEW }: { sentence?: boolean; fromVersion?: string; toVersion?: string } = {}
) {
  const className = "com.mojang.Gone";
  const delta = { added: [], removed: [], modified: [] };
  const counts = { added: 0, removed: 0, modified: 0 };
  const lookups: Array<Record<string, unknown>> = [];
  const services = {
    diffClassSignatures: async (input: { className: string; fromVersion: string; toVersion: string; mapping: string }) => ({
      query: { className: input.className, fromVersion: input.fromVersion, toVersion: input.toVersion, mapping: input.mapping },
      range: { fromVersion: input.fromVersion, toVersion: input.toVersion },
      classChange,
      constructors: delta,
      methods: delta,
      fields: delta,
      summary: { constructors: counts, methods: counts, fields: counts, total: counts },
      warnings: sentence ? [`Could not map class "${className}" from mojang to obfuscated for bytecode lookup.`] : []
    }),
    findMapping: async (input: Record<string, unknown>) => {
      lookups.push(input);
      const answer = answers[input.version as string];
      assert.ok(answer !== undefined, `findMapping was asked about ${String(input.version)}`);
      if (answer === "throws") throw new Error("mapping lookup failed");
      return { resolved: answer === "resolved", status: answer, candidates: [], candidateCount: 0, warnings: [] };
    }
  } as unknown as CatalogServices;
  const runtime = {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  };
  const reply = await runCatalogTool(
    specOf("class-diff"),
    { className, fromVersion, toVersion, mapping: "mojang" },
    runtime as unknown as Parameters<typeof runCatalogTool>[2]
  );
  const diff = (reply.structuredContent as Envelope).result!.diff;
  assert.equal(diff.classChange, classChange);
  return { status: diff.status as string, lookups };
}

test("class-diff looks the class up in the mapping data of each version without it before it reports a change", async () => {
  const removed = await stubbedClassDiff("removed", { [NEW]: "not_found" });
  assert.equal(removed.status, "ok", "a class the newer version's mappings do not hold was removed");
  assert.deepEqual(removed.lookups, [
    { version: NEW, kind: "class", name: "com.mojang.Gone", sourceMapping: "mojang", targetMapping: "obfuscated" }
  ]);
  assert.equal(
    (await stubbedClassDiff("removed", { [NEW]: "mapping_unavailable" })).status,
    "unavailable",
    "the newer version's mapping data could not be loaded"
  );

  const added = await stubbedClassDiff("added", { [OLD]: "not_found" });
  assert.equal(added.status, "ok", "a class the older version's mappings do not hold was added");
  assert.deepEqual(added.lookups.map((lookup) => lookup.version), [OLD]);
  assert.equal((await stubbedClassDiff("added", { [OLD]: "mapping_unavailable" })).status, "unavailable");

  const neither = await stubbedClassDiff("absent_in_both", { [OLD]: "not_found", [NEW]: "not_found" });
  assert.equal(neither.status, "not_found", "neither version's mappings hold the class");
  assert.deepEqual(neither.lookups.map((lookup) => lookup.version), [OLD, NEW]);
  assert.equal(
    (await stubbedClassDiff("absent_in_both", { [OLD]: "not_found", [NEW]: "mapping_unavailable" })).status,
    "unavailable"
  );

  assert.equal((await stubbedClassDiff("removed", { [NEW]: "throws" })).status, "unavailable", "a lookup that fails");

  const unmentioned = await stubbedClassDiff("removed", { [NEW]: "mapping_unavailable" }, { sentence: false });
  assert.equal(unmentioned.status, "ok", "without an unmapped-class sentence the change stands");
  assert.deepEqual(unmentioned.lookups, [], "and nothing is looked up");
});

test("class-diff takes a Mojang-named class's absence from an unobfuscated version's jar as it is", async () => {
  // The service reads a 26.1+ jar under the Mojang name itself; that version's mapping graph is empty by design.
  const UNOBFUSCATED = "26.1";
  const range = { fromVersion: NEW, toVersion: UNOBFUSCATED };
  const neither = await stubbedClassDiff("absent_in_both", { [NEW]: "not_found", [UNOBFUSCATED]: "mapping_unavailable" }, range);
  assert.deepEqual(neither.lookups.map((lookup) => lookup.version), [NEW], "only the obfuscated version is looked up");
  assert.equal(neither.status, "not_found");

  const removed = await stubbedClassDiff("removed", { [UNOBFUSCATED]: "mapping_unavailable" }, range);
  assert.deepEqual(removed.lookups, [], "nothing is looked up for the unobfuscated version");
  assert.equal(removed.status, "ok");
});

// ---------------------------------------------------------------------------
// registry-read
// ---------------------------------------------------------------------------

test("registry-read returns registry names and counts without entries by default, like get-registry-data without data", async () => {
  const legacy = (await eightX("get-registry-data", { version: NEW, includeData: false })).envelope.result!;
  const { envelope } = await catalog("registry-read", { version: NEW });
  assert.equal(envelope.result!.version, NEW);
  assert.deepEqual(
    envelope.result!.registries,
    legacy.registries.map((name: string) => ({ name, entryCount: legacy.registryEntryCounts[name] }))
  );
  assert.ok(envelope.result!.registries.length > 0, "positive control: registries are listed");
  assert.equal(envelope.meta.nextActions, undefined, "the listing asks for no follow-up");
  assert.equal(envelope.meta.truncation, undefined);
});

test("registry-read withData returns each registry's entries and default like get-registry-data", async () => {
  const legacy = (await eightX("get-registry-data", { version: NEW })).envelope.result!;
  const { envelope } = await catalog("registry-read", { version: NEW, withData: true });
  assert.deepEqual(
    envelope.result!.registries,
    legacy.registries.map((name: string) => ({
      name,
      entryCount: legacy.registryEntryCounts[name],
      ...(legacy.data[name].default !== undefined ? { default: legacy.data[name].default } : {}),
      entries: legacy.data[name].entries
    }))
  );
  assert.equal(envelope.result!.registries[0].default, "minecraft:air", "positive control: the block default is kept");
  assert.deepEqual(envelope.result!.registries[0].entries["minecraft:stone"], { protocol_id: 2 });
});

test("registry-read with one registry offers its entries and reports a limit cut per registry", async () => {
  const named = await catalog("registry-read", { version: NEW, registry: "block" });
  assert.deepEqual(named.envelope.result!.registries, [{ name: "minecraft:block", entryCount: 3 }]);
  const next = named.envelope.meta.nextActions;
  assert.deepEqual(next, [
    { tool: "registry-read", params: { version: NEW, registry: "block", withData: true }, reason: "Read this registry's entries." }
  ]);

  const legacy = (await eightX("get-registry-data", { version: NEW, registry: "block", maxEntriesPerRegistry: 2 })).envelope.result!;
  const cut = await catalog("registry-read", { ...next![0]!.params, limit: 2 });
  assert.deepEqual(cut.envelope.result!.registries, [
    { name: "minecraft:block", entryCount: 3, default: legacy.data.default, entries: legacy.data.entries }
  ]);
  assert.equal(Object.keys(legacy.data.entries).length, 2);
  assert.deepEqual(cut.envelope.meta.truncation, [{ field: "registries[0].entries", limitedBy: "limit" }]);
  assert.equal(cut.envelope.meta.nextActions, undefined, "the entries are already returned");

  const all = await catalog("registry-read", { version: NEW, withData: true, limit: 1 });
  const blockIndex = all.envelope.result!.registries.findIndex((entry: { name: string }) => entry.name === "minecraft:block");
  assert.ok(
    all.envelope.meta.truncation?.some((entry) => entry.field === `registries[${blockIndex}].entries`),
    "the cut block registry is named"
  );
  const itemIndex = all.envelope.result!.registries.findIndex((entry: { name: string }) => entry.name === "minecraft:item");
  assert.equal(
    all.envelope.meta.truncation?.some((entry) => entry.field === `registries[${itemIndex}].entries`),
    false,
    "positive control: a registry within the limit is not reported"
  );
});

test("registry-read fails like get-registry-data on an unknown registry", async () => {
  const legacy = (await eightX("get-registry-data", { version: NEW, registry: "nope" })).envelope.error!;
  assert.equal(legacy.code, "ERR_SOURCE_NOT_FOUND");
  const { envelope, isError } = await catalog("registry-read", { version: NEW, registry: "nope" });
  assert.equal(isError, true);
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(envelope.error?.[key], legacy[key], key);
  }
});

// ---------------------------------------------------------------------------
// Strict input
// ---------------------------------------------------------------------------

test("every comparison tool validates its examples and rejects unknown, misspelled and misplaced keys", async () => {
  const nearMisses: Record<string, [string, string]> = {
    "version-compare": ["toVersoin", "toVersion"],
    "class-diff": ["maping", "mapping"],
    "registry-read": ["verison", "version"]
  };
  for (const spec of COMPARISON_TOOL_SPECS) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
      const reply = await catalog(spec.name, example);
      assert.notEqual(reply.envelope.error?.detail, "Request validation failed.", `${spec.name} example passes validation`);
    }
    const example = spec.examples[0]! as Record<string, unknown>;

    const unknownTop = await catalog(spec.name, { ...example, bogusKey: 1 });
    assert.equal(unknownTop.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(unknownTop.envelope.error?.fieldErrors?.map((entry) => entry.path), ["bogusKey"], spec.name);

    const [misspelled, declared] = nearMisses[spec.name]!;
    const { [declared]: value, ...rest } = example;
    const nearMiss = await catalog(spec.name, { ...rest, [misspelled]: value });
    assert.equal(nearMiss.envelope.error?.code, "ERR_INVALID_INPUT");
    const entry = nearMiss.envelope.error?.fieldErrors?.find((fieldError) => fieldError.path === misspelled);
    assert.ok(entry?.suggestions?.includes(declared), `${spec.name}: "${misspelled}" suggests "${declared}"`);
  }

  const rejected: Array<[string, Record<string, unknown>, string[]]> = [
    ["class-diff", { className: "a.b.C", fromVersion: OLD, toVersion: NEW }, ["mapping"]],
    ["class-diff", { className: "Item", fromVersion: OLD, toVersion: NEW, mapping: "mojang" }, ["className"]],
    ["class-diff", { className: "class_1792", fromVersion: OLD, toVersion: NEW, mapping: "intermediary" }, ["className"]],
    ["version-compare", { fromVersion: OLD, toVersion: NEW, category: "classes", registry: "block" }, ["registry"]],
    ["version-compare", { fromVersion: OLD, toVersion: NEW, category: "registry", packageFilter: "com.example" }, ["packageFilter"]],
    ["version-compare", { fromVersion: OLD, toVersion: NEW, limit: 5001 }, ["limit"]],
    ["registry-read", { version: NEW, limit: 0 }, ["limit"]]
  ];
  for (const [name, request, paths] of rejected) {
    const reply = await catalog(name, request);
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", `${name} ${JSON.stringify(request)}`);
    assert.deepEqual(reply.envelope.error?.fieldErrors?.map((entry) => entry.path), paths, `${name} names ${paths.join(", ")}`);
  }

  const obfuscatedShortName = await catalog("class-diff", { className: "abc", fromVersion: OLD, toVersion: NEW, mapping: "obfuscated" });
  assert.equal(obfuscatedShortName.isError, false, "an obfuscated class may sit in the default package");
  assert.equal(obfuscatedShortName.envelope.result!.diff.status, "not_found");

  const accepted = await catalog("version-compare", { fromVersion: OLD, toVersion: NEW, registry: "block", packageFilter: "com.example" });
  assert.equal(accepted.isError, false, "with category all, registry and packageFilter both apply");
  const numeric = await catalog("registry-read", { version: NEW, registry: "block", withData: true, limit: "1" });
  assert.equal(numeric.envelope.result!.registries[0].entryCount, 3, "a numeric string limit is accepted");
});
