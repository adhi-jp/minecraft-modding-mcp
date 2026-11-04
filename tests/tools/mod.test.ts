/**
 * Mod family (mod-inspect, mod-search, mod-remap) through the in-process MCP
 * session that serves the catalog and the 8.x tools side by side. Every 8.x
 * counterpart runs on the same fixtures through the same session.
 *
 * Fixtures, all local jars built with createJar:
 *  - Fabric, Quilt and Forge mod jars for the metadata reads; the Fabric jar's
 *    class entries carry Mojang-style names, so remapping it to `mojang`
 *    copies the input and needs neither Java nor mappings;
 *  - a sources jar (only `.java` entries), searched without decompilation;
 *  - a Fabric jar whose names cannot be classified, answered from a seeded
 *    remap cache entry;
 *  - a Fabric jar without a Minecraft dependency, a jar without loader
 *    metadata, and a file that is not a zip archive.
 * No call reaches the network (fetch is stubbed and records every URL) and
 * no Java process runs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { MOD_TOOL_SPECS } from "../../src/tools/families/mod.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { buildCatalogWarnings } from "../../src/tools/warnings.ts";
import { withEnv } from "../helpers/env.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-mod-"));
const cacheDir = join(root, "cache");
process.env.MCP_CACHE_DIR = cacheDir;
process.env.MCP_SQLITE_PATH = join(cacheDir, "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";

const fetchedUrls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  fetchedUrls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const MODS = join(root, "mods");
const fabricJar = join(MODS, "examplemod-1.0.0.jar");
const quiltJar = join(MODS, "quiltmod-2.0.0.jar");
const forgeJar = join(MODS, "forgemod-3.0.0.jar");
const plainJar = join(MODS, "plain.jar");
const brokenJar = join(MODS, "broken.jar");
const versionlessJar = join(MODS, "versionless.jar");
const unclassifiedJar = join(MODS, "unclassified.jar");
const sourcesJar = join(MODS, "examplemod-1.0.0-sources.jar");

/** Class bytes whose constant pool reads as Mojang names (remapping to mojang copies the jar). */
const MOJANG_CLASS = Buffer.from(
  ["CAFEBABE", "Lnet/minecraft/server/MinecraftServer;", "Lnet/minecraft/world/level/Level;"].join("\0"),
  "latin1"
);
/** Class bytes with no Minecraft names at all, so the namespace cannot be told. */
const NEUTRAL_CLASS = Buffer.from(["CAFEBABE", "Ljava/lang/Object;"].join("\0"), "latin1");

const EXAMPLE_MOD_SOURCE = [
  "package com.example;",
  "",
  "public class ExampleMod {",
  "   public static final String MOD_ID = \"examplemod\";",
  "   private int counter = 0;",
  "",
  "   public void onInitialize() {",
  "      Registry.register(\"block\");",
  "   }",
  "",
  "   private void registerItems() {",
  "      Registry.register(\"item\");",
  "   }",
  "}",
  ""
].join("\n");
const REGISTRY_SOURCE = [
  "package com.example;",
  "",
  "public class Registry {",
  "   public static void register(String name) {",
  "   }",
  "}",
  ""
].join("\n");

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";
const SOURCE_JAR_NOTICE = "Detected source jar; searching Java entries directly without decompilation.";
const CACHE_NOTICE = "Result served from cache.";

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
  mkdirSync(MODS, { recursive: true });
  await createJar(fabricJar, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "examplemod",
      version: "1.0.0",
      name: "Example Mod",
      description: "An example.",
      entrypoints: { main: ["com.example.ExampleMod"], client: [{ value: "com.example.ExampleClient" }] },
      mixins: ["examplemod.mixins.json"],
      accessWidener: "examplemod.accesswidener",
      depends: { minecraft: "~1.21.1", fabricloader: ">=0.15.0" },
      suggests: { modmenu: "*" },
      jars: [{ file: "META-INF/jars/lib-1.0.jar" }]
    }),
    "com/example/ExampleMod.class": MOJANG_CLASS,
    "com/example/ExampleMod$Inner.class": MOJANG_CLASS,
    "com/example/client/ExampleClient.class": MOJANG_CLASS,
    "examplemod.mixins.json": "{}",
    "examplemod.accesswidener": "accessWidener v2 named\n",
    "META-INF/jars/lib-1.0.jar": Buffer.from([0x50, 0x4b, 0x05, 0x06])
  });
  await createJar(quiltJar, {
    "quilt.mod.json": JSON.stringify({
      schema_version: 1,
      quilt_loader: {
        group: "com.example",
        id: "quiltmod",
        version: "2.0.0",
        metadata: { name: "Quilt Mod", description: "A Quilt example." },
        entrypoints: { init: ["com.example.QuiltMod"] },
        depends: [{ id: "minecraft", versions: ">=1.21.1" }, "quilt_loader"]
      },
      mixin: "quiltmod.mixins.json",
      access_widener: "quiltmod.accesswidener"
    }),
    "com/example/QuiltMod.class": MOJANG_CLASS
  });
  await createJar(forgeJar, {
    "META-INF/mods.toml": [
      'modLoader="javafml"',
      'loaderVersion="[47,)"',
      "[[mods]]",
      'modId="forgemod"',
      'version="3.0.0"',
      'displayName="Forge Mod"',
      "[[dependencies.forgemod]]",
      'modId="minecraft"',
      "mandatory=true",
      'versionRange="[1.20.1,1.21)"',
      ""
    ].join("\n"),
    "META-INF/accesstransformer.cfg": "public net.minecraft.world.level.Level\n",
    "com/example/forge/ForgeMod.class": MOJANG_CLASS
  });
  await createJar(plainJar, { "readme.txt": "no loader metadata" });
  writeFileSync(brokenJar, "this is not a zip archive");
  await createJar(versionlessJar, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "versionless", version: "0.1.0" }),
    "com/example/Versionless.class": MOJANG_CLASS
  });
  await createJar(unclassifiedJar, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "unclassified",
      version: "1.0.0",
      depends: { minecraft: "1.21.1" }
    }),
    "com/example/Unclassified.class": NEUTRAL_CLASS
  });
  await createJar(sourcesJar, {
    "com/example/ExampleMod.java": EXAMPLE_MOD_SOURCE,
    "com/example/Registry.java": REGISTRY_SOURCE
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
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(actual?.[key], expected?.[key], `${label}: ${key}`);
  }
}

/** The directory's file names, to show that a call wrote nothing there. */
function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

// ---------------------------------------------------------------------------
// mod-inspect
// ---------------------------------------------------------------------------

test("mod-inspect matches analyze-mod-jar for Fabric, Quilt and Forge jars", async () => {
  for (const jarPath of [fabricJar, quiltJar, forgeJar]) {
    const legacy = (await eightX("analyze-mod-jar", { jarPath })).envelope.result!;
    const { envelope, isError } = await catalog("mod-inspect", { jarPath });
    assert.equal(isError, false);
    assert.deepEqual(envelope.result!.mod, legacy, `${jarPath}: the metadata is returned unchanged`);
    assert.equal("classes" in envelope.result!.mod, false, "no class list without withClasses");
  }
  const fabric = (await catalog("mod-inspect", { jarPath: fabricJar })).envelope.result!.mod;
  assert.equal(fabric.loader, "fabric", "positive control: the Fabric metadata was read");
  assert.equal(fabric.modId, "examplemod");
  assert.deepEqual(fabric.nestedJars, ["META-INF/jars/lib-1.0.jar"]);
});

test("mod-inspect withClasses lists the class entries as binary class names, inner classes included", async () => {
  const legacy = (await eightX("analyze-mod-jar", { jarPath: fabricJar, includeClasses: true })).envelope.result!;
  const { envelope } = await catalog("mod-inspect", { jarPath: fabricJar, withClasses: true });
  const mod = envelope.result!.mod;
  assert.deepEqual(mod.classes, [
    "com.example.ExampleMod",
    "com.example.ExampleMod$Inner",
    "com.example.client.ExampleClient"
  ]);
  assert.deepEqual(
    mod.classes,
    legacy.classes.map((entry: string) => entry.replace(/\.class$/, "").replaceAll("/", ".")),
    "the same entries analyze-mod-jar lists as paths"
  );
  const { classes: _catalogClasses, ...catalogRest } = mod;
  const { classes: _legacyClasses, ...legacyRest } = legacy;
  assert.deepEqual(catalogRest, legacyRest, "every other field is unchanged");
  assert.equal(mod.classCount, mod.classes.length);
});

test("mod-inspect fails like analyze-mod-jar on a missing jar and on a file that is not a zip archive", async () => {
  for (const jarPath of [brokenJar, join(MODS, "missing.jar")]) {
    const legacy = (await eightX("analyze-mod-jar", { jarPath })).envelope.error;
    const { envelope, isError } = await catalog("mod-inspect", { jarPath });
    assert.equal(isError, true);
    assertSameFailure(envelope.error, legacy, jarPath);
    assert.equal(envelope.error?.detail, legacy?.detail, `${jarPath}: same message`);
  }
  assert.equal(
    (await catalog("mod-inspect", { jarPath: brokenJar })).envelope.error?.code,
    "ERR_SOURCE_NOT_FOUND",
    "positive control: the broken archive is reported as unreadable"
  );
});

test("mod tools read a jar given as a \\\\wsl.localhost path on a WSL host", { skip: process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host" }, async () => {
  const distro = "catalog-distro";
  const unc = (path: string) => `\\\\wsl.localhost\\${distro}\\${path.replace(/^\//, "").replace(/\//g, "\\")}`;
  await withEnv({ WSL_DISTRO_NAME: distro }, async () => {
    const inspected = await catalog("mod-inspect", { jarPath: unc(fabricJar) });
    assert.equal(inspected.envelope.result?.mod.modId, "examplemod", `the UNC spelling ${unc(fabricJar)} reads the jar`);

    const before = listing(MODS);
    const preview = await catalog("mod-remap", {
      jarPath: unc(fabricJar),
      toMapping: "mojang",
      outputJar: unc(join(MODS, "wsl-out.jar"))
    });
    assert.equal(preview.isError, false, JSON.stringify(preview.envelope.error));
    assert.equal(preview.envelope.result?.remap.jarPath, fabricJar, "the input path is reported in its host form");
    assert.equal(preview.envelope.result?.remap.outputJar, join(MODS, "wsl-out.jar"), "so is the output path");
    assert.deepEqual(listing(MODS), before);

    const guarded = await catalog("mod-remap", { jarPath: unc(fabricJar), toMapping: "mojang", outputJar: fabricJar });
    assert.equal(guarded.envelope.error?.code, "ERR_INVALID_INPUT", "the UNC input and its host form are one file");
    assert.deepEqual(guarded.envelope.error?.fieldErrors?.map((entry) => entry.path), ["outputJar"]);
  });
});

// ---------------------------------------------------------------------------
// mod-search
// ---------------------------------------------------------------------------

test("mod-search matches search-mod-source on a sources jar and leaves out the sources-jar notice", async () => {
  for (const searchType of ["all", "class", "method", "field", "content"] as const) {
    const request = { jarPath: sourcesJar, query: "regist", searchType };
    const legacy = (await eightX("search-mod-source", request)).envelope;
    assert.ok(JSON.stringify(legacy).includes(SOURCE_JAR_NOTICE), "positive control: the service reports the sources-jar notice");
    const { envelope, text } = await catalog("mod-search", request);
    assert.deepEqual(envelope.result!.hits, legacy.result!.hits, `${searchType}: the same hits`);
    assert.equal(text.includes("Detected source jar"), false, "the notice is routine");
    assert.equal(envelope.meta.truncation, undefined, `${searchType}: nothing was cut`);
    assert.equal("totalHits" in envelope.result!, false);
  }
  const all = (await catalog("mod-search", { jarPath: sourcesJar, query: "regist" })).envelope.result!.hits;
  assert.ok(all.some((hit: { type: string }) => hit.type === "method"), "positive control: method hits are found");
  assert.ok(all.some((hit: { type: string; name: string }) => hit.type === "class" && hit.name === "com.example.Registry"));
});

test("mod-search reports a cut at limit in meta.truncation and treats no hits as ok", async () => {
  const legacy = (await eightX("search-mod-source", { jarPath: sourcesJar, query: "register", limit: 2 })).envelope.result!;
  assert.equal(legacy.truncated, true, "positive control: the service cut the hits at the limit");
  const cut = await catalog("mod-search", { jarPath: sourcesJar, query: "register", limit: "2" });
  assert.deepEqual(cut.envelope.result!.hits, legacy.hits);
  assert.equal(cut.envelope.result!.hits.length, 2);
  assert.deepEqual(cut.envelope.meta.truncation, [{ field: "hits", limitedBy: "limit" }]);

  const whole = await catalog("mod-search", { jarPath: sourcesJar, query: "register" });
  assert.ok(whole.envelope.result!.hits.length > 2, "the default limit returns every hit");
  assert.equal(whole.envelope.meta.truncation, undefined);

  const none = await catalog("mod-search", { jarPath: sourcesJar, query: "no-such-text" });
  assert.equal(none.isError, false);
  assert.deepEqual(none.envelope.result, { hits: [] });
  assert.equal(none.envelope.meta.truncation, undefined);
});

test("mod-search reads a query as literal text when it is not a valid regular expression", async () => {
  const request = { jarPath: sourcesJar, query: "register(\"item", searchType: "content" };
  const legacy = (await eightX("search-mod-source", request)).envelope.result!;
  const { envelope } = await catalog("mod-search", request);
  assert.deepEqual(envelope.result!.hits, legacy.hits);
  assert.equal(envelope.result!.hits.length, 1);
});

// ---------------------------------------------------------------------------
// mod-remap
// ---------------------------------------------------------------------------

test("mod-remap previews without writing, reporting the output path and whether it exists", async () => {
  const before = listing(MODS);
  const defaultOutput = join(MODS, "examplemod-1.0.0-mojang.jar");
  const preview = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "mojang" });
  assert.equal(preview.isError, false, JSON.stringify(preview.envelope.error));
  assert.deepEqual(preview.envelope.result, {
    remap: {
      mode: "preview",
      jarPath: fabricJar,
      outputJar: defaultOutput,
      outputExists: false,
      toMapping: "mojang",
      loader: "fabric",
      modId: "examplemod",
      modVersion: "1.0.0",
      version: "1.21.1"
    }
  });
  assert.deepEqual(listing(MODS), before, "the preview wrote nothing");
  assert.equal(existsSync(join(cacheDir, "remapped-mods")), false, "nor anything in the remap cache");
  assert.deepEqual(preview.envelope.meta.nextActions, [
    {
      tool: "mod-remap",
      params: { jarPath: fabricJar, toMapping: "mojang", apply: true },
      reason: `Write ${defaultOutput}.`
    }
  ]);

  const existing = join(MODS, "existing-output.jar");
  writeFileSync(existing, "keep me");
  const overwriting = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "yarn", outputJar: existing, version: "1.21.4" });
  assert.equal(overwriting.envelope.result!.remap.outputExists, true);
  assert.equal(overwriting.envelope.result!.remap.version, "1.21.4", "an explicit version wins over the metadata");
  assert.equal(readFileSync(existing, "utf8"), "keep me", "the preview leaves an existing output untouched");
  assert.match(overwriting.envelope.meta.nextActions![0]!.reason!, /replacing the existing file/);
  assert.deepEqual(overwriting.envelope.meta.nextActions![0]!.params, {
    jarPath: fabricJar,
    toMapping: "yarn",
    outputJar: existing,
    version: "1.21.4",
    apply: true
  });
  assert.deepEqual(fetchedUrls, [], "no network");
});

test("mod-remap without a Minecraft version previews with a template and fails to apply naming version", async () => {
  const before = listing(MODS);
  const preview = await catalog("mod-remap", { jarPath: versionlessJar, toMapping: "mojang" });
  assert.equal(preview.envelope.result!.remap.version, undefined);
  assert.deepEqual(preview.envelope.meta.warnings?.map((warning) => [warning.code, warning.severity]), [
    ["version-unresolved", "warning"]
  ]);
  assert.deepEqual(preview.envelope.meta.nextActions, [
    {
      tool: "mod-remap",
      params: { jarPath: versionlessJar, toMapping: "mojang", version: "<minecraft-version>", apply: true },
      reason: "Remap with the Minecraft version the mod targets.",
      template: true
    }
  ]);
  const applied = await catalog("mod-remap", { jarPath: versionlessJar, toMapping: "mojang", apply: true });
  assert.equal(applied.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(applied.envelope.error?.fieldErrors?.map((entry) => entry.path), ["version"]);
  assert.deepEqual(listing(MODS), before, "nothing was written");
});

test("mod-remap apply writes the same jar as remap-mod-jar and keeps the copy warning", async () => {
  const legacyOutput = join(root, "out", "legacy.jar");
  const catalogOutput = join(root, "out", "catalog.jar");
  const legacy = await eightX("remap-mod-jar", {
    inputJar: fabricJar,
    targetMapping: "mojang",
    outputJar: legacyOutput,
    forceRemap: true
  });
  assert.equal(legacy.isError, false, JSON.stringify(legacy.envelope.error));
  const { envelope, isError } = await catalog("mod-remap", {
    jarPath: fabricJar,
    toMapping: "mojang",
    outputJar: catalogOutput,
    force: true,
    apply: true
  });
  assert.equal(isError, false, JSON.stringify(envelope.error));
  const legacyResult = legacy.envelope.result!;
  const remap = envelope.result!.remap;
  assert.equal(remap.mode, "apply");
  assert.equal(remap.outputJar, catalogOutput);
  assert.equal(remap.version, legacyResult.mcVersion);
  assert.equal(remap.fromMapping, legacyResult.fromMapping);
  assert.equal(remap.toMapping, legacyResult.targetMapping);
  assert.equal(remap.resolvedTargetNamespace, legacyResult.resolvedTargetNamespace);
  assert.equal(typeof remap.durationMs, "number");
  assert.equal("fromCache" in remap, false, "a fresh copy is not served from the remap cache");
  assert.deepEqual(readFileSync(catalogOutput), readFileSync(legacyOutput), "the written jars are identical");
  assert.deepEqual(readFileSync(catalogOutput), readFileSync(fabricJar), "a jar already in mojang names is copied");
  assert.deepEqual(envelope.meta.warnings, [
    {
      code: "general",
      severity: "info",
      message: "Input JAR already uses mojang names; output is a copy of the input JAR."
    }
  ]);
  assert.deepEqual(fetchedUrls, [], "no network");
});

test("mod-remap apply replaces an existing outputJar", async () => {
  const output = join(root, "out", "existing.jar");
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(output, "old contents");
  const preview = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "mojang", outputJar: output });
  assert.equal(preview.envelope.result!.remap.outputExists, true);
  const applied = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "mojang", outputJar: output, apply: true });
  assert.equal(applied.isError, false, JSON.stringify(applied.envelope.error));
  assert.deepEqual(readFileSync(output), readFileSync(fabricJar));
});

test("mod-remap rejects an outputJar that is the input jar, in preview and apply, and writes nothing", async () => {
  const link = join(root, "link-to-examplemod.jar");
  symlinkSync(fabricJar, link);
  const hardLink = join(root, "hard-link-to-examplemod.jar");
  linkSync(fabricJar, hardLink);
  // `mods/linked-dir/..` is the parent of the linked directory's target, not `mods`.
  const elsewhere = join(root, "elsewhere", "deeper");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(MODS, "linked-dir"));
  const original = readFileSync(fabricJar);
  const before = listing(MODS);
  const spellings = [fabricJar, `${MODS}/../mods/examplemod-1.0.0.jar`, link, hardLink];
  for (const outputJar of spellings) {
    for (const apply of [false, true]) {
      const { envelope, isError } = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "mojang", outputJar, apply });
      assert.equal(isError, true, `${outputJar} apply=${apply}`);
      assert.equal(envelope.error?.code, "ERR_INVALID_INPUT");
      assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), ["outputJar"], `${outputJar} apply=${apply}`);
    }
  }
  // The default output name equals the input when the input is itself an earlier output.
  const earlierOutput = join(root, "earlier", "examplemod-1.0.0-mojang.jar");
  mkdirSync(join(root, "earlier"), { recursive: true });
  writeFileSync(earlierOutput, original);
  for (const apply of [false, true]) {
    const { envelope } = await catalog("mod-remap", { jarPath: earlierOutput, toMapping: "mojang", apply });
    assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), ["outputJar"], `default output apply=${apply}`);
  }
  assert.deepEqual(readFileSync(fabricJar), original, "the input jar is unchanged");
  assert.deepEqual(readFileSync(earlierOutput), original);
  assert.deepEqual(listing(MODS), before);

  const allowed = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "mojang", outputJar: join(MODS, "other.jar") });
  assert.equal(allowed.isError, false, "positive control: another output path is accepted");

  const throughLinkedDir = `${MODS}/linked-dir/../examplemod-1.0.0.jar`;
  for (const apply of [false, true]) {
    const distinct = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "mojang", outputJar: throughLinkedDir, apply });
    assert.equal(distinct.isError, false, `${throughLinkedDir} is another file (apply=${apply}): ${JSON.stringify(distinct.envelope.error)}`);
  }
  assert.deepEqual(readFileSync(join(root, "elsewhere", "examplemod-1.0.0.jar")), original, "apply wrote the distinct output");
  assert.deepEqual(readFileSync(fabricJar), original, "the input jar is still unchanged");
});

test("mod-remap rejects an outputJar that is a directory, in preview and apply", async () => {
  const directory = join(root, "a-directory");
  mkdirSync(directory, { recursive: true });
  for (const apply of [false, true]) {
    const { envelope, isError } = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "mojang", outputJar: directory, apply });
    assert.equal(isError, true, `apply=${apply}`);
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), ["outputJar"]);
    assert.match(envelope.error?.detail ?? "", /is a directory/);
  }
  assert.deepEqual(readdirSync(directory), [], "nothing was written into it");
});

test("mod-remap rejects a loader it cannot remap with the error remap-mod-jar raises, in preview and apply", async () => {
  for (const [jarPath, loader] of [[forgeJar, "forge"], [plainJar, "unknown"]] as const) {
    const legacy = (await eightX("remap-mod-jar", { inputJar: jarPath, targetMapping: "mojang" })).envelope.error!;
    assert.equal(legacy.code, "ERR_REMAP_FAILED", `positive control: remap-mod-jar refuses the ${loader} jar`);
    const preview = (await catalog("mod-remap", { jarPath, toMapping: "mojang" })).envelope.error!;
    const applied = (await catalog("mod-remap", { jarPath, toMapping: "mojang", apply: true })).envelope.error!;
    for (const key of ["code", "detail", "retryClass", "issueOrigin", "hints", "fieldErrors", "context"]) {
      assert.deepEqual(preview[key], legacy[key], `${loader} preview: ${key}`);
      assert.deepEqual(applied[key], legacy[key], `${loader} apply: ${key}`);
    }
  }
});

test("mod-remap fails like remap-mod-jar on a missing jar and names jarPath for a path that is not a jar", async () => {
  const missing = join(MODS, "missing-mod.jar");
  const legacy = (await eightX("remap-mod-jar", { inputJar: missing, targetMapping: "yarn" })).envelope.error;
  const { envelope } = await catalog("mod-remap", { jarPath: missing, toMapping: "yarn" });
  assertSameFailure(envelope.error, legacy, "missing jar");
  assert.equal(envelope.error?.detail, legacy?.detail);

  const notJar = await catalog("mod-remap", { jarPath: join(MODS, "notes.txt"), toMapping: "yarn" });
  assert.equal(notJar.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(notJar.envelope.error?.fieldErrors?.map((entry) => entry.path), ["jarPath"]);
});

test("mod-remap previews a Mojang-named jar for yarn and refuses on apply with a hint naming toMapping", async () => {
  // A cached Yarn build for 1.21.1 keeps the mapping lookup offline; the
  // refusal comes after it, once the jar's names are found to be Mojang names.
  const yarnDir = join(cacheDir, "mappings", "yarn");
  mkdirSync(yarnDir, { recursive: true });
  writeFileSync(
    join(yarnDir, "1.21.1.meta.json"),
    JSON.stringify({ coordinate: "net.fabricmc:yarn:1.21.1+build.3", fetchedAt: Date.now() })
  );
  writeFileSync(join(yarnDir, "net.fabricmc:yarn:1.21.1+build.3.tiny"), "tiny\t2\t0\tintermediary\tnamed\n");

  const preview = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "yarn" });
  assert.equal(preview.isError, false, "the preview does not read the jar's namespace");

  const legacy = (await eightX("remap-mod-jar", {
    inputJar: fabricJar,
    targetMapping: "yarn",
    outputJar: join(root, "out", "yarn-legacy.jar")
  })).envelope.error!;
  assert.equal(legacy.code, "ERR_REMAP_FAILED", "positive control: remap-mod-jar refuses the Mojang-named jar");
  assert.ok(legacy.hints?.some((hint: string) => hint.includes('targetMapping="mojang"')), "the 8.x hint names targetMapping");

  const output = join(root, "out", "yarn.jar");
  const { envelope, isError } = await catalog("mod-remap", { jarPath: fabricJar, toMapping: "yarn", outputJar: output, apply: true });
  assert.equal(isError, true);
  for (const key of ["code", "detail", "retryClass", "issueOrigin"]) {
    assert.deepEqual(envelope.error?.[key], legacy[key], key);
  }
  assert.deepEqual(envelope.error?.hints, [
    'Use toMapping: "mojang" for Mojang-mapped inputs, or rebuild the mod against intermediary mappings before requesting yarn output.'
  ]);
  assert.equal(existsSync(output), false);
  assert.deepEqual(fetchedUrls, [], "no network");
});

test("mod-remap leaves out the remap-cache notice and keeps the warnings that need attention", async () => {
  // A cache entry for this jar, keyed the way the remap service keys an
  // intermediary-to-mojang remap: the jar's names cannot be classified, so the
  // service assumes intermediary and warns.
  const version = "1.21.1";
  const stat = statSync(unclassifiedJar);
  const key = createHash("sha256")
    .update(`v3|${unclassifiedJar}|${stat.mtimeMs}:${stat.size}|intermediary|mojang|${version}|${version}-mojang-merged.tiny`)
    .digest("hex");
  mkdirSync(join(cacheDir, "remapped-mods"), { recursive: true });
  const cached = Buffer.from("cached remap output");
  writeFileSync(join(cacheDir, "remapped-mods", `${key}.jar`), cached);

  const legacyOutput = join(root, "out", "unclassified-legacy.jar");
  const legacy = await eightX("remap-mod-jar", { inputJar: unclassifiedJar, targetMapping: "mojang", outputJar: legacyOutput });
  assert.ok(
    JSON.stringify(legacy.envelope).includes(CACHE_NOTICE),
    "positive control: the service answered from the cache and said so"
  );

  const output = join(root, "out", "unclassified.jar");
  const { envelope, text } = await catalog("mod-remap", {
    jarPath: unclassifiedJar,
    toMapping: "mojang",
    outputJar: output,
    apply: true
  });
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.deepEqual(readFileSync(output), cached, "the cached jar was served");
  assert.equal(envelope.result!.remap.fromCache, true, "the cache hit is reported in the result");
  assert.equal(text.includes(CACHE_NOTICE), false, "the cache notice is routine");
  assert.ok(
    envelope.meta.warnings?.some((warning) => warning.message.startsWith("Could not confidently detect")),
    "positive control: the namespace warning in the same reply is kept"
  );
  assert.deepEqual(fetchedUrls, [], "no network");
});

test("the sources-jar and remap-cache notices are routine; an actionable warning stays", () => {
  const actionable = "Input JAR already uses mojang names; output is a copy of the input JAR.";
  const warnings = buildCatalogWarnings([SOURCE_JAR_NOTICE, CACHE_NOTICE, actionable], "mod-remap");
  assert.deepEqual(warnings.map((warning) => warning.message), [actionable]);
  assert.deepEqual(
    buildCatalogWarnings([`${CACHE_NOTICE} Extra.`, `Note: ${SOURCE_JAR_NOTICE}`], "mod-search").length,
    2,
    "only the whole sentences are routine"
  );
});

// ---------------------------------------------------------------------------
// Strict input
// ---------------------------------------------------------------------------

test("every mod tool validates its examples and rejects unknown, misspelled and out-of-range keys", async () => {
  const nearMisses: Record<string, [string, string]> = {
    "mod-inspect": ["withClass", "withClasses"],
    "mod-search": ["serchType", "searchType"],
    "mod-remap": ["toMaping", "toMapping"]
  };
  for (const spec of MOD_TOOL_SPECS) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
      const reply = await catalog(spec.name, example);
      assert.notEqual(reply.envelope.error?.detail, "Request validation failed.", `${spec.name} example passes validation`);
    }
    const example = spec.examples[spec.examples.length - 1]! as Record<string, unknown>;

    const unknownTop = await catalog(spec.name, { ...example, bogusKey: 1 });
    assert.equal(unknownTop.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(unknownTop.envelope.error?.fieldErrors?.map((entry) => entry.path), ["bogusKey"], spec.name);

    const [misspelled, declared] = nearMisses[spec.name]!;
    const { [declared]: value, ...rest } = example;
    const nearMiss = await catalog(spec.name, { ...rest, [misspelled]: value ?? true });
    assert.equal(nearMiss.envelope.error?.code, "ERR_INVALID_INPUT");
    const entry = nearMiss.envelope.error?.fieldErrors?.find((fieldError) => fieldError.path === misspelled);
    assert.ok(entry?.suggestions?.includes(declared), `${spec.name}: "${misspelled}" suggests "${declared}"`);
  }

  const rejected: Array<[string, Record<string, unknown>, string[]]> = [
    ["mod-search", { jarPath: sourcesJar, query: "register", limit: 201 }, ["limit"]],
    ["mod-search", { jarPath: sourcesJar, query: "x".repeat(201) }, ["query"]],
    ["mod-search", { jarPath: sourcesJar, query: "   " }, ["query"]],
    ["mod-remap", { jarPath: fabricJar, toMapping: "intermediary" }, ["toMapping"]],
    ["mod-remap", { inputJar: fabricJar, toMapping: "mojang" }, ["jarPath", "inputJar"]],
    ["mod-inspect", { jarPath: fabricJar, includeClasses: true }, ["includeClasses"]]
  ];
  for (const [name, request, paths] of rejected) {
    const reply = await catalog(name, request);
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", `${name} ${JSON.stringify(request)}`);
    assert.deepEqual(
      reply.envelope.error?.fieldErrors?.map((entry) => entry.path).sort(),
      [...paths].sort(),
      `${name} names ${paths.join(", ")}`
    );
  }

  const padded = await catalog("mod-search", { jarPath: sourcesJar, query: ` ${"x".repeat(200)} ` });
  assert.equal(padded.isError, false, "the 200-character limit applies to the trimmed query");
});
