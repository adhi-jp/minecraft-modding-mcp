/**
 * Validation family (project-validate, mixin-validate) through the in-process
 * MCP session that serves the catalog and the 8.x tools side by side. Every
 * 8.x counterpart runs on the same fixtures through the same session; only
 * the I/O boundaries are stubbed (every other URL is a 404; nothing reaches
 * the network and no Java process runs).
 *
 * Fixtures:
 *  - a stubbed Mojang manifest naming client jars built from class files:
 *    1.21.10 (obfuscated names, checked with `mapping: "obfuscated"`), 26.1
 *    (an unobfuscated runtime, so Mojang names need no mapping files) and
 *    1.21.9 (obfuscated names with the Mojang client mappings of the
 *    mapping-service tests, `com.mojang.NamedClass` for `a.b.C`); all hold
 *    `a.b.C` with field `d` and method `m()`;
 *  - temporary Loom projects with gradle.properties, build.gradle, a mixin
 *    config and mixin sources (one valid mixin, one with a missing method and
 *    field, one with a missing target class), some with a fabric.mod.json and
 *    an access widener; the projects differ in what they declare: version and
 *    mapping, only one of them, neither, or no files to validate;
 *  - access wideners checked with `mapping: "intermediary"` on 1.21.10, whose
 *    mapping files cannot be downloaded here, so their class names cannot be
 *    mapped (the uncertain entries of access-validate);
 *  - for the outcomes the fixtures cannot produce (an uncertain error, the
 *    automatic retry, a budget note, a failed source), the tool runs on a
 *    stubbed validation service through `runCatalogTool`.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdir, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import fastGlob from "fast-glob";

import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import {
  catalogServiceText,
  mixinValidateSpec,
  projectValidateSpec,
  VALIDATION_TOOL_SPECS
} from "../../src/tools/families/validation.ts";
import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { translateServiceSuggestedCall } from "../../src/tools/translation.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import { DETAIL_LEVELS } from "../../src/tools/schemas.ts";
import type { CatalogServices, CatalogToolSpec } from "../../src/tools/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withEnv } from "../helpers/env.ts";
import { TEST_MOJANG_CLIENT_MAPPINGS } from "../helpers/mapping-service-fixtures.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-validation-"));
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
/** Obfuscated names with Mojang client mappings, so Mojang names map through the real mapping service. */
const MAPPED_VERSION = "1.21.9";
const VERSIONS = [OBF_VERSION, MOJ_VERSION, MAPPED_VERSION];
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
    const mappings = id === MAPPED_VERSION ? { client_mappings: { url: `https://manifest.test/mappings/${id}.txt` } } : {};
    return new Response(
      JSON.stringify({ id, downloads: { client: { url: `https://manifest.test/jars/${id}.jar` }, ...mappings }, libraries: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const jar = /^https:\/\/manifest\.test\/jars\/(.+)\.jar$/.exec(url);
  if (jar !== null && clientJars.has(jar[1]!)) {
    return new Response(clientJars.get(jar[1]!), { status: 200 });
  }
  if (url === `https://manifest.test/mappings/${MAPPED_VERSION}.txt`) {
    return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const MIXIN_IMPORTS = [
  "package com.example.mixin;",
  "import org.spongepowered.asm.mixin.Mixin;",
  "import org.spongepowered.asm.mixin.Shadow;",
  "import org.spongepowered.asm.mixin.injection.Inject;",
  "import org.spongepowered.asm.mixin.injection.At;",
  "import a.b.C;"
];
const GOOD_MIXIN = [
  ...MIXIN_IMPORTS,
  "@Mixin(C.class)",
  "public abstract class GoodMixin {",
  "  @Shadow private int d;",
  '  @Inject(method = "m", at = @At("HEAD"))',
  "  private void onM() {}",
  "}",
  ""
].join("\n");
const BAD_MIXIN = [
  ...MIXIN_IMPORTS,
  "@Mixin(C.class)",
  "public abstract class BadMixin {",
  "  @Shadow private int nope;",
  '  @Inject(method = "missing", at = @At("HEAD"))',
  "  private void onMissing() {}",
  "}",
  ""
].join("\n");
const MISSING_TARGET_MIXIN = [
  "package com.example.mixin;",
  "import org.spongepowered.asm.mixin.Mixin;",
  '@Mixin(targets = "a.b.Missing")',
  "public abstract class MissingMixin {}",
  ""
].join("\n");
const MIXIN_SOURCES: Record<string, string> = {
  GoodMixin: GOOD_MIXIN,
  BadMixin: BAD_MIXIN,
  MissingMixin: MISSING_TARGET_MIXIN
};

type ProjectSpec = {
  version?: string;
  mojangMappings?: boolean;
  mixins?: readonly string[];
  accessWidener?: "valid" | "invalid";
  accessTransformer?: boolean;
};

const MIXIN_DIR = join("src", "main", "java", "com", "example", "mixin");
const RESOURCES = join("src", "main", "resources");

function writeProject(name: string, spec: ProjectSpec): string {
  const dir = join(root, "projects", name);
  mkdirSync(join(dir, MIXIN_DIR), { recursive: true });
  mkdirSync(join(dir, RESOURCES), { recursive: true });
  writeFileSync(
    join(dir, "gradle.properties"),
    spec.version !== undefined ? `minecraft_version=${spec.version}\n` : "org.gradle.jvmargs=-Xmx1G\n"
  );
  writeFileSync(
    join(dir, "build.gradle"),
    spec.mojangMappings === true ? "dependencies {\n  mappings loom.officialMojangMappings()\n}\n" : "dependencies {\n}\n"
  );
  const mixins = spec.mixins ?? [];
  for (const mixin of mixins) {
    writeFileSync(join(dir, MIXIN_DIR, `${mixin}.java`), MIXIN_SOURCES[mixin]!);
  }
  if (mixins.length > 0) {
    writeFileSync(
      join(dir, RESOURCES, "example.mixins.json"),
      JSON.stringify({ package: "com.example.mixin", mixins })
    );
  }
  if (spec.accessWidener !== undefined) {
    writeFileSync(
      join(dir, RESOURCES, "fabric.mod.json"),
      JSON.stringify({ schemaVersion: 1, id: "example", version: "1.0.0", accessWidener: "example.accesswidener" })
    );
    const field = spec.accessWidener === "valid" ? "d" : "nope";
    writeFileSync(
      join(dir, RESOURCES, "example.accesswidener"),
      `accessWidener v2 official\naccessible class a/b/C\naccessible field a/b/C ${field} I\n`
    );
  }
  if (spec.accessTransformer === true) {
    mkdirSync(join(dir, RESOURCES, "META-INF"), { recursive: true });
    writeFileSync(join(dir, RESOURCES, "META-INF", "accesstransformer.cfg"), "public a.b.C\n");
  }
  return dir;
}

const ALL_MIXINS = ["GoodMixin", "BadMixin", "MissingMixin"] as const;
/**
 * 1.21.10, no mapping declaration (checked with an explicit `obfuscated`),
 * three mixins, an invalid widener, and an access transformer although the
 * build names no Forge or NeoForge loader.
 */
const OBF = writeProject("obf", {
  version: OBF_VERSION,
  mixins: ALL_MIXINS,
  accessWidener: "invalid",
  accessTransformer: true
});
/** 26.1 with Mojang mappings declared: version and mapping are read from the project. */
const MOJ = writeProject("mojang", { version: MOJ_VERSION, mojangMappings: true, mixins: ALL_MIXINS });
/** 26.1 with Mojang mappings and only the valid mixin. */
const GOOD = writeProject("good", { version: MOJ_VERSION, mojangMappings: true, mixins: ["GoodMixin"] });
/** Mojang mappings declared, no Minecraft version. */
const NO_VERSION = writeProject("no-version", { mojangMappings: true, mixins: ["GoodMixin"] });
/** Neither a version nor a mapping declared. */
const BARE = writeProject("bare", { mixins: ["GoodMixin"] });
/** A version but no mapping declared, and only a valid access widener. */
const WIDENER_ONLY = writeProject("widener-only", { version: OBF_VERSION, accessWidener: "valid" });
/** Version and mapping declared, nothing to validate. */
const EMPTY = writeProject("empty", { version: MOJ_VERSION, mojangMappings: true });

/** One project with three access wideners the service rejects without a failing entry, or with a legality issue. */
const WIDENER_CASES = join(root, "projects", "widener-cases");
const WIDENER_FILES: Record<string, string> = {
  header: "accessWidener v99 official\naccessible class a/b/C\n",
  kind: "accessWidener v2 official\naccessible class a/b/C\nbogus field a/b/C d I\n",
  legality: "accessWidener v2 official\naccessible class a/b/C\nextendable field a/b/C d I\n"
};
mkdirSync(WIDENER_CASES, { recursive: true });
writeFileSync(join(WIDENER_CASES, "gradle.properties"), `minecraft_version=${OBF_VERSION}\n`);
writeFileSync(join(WIDENER_CASES, "build.gradle"), "dependencies {\n}\n");
for (const [name, content] of Object.entries(WIDENER_FILES)) {
  const resources = join(WIDENER_CASES, name, RESOURCES);
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(resources, "fabric.mod.json"),
    JSON.stringify({ schemaVersion: 1, id: name, version: "1.0.0", accessWidener: `${name}.accesswidener` })
  );
  writeFileSync(join(resources, `${name}.accesswidener`), content);
}
/**
 * One project with two access wideners checked as intermediary names: one
 * whose only failures are classes that cannot be mapped, one that adds a rule
 * violation, a rejected line and a header the mapping overrides.
 */
const UNMAPPED_CASES = join(root, "projects", "unmapped-cases");
const UNMAPPED_FILES: Record<string, string> = {
  uncertain: "accessWidener v2 intermediary\naccessible class net/minecraft/class_9999\naccessible field a/b/C nope I\n",
  mixed: "accessWidener v2 official\naccessible class net/minecraft/class_9999\nextendable field a/b/C d I\nbogus field a/b/C d I\n"
};
mkdirSync(UNMAPPED_CASES, { recursive: true });
writeFileSync(join(UNMAPPED_CASES, "gradle.properties"), `minecraft_version=${OBF_VERSION}\n`);
writeFileSync(join(UNMAPPED_CASES, "build.gradle"), "dependencies {\n}\n");
for (const [name, content] of Object.entries(UNMAPPED_FILES)) {
  const resources = join(UNMAPPED_CASES, name, RESOURCES);
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(resources, "fabric.mod.json"),
    JSON.stringify({ schemaVersion: 1, id: name, version: "1.0.0", accessWidener: `${name}.accesswidener` })
  );
  writeFileSync(join(resources, `${name}.accesswidener`), content);
}
const unmappedFile = (name: string) => join(UNMAPPED_CASES, name, RESOURCES, `${name}.accesswidener`);
/**
 * A 1.21.9 project declaring Mojang mappings with two access wideners that
 * name the same Mojang class and field: one under a `named` header (the
 * project's development names), one under an `intermediary` header.
 */
const HEADER_CASES = join(root, "projects", "header-cases");
const MOJANG_ENTRIES = "accessible class com/mojang/NamedClass\naccessible field com/mojang/NamedClass namedField I\n";
const HEADER_FILES: Record<string, string> = {
  named: `accessWidener v2 named\n${MOJANG_ENTRIES}`,
  intermediary: `accessWidener v2 intermediary\n${MOJANG_ENTRIES}`
};
mkdirSync(HEADER_CASES, { recursive: true });
writeFileSync(join(HEADER_CASES, "gradle.properties"), `minecraft_version=${MAPPED_VERSION}\n`);
writeFileSync(join(HEADER_CASES, "build.gradle"), "dependencies {\n  mappings loom.officialMojangMappings()\n}\n");
for (const [name, content] of Object.entries(HEADER_FILES)) {
  const resources = join(HEADER_CASES, name, RESOURCES);
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(resources, "fabric.mod.json"),
    JSON.stringify({ schemaVersion: 1, id: name, version: "1.0.0", accessWidener: `${name}.accesswidener` })
  );
  writeFileSync(join(resources, `${name}.accesswidener`), content);
}
/** A config that lists a mixin whose source file does not exist. */
const ABSENT = join(root, "projects", "absent");
mkdirSync(join(ABSENT, RESOURCES), { recursive: true });
writeFileSync(join(ABSENT, "gradle.properties"), `minecraft_version=${OBF_VERSION}\n`);
writeFileSync(join(ABSENT, "build.gradle"), "dependencies {\n}\n");
writeFileSync(join(ABSENT, RESOURCES, "example.mixins.json"), JSON.stringify({ package: "com.example.mixin", mixins: ["AbsentMixin"] }));

const configOf = (project: string) => join(project, RESOURCES, "example.mixins.json");
const mixinPath = (project: string, mixin: string) => join(project, MIXIN_DIR, `${mixin}.java`);

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
      "a/b/C.class": buildClassFile({
        internalName: "a/b/C",
        fields: [{ name: "d", descriptor: "I", accessFlags: 0x0002 }],
        methods: [
          { name: "m", descriptor: "()V", accessFlags: 0x0001 },
          { name: "e", descriptor: "(I)V", accessFlags: 0x0001 }
        ]
      })
    });
    clientJars.set(version, readFileSync(path));
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

function specOf(name: string): CatalogToolSpec {
  const spec = VALIDATION_TOOL_SPECS.find((entry) => entry.name === name);
  assert.ok(spec, `${name} is a validation spec`);
  return spec;
}

/** The validation block a reply carries: `validation` of mixin-validate, `project` of project-validate. */
function blockOf(name: string, envelope: Envelope): Record<string, any> | undefined {
  return name === "mixin-validate" ? envelope.result?.validation : envelope.result?.project;
}

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
  const block = blockOf(name, reply.envelope);
  if (block !== undefined) {
    const declared = specOf(name).statuses as readonly string[];
    assert.ok(declared.includes(block.status), `${name} status ${block.status} is declared`);
    for (const item of block.items as Array<{ status: string }>) {
      assert.ok(declared.includes(item.status), `${name} item status ${item.status} is declared`);
    }
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

function assertSameFailure(actual: Envelope["error"], expected: Envelope["error"], label: string): void {
  assert.ok(expected, `${label}: the 8.x tool fails`);
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(actual?.[key], expected?.[key], `${label}: ${key}`);
  }
}

/** A value without the timings that differ between two runs. */
function withoutTimings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimings);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "elapsedMs" && key !== "durationMs")
      .map(([key, entry]) => [key, withoutTimings(entry)])
  );
}

/** The catalog item status of one 8.x per-source result. */
function expectedStatus(result: { valid: boolean; validationStatus: string }): string {
  if (result.validationStatus === "full") return "ok";
  return result.valid ? "partial" : "invalid";
}

/**
 * A mixin-validate `validation` block holds the same per-source results as
 * the 8.x validate-mixin result: the same sources in the same order, each
 * result unchanged except for the verdict flags (reported as `status`) and its
 * warnings (reported in `meta.warnings`), the same provenance, and counts that
 * agree with the item statuses and carry the service's issue totals.
 */
function assertSameValidation(validation: Record<string, any>, legacy: Record<string, any>, label: string): void {
  const statuses: string[] = validation.items.map((item: Record<string, any>) => item.status);
  const count = (status: string) => statuses.filter((entry) => entry === status).length;
  assert.deepEqual(
    validation.counts,
    {
      total: legacy.summary.total,
      ok: count("ok"),
      partial: count("partial"),
      invalid: count("invalid"),
      error: legacy.summary.processingErrors,
      validationErrors: legacy.summary.totalValidationErrors,
      validationWarnings: legacy.summary.totalValidationWarnings
    },
    `${label}: counts`
  );
  assert.deepEqual(withoutTimings(validation.provenance), withoutTimings(legacy.provenance), `${label}: provenance`);
  assert.equal(validation.items.length, legacy.results.length, `${label}: one item per source`);
  validation.items.forEach((item: Record<string, any>, index: number) => {
    const entry = legacy.results[index];
    const { source, status, ...rest } = item;
    assert.deepEqual(source, entry.source, `${label}: source ${index}`);
    if (entry.result === undefined) {
      assert.equal(status, "error", `${label}: a failed source is an error item`);
      return;
    }
    const { valid: _valid, validationStatus: _validationStatus, warnings: _warnings, ...legacyRest } = entry.result;
    assert.equal(status, expectedStatus(entry.result), `${label}: status of ${entry.result.className}`);
    assert.deepEqual(withoutTimings(rest), withoutTimings(legacyRest), `${label}: result of ${entry.result.className}`);
  });
}

// ---------------------------------------------------------------------------
// mixin-validate
// ---------------------------------------------------------------------------

test("mixin-validate matches validate-mixin for inline source, files, configs and discovery", async () => {
  const cases: Array<{ label: string; catalog: Record<string, unknown>; legacy: Record<string, unknown> }> = [
    {
      label: "source",
      catalog: { source: BAD_MIXIN, version: OBF_VERSION, mapping: "obfuscated" },
      legacy: { input: { mode: "inline", source: BAD_MIXIN }, version: OBF_VERSION, mapping: "obfuscated" }
    },
    {
      label: "source after blank lines",
      catalog: { source: `\n\n\n${BAD_MIXIN}`, version: OBF_VERSION, mapping: "obfuscated" },
      legacy: { input: { mode: "inline", source: `\n\n\n${BAD_MIXIN}` }, version: OBF_VERSION, mapping: "obfuscated" }
    },
    {
      label: "paths",
      catalog: { paths: [mixinPath(OBF, "GoodMixin"), mixinPath(OBF, "BadMixin")], version: OBF_VERSION, mapping: "obfuscated" },
      legacy: {
        input: { mode: "paths", paths: [mixinPath(OBF, "GoodMixin"), mixinPath(OBF, "BadMixin")] },
        version: OBF_VERSION,
        mapping: "obfuscated"
      }
    },
    {
      label: "configPaths",
      catalog: { configPaths: [configOf(OBF)], projectPath: OBF, version: OBF_VERSION, mapping: "obfuscated" },
      legacy: { input: { mode: "config", configPaths: [configOf(OBF)] }, projectPath: OBF, version: OBF_VERSION, mapping: "obfuscated" }
    },
    {
      label: "discover",
      catalog: { discover: true, projectPath: MOJ },
      legacy: { input: { mode: "project", path: MOJ }, version: MOJ_VERSION, mapping: "mojang" }
    }
  ];
  for (const { label, catalog: request, legacy: legacyRequest } of cases) {
    const legacy = await eightX("validate-mixin", legacyRequest);
    assert.equal(legacy.isError, false, `${label}: ${JSON.stringify(legacy.envelope.error)}`);
    const reply = await catalog("mixin-validate", request);
    assert.equal(reply.isError, false, `${label}: ${JSON.stringify(reply.envelope.error)}`);
    assertSameValidation(reply.envelope.result!.validation, legacy.envelope.result!, label);
    assert.equal(reply.envelope.result!.validation.status, "invalid", `${label}: a definite error makes the call invalid`);
    for (const warning of legacy.envelope.meta.warnings ?? []) {
      assert.ok(
        reply.envelope.meta.warnings?.some((entry) => entry.message === warning),
        `${label}: the service warning "${warning}" is kept`
      );
    }
  }

  const lines = async (label: string) =>
    (await catalog("mixin-validate", cases.find((entry) => entry.label === label)!.catalog)).envelope.result!.validation.items[0]
      .issues.map((issue: Record<string, any>) => issue.line);
  assert.deepEqual(await lines("source after blank lines"), await lines("source"), "leading blank lines are trimmed, as validate-mixin trims them");
  assert.deepEqual(await lines("source"), [10, 9], "positive control: the issues carry their source lines");

  const configs = (await catalog("mixin-validate", cases.find((entry) => entry.label === "configPaths")!.catalog)).envelope.result!.validation;
  assert.deepEqual(
    configs.items.map((item: Record<string, any>) => [item.className, item.status]),
    [["GoodMixin", "ok"], ["BadMixin", "invalid"], ["MissingMixin", "invalid"]],
    "positive control: one source per config entry, each with its status"
  );
  assert.deepEqual(
    configs.items[1].issues.map((issue: Record<string, any>) => issue.kind).sort(),
    ["field-not-found", "method-not-found"]
  );
});

test("mixin-validate reads an omitted version and mapping from projectPath, and an explicit one wins", async () => {
  const read = await catalog("mixin-validate", { configPaths: [configOf(MOJ)], projectPath: MOJ });
  assert.equal(read.envelope.result!.validation.provenance.version, MOJ_VERSION);
  assert.equal(read.envelope.result!.validation.provenance.requestedMapping, "mojang");
  assert.deepEqual(
    read.envelope.meta.warnings?.filter((warning) => warning.code.endsWith("-from-project")).map((warning) => warning.message),
    [`Read Minecraft version ${MOJ_VERSION} from ${join(MOJ, "gradle.properties")}.`, "Read mapping mojang from the project's build script."]
  );

  const explicit = await catalog("mixin-validate", {
    configPaths: [configOf(MOJ)],
    projectPath: MOJ,
    version: OBF_VERSION,
    mapping: "obfuscated"
  });
  assert.equal(explicit.envelope.result!.validation.provenance.version, OBF_VERSION, "the explicit version wins");
  assert.equal(explicit.envelope.result!.validation.provenance.requestedMapping, "obfuscated", "the explicit mapping wins");
  assert.equal(
    explicit.envelope.meta.warnings?.some((warning) => warning.code.endsWith("-from-project")) ?? false,
    false,
    "nothing is read from the project when both are given"
  );
});

test("mixin-validate is blocked with a template when the project declares no version or no mapping", async () => {
  const both = await catalog("mixin-validate", { configPaths: [configOf(BARE)], projectPath: BARE });
  assert.equal(both.isError, false);
  assert.deepEqual(both.envelope.result!.validation, {
    status: "blocked",
    counts: { total: 0, ok: 0, partial: 0, invalid: 0, error: 0, validationErrors: 0, validationWarnings: 0 },
    items: []
  });
  assert.deepEqual(
    both.envelope.meta.warnings?.map((warning) => [warning.code, warning.severity]),
    [["version-unresolved", "warning"], ["mapping-unresolved", "warning"]]
  );
  assert.deepEqual(both.envelope.meta.nextActions, [
    {
      tool: "mixin-validate",
      params: {
        configPaths: [configOf(BARE)],
        projectPath: BARE,
        detail: "summary",
        version: "<minecraft-version>",
        mapping: "<mapping>"
      },
      reason: "Validate with version and mapping set: replace <minecraft-version> and <mapping>.",
      template: true
    }
  ]);

  const mappingOnly = await catalog("mixin-validate", { configPaths: [configOf(BARE)], projectPath: BARE, version: OBF_VERSION });
  assert.equal(mappingOnly.envelope.result!.validation.status, "blocked");
  assert.deepEqual(mappingOnly.envelope.meta.nextActions?.map((action) => [action.params.version, action.params.mapping, action.template]), [
    [OBF_VERSION, "<mapping>", true]
  ]);
  assert.match(mappingOnly.envelope.meta.warnings![0]!.message, /No compile-time mapping declaration was detected/);

  const versionOnly = await catalog("mixin-validate", { discover: true, projectPath: NO_VERSION });
  assert.equal(versionOnly.envelope.result!.validation.status, "blocked");
  assert.deepEqual(versionOnly.envelope.meta.nextActions?.map((action) => [action.params.version, action.params.mapping, action.template]), [
    ["<minecraft-version>", undefined, true]
  ]);

  const filled = await catalog("mixin-validate", {
    ...mappingOnly.envelope.meta.nextActions![0]!.params,
    mapping: "obfuscated"
  });
  assert.equal(filled.envelope.result!.validation.status, "ok", "the template with its placeholder filled in validates");
});

test("mixin-validate requires exactly one input form and the inputs that form needs", async () => {
  const cases: Array<{ request: Record<string, unknown>; paths: string[]; message: RegExp }> = [
    { request: { version: OBF_VERSION, mapping: "obfuscated" }, paths: ["$"], message: /exactly one of source, paths, configPaths, discover/ },
    {
      request: { source: GOOD_MIXIN, paths: [mixinPath(OBF, "GoodMixin")], version: OBF_VERSION, mapping: "obfuscated" },
      paths: ["source", "paths"],
      message: /this request has source, paths/
    },
    { request: { discover: true, version: OBF_VERSION, mapping: "obfuscated" }, paths: ["projectPath"], message: /needs projectPath/ },
    { request: { source: GOOD_MIXIN, mapping: "obfuscated" }, paths: ["version"], message: /required without projectPath/ },
    { request: { source: GOOD_MIXIN, version: OBF_VERSION }, paths: ["mapping"], message: /required without projectPath/ },
    {
      request: { source: GOOD_MIXIN, version: OBF_VERSION, mapping: "obfuscated", scope: "loader" },
      paths: ["scope"],
      message: /needs projectPath/
    },
    { request: { source: "   ", version: OBF_VERSION, mapping: "obfuscated" }, paths: ["source"], message: /blank/ }
  ];
  for (const { request, paths, message } of cases) {
    const { envelope, isError } = await catalog("mixin-validate", request);
    assert.equal(isError, true, JSON.stringify(request));
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(envelope.error?.fieldErrors?.map((entry) => entry.path), paths, JSON.stringify(request));
    for (const fieldError of envelope.error!.fieldErrors!) assert.match(fieldError.message, message);
  }
  const none = await catalog("mixin-validate", { version: OBF_VERSION, mapping: "obfuscated" });
  assert.match(none.envelope.error!.fieldErrors![0]!.message, /source, paths, configPaths, discover/, "the message names the fields");
});

test("the validation tools reject unknown keys, suggest near misses and accept their examples", async () => {
  for (const spec of VALIDATION_TOOL_SPECS) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
    }
    const example = spec.examples[0]!;
    const unknown = await catalog(spec.name, { ...example, bogusKey: 1 });
    assert.equal(unknown.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.deepEqual(unknown.envelope.error?.fieldErrors?.map((entry) => entry.path), ["bogusKey"]);
  }
  const nearMisses: Array<[string, Record<string, unknown>, string, string]> = [
    ["mixin-validate", { configPath: [configOf(MOJ)], projectPath: MOJ }, "configPath", "configPaths"],
    ["mixin-validate", { discover: true, projectPth: MOJ }, "projectPth", "projectPath"],
    ["project-validate", { projectPath: MOJ, mappings: "mojang" }, "mappings", "mapping"],
    ["project-validate", { projectPath: MOJ, discovr: ["mixins"] }, "discovr", "discover"]
  ];
  for (const [name, request, key, suggestion] of nearMisses) {
    const { envelope } = await catalog(name, request);
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT", `${name} ${key}`);
    const fieldError = envelope.error?.fieldErrors?.find((entry) => entry.path === key);
    assert.ok(fieldError, `${name}: ${key} is named`);
    assert.ok(fieldError.suggestions?.includes(suggestion), `${name}: ${key} suggests ${suggestion}`);
  }
  const misplaced = await catalog("project-validate", { projectPath: MOJ, discover: [] });
  assert.deepEqual(misplaced.envelope.error?.fieldErrors?.map((entry) => entry.path), ["discover"], "discover lists at least one kind");
});

test("every mixin-validate detail level keeps the validation block and each item's status", async () => {
  const request = { configPaths: [configOf(MOJ)], projectPath: MOJ };
  for (const detail of DETAIL_LEVELS) {
    const validation = (await catalog("mixin-validate", { ...request, detail })).envelope.result!.validation;
    assert.equal(validation.status, "invalid", detail);
    assert.deepEqual(validation.items.map((item: Record<string, any>) => item.status), ["ok", "invalid", "invalid"], detail);
    assert.ok(validation.counts, detail);
  }
  const summary = (await catalog("mixin-validate", { ...request, detail: "summary" })).envelope.result!.validation;
  const full = (await catalog("mixin-validate", { ...request, detail: "full" })).envelope.result!.validation;
  assert.equal(summary.items[1].issues[0].explanation, undefined, "summary leaves out the explanations");
  assert.equal(summary.items[1].resolvedMembers, undefined);
  assert.ok(full.items[1].resolvedMembers, "full adds each source's resolved members");
  assert.ok(full.items[1].issues[0].explanation, "full explains each issue");
  assert.ok(full.toolHealth, "full adds the mapping health");
});

test("mixin-validate standard turns the in-result suggestions into symbol-check and source-read next actions", async () => {
  const request = { configPaths: [configOf(OBF)], projectPath: OBF, version: OBF_VERSION, mapping: "obfuscated" };
  const legacy = await eightX("validate-mixin", {
    input: { mode: "config", configPaths: [configOf(OBF)] },
    projectPath: OBF,
    version: OBF_VERSION,
    mapping: "obfuscated",
    explain: true,
    reportMode: "compact"
  });
  const legacyCalls = legacy.envelope.result!.results.flatMap((entry: Record<string, any>) =>
    (entry.result?.issues ?? []).map((issue: Record<string, any>) => issue.suggestedCall?.tool).filter(Boolean)
  );
  assert.deepEqual([...new Set(legacyCalls)].sort(), ["check-symbol-exists", "get-class-source"], "positive control: 8.x issues carry suggestions");

  const { envelope, text } = await catalog("mixin-validate", { ...request, detail: "standard" });
  assert.equal(text.includes("suggestedCall"), false, "no issue keeps its suggested call");
  const actions = envelope.meta.nextActions ?? [];
  assert.deepEqual([...new Set(actions.map((action) => action.tool))].sort(), ["source-read", "symbol-check"]);
  assert.ok(actions.every((action) => action.template === undefined), "the suggestions are executable");
  assert.ok(
    actions.some(
      (action) =>
        action.tool === "symbol-check" &&
        action.params.symbols[0].kind === "class" &&
        action.params.symbols[0].className === "a.b.Missing" &&
        action.params.target.version === OBF_VERSION &&
        action.params.mapping === "obfuscated"
    ),
    "the missing target class is checked in the request's version and namespace"
  );
  assert.ok(
    actions.some((action) => action.tool === "source-read" && action.params.classes[0] === "C" && action.params.mode === "metadata"),
    "the class of a missing method is outlined"
  );
  const issues = envelope.result!.validation.items[1].issues;
  assert.ok(issues.every((issue: Record<string, unknown>) => typeof issue.explanation === "string"), "standard explains each issue");
});

test("mixin-validate offers the explained call once at summary when an item is invalid, and nothing when all pass", async () => {
  const invalid = await catalog("mixin-validate", { configPaths: [configOf(MOJ)], projectPath: MOJ });
  assert.deepEqual(invalid.envelope.meta.nextActions, [
    {
      tool: "mixin-validate",
      params: { configPaths: [configOf(MOJ)], projectPath: MOJ, detail: "standard" },
      reason: "Explain each issue and suggest the lookups that check it."
    }
  ]);
  const passing = await catalog("mixin-validate", { configPaths: [configOf(GOOD)], projectPath: GOOD });
  assert.equal(passing.envelope.result!.validation.status, "ok");
  assert.equal(passing.envelope.meta.nextActions, undefined);
  const standard = await catalog("mixin-validate", { configPaths: [configOf(GOOD)], projectPath: GOOD, detail: "standard" });
  assert.equal(standard.envelope.meta.nextActions, undefined, "a passing call has nothing to follow up");
});

test("mixin-validate fails like validate-mixin when discovery finds no config, with the hint in catalog inputs", async () => {
  const legacy = await eightX("validate-mixin", { input: { mode: "project", path: EMPTY }, version: MOJ_VERSION, mapping: "mojang" });
  const { envelope, isError } = await catalog("mixin-validate", { discover: true, projectPath: EMPTY });
  assert.equal(isError, true);
  assertSameFailure(envelope.error, legacy.envelope.error, "no mixin config");
  assert.equal(envelope.error?.detail, legacy.envelope.error?.detail);
  assert.ok(legacy.envelope.error?.hints?.some((hint: string) => hint.includes("input.mode")), "positive control: the 8.x hint names input.mode");
  assert.deepEqual(envelope.error?.hints, [
    "Pass configPaths with the mixin config files, or point projectPath at the workspace root that contains *.mixins.json files."
  ]);
});

// ---------------------------------------------------------------------------
// mixin-validate on a stubbed validation service
// ---------------------------------------------------------------------------

const STUB_SUMMARY = {
  injections: 1,
  shadows: 0,
  accessors: 0,
  total: 1,
  membersValidated: 0,
  membersSkipped: 0,
  membersMissing: 1,
  errors: 1,
  warnings: 0,
  definiteErrors: 0,
  uncertainErrors: 1,
  resolutionErrors: 1,
  parseWarnings: 0
};

const EMPTY_COUNTS = { total: 0, valid: 0, partial: 0, invalid: 0, processingErrors: 0, totalValidationErrors: 0, totalValidationWarnings: 0 };

function stubRuntime(output: Record<string, unknown>) {
  const services = {
    validateMixin: async () => output,
    workspaceMappingService: {
      detectProjectMinecraftVersion: async () => undefined,
      detectCompileMapping: async () => ({ resolved: false, evidence: [], warnings: [] })
    }
  } as unknown as CatalogServices;
  return {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  };
}

test("an uncertain error is partial, a failed source is an error item, and service text names no 8.x input", async () => {
  const retried = 'Retrying validate-mixin with sourcePriority="maven-first" after partial validation using "loom-first".';
  const output = {
    mode: "paths",
    results: [
      {
        source: { kind: "path", label: "/m/Uncertain.java", path: "/m/Uncertain.java" },
        result: {
          className: "Uncertain",
          targets: ["a.b.C"],
          valid: true,
          validationStatus: "invalid",
          issues: [
            {
              severity: "error",
              kind: "target-mapping-failed",
              annotation: "@Mixin",
              target: "a.b.C",
              message: 'Could not map target class "a.b.C" to obfuscated namespace; class may still exist under a different mapping.',
              confidence: "uncertain"
            }
          ],
          summary: STUB_SUMMARY,
          quickSummary:
            "0 error(s), 1 uncertain, 0 warning(s). 0 validated, 0 member(s) skipped, 1 member(s) missing. " +
            "3 target(s) deferred by stage budget — narrow mixinConfigPath or split the run.",
          warnings: [retried]
        }
      },
      {
        source: { kind: "path", label: "/m/Broken.java", path: "/m/Broken.java" },
        error: 'validate-mixin failed during stage "parse": boom',
        errorCode: "ERR_INTERNAL",
        errorDetails: { failedStage: "parse" }
      }
    ],
    summary: { total: 2, valid: 1, partial: 0, invalid: 0, processingErrors: 1, totalValidationErrors: 1, totalValidationWarnings: 0 },
    warnings: [retried, `${retried} Retry failed: offline`]
  };
  const reply = await runCatalogTool(
    mixinValidateSpec,
    { paths: ["/m/Uncertain.java", "/m/Broken.java"], version: OBF_VERSION, mapping: "mojang", detail: "full" },
    stubRuntime(output)
  );
  const envelope = reply.structuredContent as Envelope;
  const text = (reply.content as Array<{ text: string }>)[0]!.text;
  checkReply("mixin-validate", { envelope, text });
  const validation = envelope.result!.validation;
  assert.deepEqual(validation.items.map((item: Record<string, any>) => item.status), ["partial", "error"]);
  assert.equal(validation.status, "partial", "an uncertain error and a failed source make the call partial, not invalid");
  assert.equal(validation.items[0].issues[0].confidence, "uncertain", "the service's uncertainty marker stays");
  assert.equal(
    validation.items[0].quickSummary,
    "0 error(s), 1 uncertain, 0 warning(s). 0 validated, 0 member(s) skipped, 1 member(s) missing. " +
      "3 target(s) deferred by stage budget — validate fewer mixin files per call."
  );
  assert.deepEqual(validation.items[1].error, {
    code: "ERR_INTERNAL",
    detail: 'mixin-validate failed during stage "parse": boom',
    retryClass: "server",
    issueOrigin: "tool_issue"
  });
  const rewritten = 'Retried the validation with Maven mapping sources first after a partial result from "loom-first" sources.';
  assert.deepEqual(validation.items[0].warnings, [rewritten], "full keeps each source's warnings, rewritten");
  assert.deepEqual(envelope.meta.warnings?.map((warning) => warning.message), [rewritten, `${rewritten} Retry failed: offline`]);
  assert.doesNotMatch(text, /sourcePriority=|mixinConfigPath/);
});

test("mixin-validate hands its call's stage emitter to the validation service", async () => {
  const stages: string[] = [];
  const runtime = stubRuntime({});
  const services = {
    ...runtime.services,
    validateMixin: async (_input: unknown, options?: { stageEmitter?: (stage: string) => Promise<void> }) => {
      await options?.stageEmitter?.("resolve");
      return { mode: "inline", results: [], summary: { ...EMPTY_COUNTS }, warnings: [] };
    }
  } as unknown as CatalogServices;
  const reply = await runCatalogTool(
    mixinValidateSpec,
    { source: GOOD_MIXIN, version: OBF_VERSION, mapping: "obfuscated" },
    { ...runtime, services, stageEmitterFor: () => async (stage: string) => { stages.push(stage); } }
  );
  assert.equal((reply.structuredContent as Envelope).result!.validation.status, "ok");
  assert.deepEqual(stages, ["resolve"], "the supervisor sees the validation's stages, as for validate-mixin");
});

test("validate-project suggestions become project-validate and mixin-validate calls", () => {
  assert.deepEqual(
    translateServiceSuggestedCall({
      tool: "validate-project",
      params: {
        task: "project-summary",
        subject: { kind: "workspace", projectPath: "/p", discover: ["mixins"] },
        version: "<minecraft-version>",
        preferProjectVersion: true
      }
    }),
    { tool: "project-validate", params: { projectPath: "/p", discover: ["mixins"], version: "<minecraft-version>" } }
  );
  assert.deepEqual(
    translateServiceSuggestedCall({
      tool: "validate-project",
      params: { task: "mixin", subject: { kind: "mixin", input: { mode: "path", path: "/p/A.java" } }, version: "<your-mc-version>" }
    }),
    { tool: "mixin-validate", params: { paths: ["/p/A.java"], version: "<your-mc-version>", mapping: "<mapping>" } },
    "a mixin call without projectPath needs a mapping, so it gets a placeholder"
  );
  assert.deepEqual(
    translateServiceSuggestedCall({
      tool: "validate-project",
      params: { task: "mixin", subject: { kind: "mixin", input: { mode: "project", path: "/p" } }, version: "1.21.10" }
    }),
    { tool: "mixin-validate", params: { discover: true, projectPath: "/p", version: "1.21.10" } }
  );
  assert.equal(
    translateServiceSuggestedCall({
      tool: "validate-project",
      params: { task: "access-widener", subject: { kind: "access-widener", input: { mode: "path", path: "/p/a.aw" } } }
    }),
    undefined,
    "the access tasks have no catalog form here"
  );
});

test("catalogServiceText rewrites only the known service sentences", () => {
  const sentences: Array<[string, string]> = [
    [
      'Retrying validate-mixin with sourcePriority="maven-first" after partial validation using "loom-first".',
      'Retried the validation with Maven mapping sources first after a partial result from "loom-first" sources.'
    ],
    [
      "Budget exhausted before any target processed — increase budget or split mixinConfigPath.",
      "Budget exhausted before any target processed — validate fewer mixin files per call."
    ],
    [
      "Use input.mode='config' with explicit configPaths[], or point input.path at the workspace root that contains *.mixins.json files.",
      "Pass configPaths with the mixin config files, or point projectPath at the workspace root that contains *.mixins.json files."
    ],
    [
      'Nothing was validated. Access Transformer files are searched only when subject.discover includes "access-transformers".',
      'Nothing was validated. Access Transformer files are searched only when discover includes "access-transformers".'
    ],
    ["Could not infer atNamespace from the workspace.", "Could not infer the access transformer namespace from the workspace."],
    [
      "atNamespace=srg requires projectPath and scope=loader so a Forge runtime jar can be resolved.",
      'An SRG access transformer needs scope "loader" so a Forge runtime jar can be resolved.'
    ]
  ];
  for (const [service, catalogText] of sentences) {
    assert.equal(catalogServiceText(service), catalogText);
  }
  const unrelated = "Pass input.mode and sourcePriority as you like; validate-mixin stays.";
  assert.equal(catalogServiceText(unrelated), unrelated, "text that is not a known sentence is kept");
});

// ---------------------------------------------------------------------------
// project-validate
// ---------------------------------------------------------------------------

test("project-validate skips a directory it cannot read instead of failing with ERR_INTERNAL", { skip: process.getuid?.() === 0 }, async () => {
  const project = writeProject("unreadable-subdirectory", { version: OBF_VERSION, mixins: ["GoodMixin"] });
  const locked = join(project, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const { envelope, isError } = await catalog("project-validate", { projectPath: project, mapping: "obfuscated", scope: "vanilla" });
    assert.equal(isError, false, JSON.stringify(envelope.error));
    assert.notEqual(envelope.error?.code, "ERR_INTERNAL");
    assert.deepEqual(
      envelope.result!.project.items.map((item: Record<string, any>) => [item.path, item.kind]),
      [[configOf(project), "mixin-config"]]
    );
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("project-validate matches validate-project project-summary and names each discovered file", async () => {
  const request = { projectPath: OBF, mapping: "obfuscated", scope: "vanilla" };
  const legacy = await eightX("validate-project", {
    task: "project-summary",
    subject: { kind: "workspace", projectPath: OBF },
    mapping: "obfuscated",
    scope: "vanilla",
    detail: "standard"
  });
  assert.equal(legacy.isError, false, JSON.stringify(legacy.envelope.error));
  const legacyResult = legacy.envelope.result!;
  assert.equal(legacyResult.summary.counts.invalid, 3, "positive control: two mixins and the widener are invalid");

  const { envelope } = await catalog("project-validate", { ...request, detail: "standard" });
  const project = envelope.result!.project;
  assert.equal(project.status, legacyResult.summary.status);
  assert.deepEqual(project.workspace, legacyResult.workspace, "the same files are discovered");
  assert.deepEqual(
    project.items.map((item: Record<string, any>) => [item.path, item.kind, item.status]),
    [
      [configOf(OBF), "mixin-config", "invalid"],
      [join(OBF, RESOURCES, "example.accesswidener"), "access-widener", "invalid"]
    ]
  );
  assert.deepEqual(project.counts, { total: 2, ok: 0, partial: 0, invalid: 2, error: 0, blocked: 0 });
  for (const [key, task] of Object.entries(legacyResult.tasks as Record<string, Record<string, unknown>>)) {
    assert.equal(project.tasks[key].status, task.status, `task ${key}`);
    assert.deepEqual(project.tasks[key].error, task.error, `task ${key} error`);
  }
  for (const warning of legacy.envelope.meta.warnings ?? []) {
    assert.ok(envelope.meta.warnings?.some((entry) => entry.message === warning), `the warning "${warning}" is kept`);
  }

  // Each file's outcome is the one its own validation gives.
  const perConfig = (await eightX("validate-mixin", {
    input: { mode: "config", configPaths: [configOf(OBF)] },
    projectPath: OBF,
    version: OBF_VERSION,
    mapping: "obfuscated"
  })).envelope.result!;
  const expectedErrors = perConfig.results.flatMap((entry: Record<string, any>) =>
    entry.result.issues
      .filter((issue: Record<string, any>) => issue.severity === "error")
      .map((issue: Record<string, any>) => `${entry.result.className}: ${issue.message}`)
  );
  assert.deepEqual(project.items[0].errors, expectedErrors);
  assert.deepEqual(
    project.items[0].issues.map((issue: Record<string, any>) => [issue.className, issue.kind]),
    perConfig.results.flatMap((entry: Record<string, any>) =>
      entry.result.issues.map((issue: Record<string, any>) => [entry.result.className, issue.kind])
    )
  );
  assert.deepEqual(project.items[1].errors, ['line 3: Field "nope" not found in class "a.b.C".']);
  assert.equal(project.items[1].issues[0].name, "nope");
});

test("every project-validate detail level names each file and its status", async () => {
  const request = { projectPath: OBF, mapping: "obfuscated", scope: "vanilla" };
  for (const detail of DETAIL_LEVELS) {
    const project = (await catalog("project-validate", { ...request, detail })).envelope.result!.project;
    assert.equal(project.status, "invalid", detail);
    assert.deepEqual(project.items.map((item: Record<string, any>) => item.status), ["invalid", "invalid"], detail);
    assert.ok(project.items.every((item: Record<string, any>) => typeof item.path === "string" && item.errors.length > 0), detail);
    assert.equal(project.items[0].issues === undefined, detail === "summary", `${detail}: issues from standard`);
    assert.equal(project.workspace === undefined, detail === "summary", `${detail}: the file lists from standard`);
    assert.equal(project.items[0].provenance === undefined, detail !== "full", `${detail}: provenance at full`);
    assert.equal(project.tasks["workspace.detected"].evidence === undefined, detail !== "full", `${detail}: task evidence at full`);
  }
});

test("project-validate offers the standard call once at summary when a file is not ok", async () => {
  const request = { projectPath: OBF, mapping: "obfuscated", scope: "vanilla" };
  const failing = await catalog("project-validate", request);
  assert.deepEqual(failing.envelope.meta.nextActions, [
    {
      tool: "project-validate",
      params: { ...request, discover: ["mixins", "access-wideners"], detail: "standard" },
      reason: "List each file's issues."
    }
  ]);
  const passing = await catalog("project-validate", { projectPath: GOOD });
  assert.equal(passing.envelope.result!.project.status, "ok");
  assert.deepEqual(passing.envelope.result!.project.items.map((item: Record<string, any>) => item.status), ["ok"]);
  assert.equal(passing.envelope.meta.nextActions, undefined, "nothing to follow up when every file passes");
  const standard = await catalog("project-validate", { ...request, detail: "standard" });
  assert.equal(
    standard.envelope.meta.nextActions?.some((action) => action.tool === "project-validate") ?? false,
    false,
    "standard does not offer itself again"
  );
});

test("project-validate reads the version and mapping from the project, and an explicit mapping wins", async () => {
  const read = await catalog("project-validate", { projectPath: MOJ, detail: "full" });
  const project = read.envelope.result!.project;
  assert.equal(project.items[0].provenance.version, MOJ_VERSION);
  assert.equal(project.items[0].provenance.requestedMapping, "mojang");
  assert.ok(read.envelope.meta.warnings?.some((warning) => warning.message === "Read mapping mojang from the project's build script."));
  assert.ok(
    read.envelope.meta.warnings?.some((warning) => warning.message.startsWith(`version was inferred from the workspace: ${MOJ_VERSION}`)),
    "the project service's version notice is kept"
  );
  const explicit = await catalog("project-validate", { projectPath: MOJ, mapping: "obfuscated", version: MOJ_VERSION, detail: "full" });
  assert.equal(explicit.envelope.result!.project.items[0].provenance.requestedMapping, "obfuscated");
});

test("project-validate is blocked with a template when a mixin's version or mapping cannot be read", async () => {
  const both = await catalog("project-validate", { projectPath: BARE });
  const project = both.envelope.result!.project;
  assert.equal(project.status, "blocked");
  assert.deepEqual(project.items, [{ path: configOf(BARE), kind: "mixin-config", status: "blocked" }]);
  assert.deepEqual(project.counts, { total: 1, ok: 0, partial: 0, invalid: 0, error: 0, blocked: 1 });
  assert.equal(project.tasks["minecraft.artifact.resolved"].status, "skipped");
  assert.deepEqual(both.envelope.meta.nextActions, [
    {
      tool: "project-validate",
      params: {
        projectPath: BARE,
        discover: ["mixins", "access-wideners"],
        detail: "summary",
        version: "<minecraft-version>",
        mapping: "<mapping>"
      },
      reason: "Validate with version and mapping set: replace <minecraft-version> and <mapping>.",
      template: true
    }
  ]);

  const version = await catalog("project-validate", { projectPath: NO_VERSION });
  assert.equal(version.envelope.result!.project.status, "blocked", "the project service blocks without a version");
  assert.deepEqual(version.envelope.result!.project.items.map((item: Record<string, any>) => item.status), ["blocked"]);
  assert.deepEqual(version.envelope.meta.nextActions, [
    {
      tool: "project-validate",
      params: { projectPath: NO_VERSION, discover: ["mixins", "access-wideners"], detail: "summary", version: "<minecraft-version>" },
      reason: "Validate with the project's Minecraft version in place of <minecraft-version>.",
      template: true
    }
  ]);
  const legacy = await eightX("validate-project", { task: "project-summary", subject: { kind: "workspace", projectPath: NO_VERSION } });
  assert.equal(legacy.envelope.result!.summary.status, "blocked", "positive control: validate-project blocks the same way");

  const filled = await catalog("project-validate", { ...version.envelope.meta.nextActions![0]!.params, version: MOJ_VERSION });
  assert.equal(filled.envelope.result!.project.status, "ok", "the template with its placeholder filled in validates");
});

test("project-validate reports an access transformer it cannot read as an error item in catalog terms", async () => {
  const legacy = await eightX("validate-project", {
    task: "project-summary",
    subject: { kind: "workspace", projectPath: OBF, discover: ["access-transformers"] },
    mapping: "obfuscated",
    scope: "vanilla"
  });
  assert.ok(
    legacy.envelope.meta.warnings?.includes("Could not infer atNamespace from the workspace."),
    "positive control: the 8.x warning names atNamespace"
  );
  const { envelope, text } = await catalog("project-validate", {
    projectPath: OBF,
    mapping: "obfuscated",
    scope: "vanilla",
    discover: ["access-transformers"]
  });
  const project = envelope.result!.project;
  assert.deepEqual(project.items, [
    {
      path: join(OBF, RESOURCES, "META-INF", "accesstransformer.cfg"),
      kind: "access-transformer",
      status: "error",
      errors: ["Could not infer the access transformer namespace from the workspace."]
    }
  ]);
  assert.equal(project.status, "partial", "a file that could not be validated makes the call partial");
  assert.equal(text.includes("atNamespace"), false);
});

test("an invalid access widener says why, also when no entry fails", async () => {
  for (const detail of ["summary", "standard"] as const) {
    const { envelope } = await catalog("project-validate", { projectPath: WIDENER_CASES, scope: "vanilla", detail });
    const items = Object.fromEntries(
      envelope.result!.project.items.map((item: Record<string, any>) => [item.path.split("/").at(-1), item])
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(items).map(([name, item]) => [name, [item.status, item.errors]])),
      {
        "header.accesswidener": ["invalid", ['Line 1: Unsupported accessWidener header version "v99" (expected v1 or v2).']],
        "kind.accesswidener": ["invalid", ['Line 3: Unknown access kind "bogus".']],
        "legality.accesswidener": ["invalid", ['Line 3: "extendable" does not apply to field (only class and method).']]
      },
      `${detail}: each file says why, with its line once`
    );
    if (detail === "standard") {
      assert.deepEqual(items["header.accesswidener"].issues, [
        { issue: 'Line 1: Unsupported accessWidener header version "v99" (expected v1 or v2).' }
      ]);
      assert.deepEqual(items["kind.accesswidener"].issues, [{ issue: 'Line 3: Unknown access kind "bogus".' }]);
      assert.deepEqual(
        items["legality.accesswidener"].issues.map((entry: Record<string, unknown>) => [entry.name, entry.issue]),
        [["d", 'Line 3: "extendable" does not apply to field (only class and method).']]
      );
    } else {
      assert.equal(items["kind.accesswidener"].issues, undefined, "summary leaves the issues out");
    }
  }
});

test("project-validate marks access entries, statuses and errors as access-validate does", async () => {
  const { envelope } = await catalog("project-validate", {
    projectPath: UNMAPPED_CASES,
    mapping: "intermediary",
    scope: "vanilla",
    detail: "standard"
  });
  const project = envelope.result!.project;
  const items = Object.fromEntries(
    project.items.map((item: Record<string, any>) => [item.path.split("/").at(-1), item])
  );
  const uncertain = items["uncertain.accesswidener"];
  assert.equal(uncertain.status, "partial", "failures behind unmapped class names leave the file's verdict open");
  assert.equal(uncertain.errors, undefined);
  assert.deepEqual(
    uncertain.issues.map((entry: Record<string, any>) => [entry.line, entry.valid, entry.confidence]),
    [[2, false, "uncertain"], [3, false, "uncertain"]]
  );
  for (const entry of uncertain.issues) {
    assert.match(entry.confidenceReason, /^(Could not map class|Mapping lookup failed for class) "/);
  }

  const mixed = items["mixed.accesswidener"];
  assert.equal(mixed.status, "invalid", "positive control: a rule violation beside uncertain entries is invalid");
  assert.deepEqual(mixed.errors, [
    'Line 3: "extendable" does not apply to field (only class and method).',
    'Line 4: Unknown access kind "bogus".'
  ]);
  assert.deepEqual(
    mixed.issues.map((entry: Record<string, any>) =>
      entry.line !== undefined ? `entry on line ${entry.line}: ${entry.confidence ?? "definite"}` : entry.issue
    ),
    ["entry on line 2: uncertain", "entry on line 3: definite", 'Line 4: Unknown access kind "bogus".'],
    "the issues are the failed entries and the rejected lines, nothing else"
  );
  assert.deepEqual(project.counts, { total: 2, ok: 0, partial: 1, invalid: 1, error: 0, blocked: 0 }, "counts follow the item statuses");
  assert.equal(project.status, "invalid");
  const warnings = envelope.meta.warnings!.map((warning) => warning.message);
  assert.ok(warnings.includes('Using mapping override "intermediary" instead of header namespace "official".'), "other warnings stay in meta.warnings");
  assert.ok(warnings.some((warning) => /^(Could not map class|Mapping lookup failed for class) "net\.minecraft\.class_9999"/.test(warning)));

  for (const name of ["uncertain", "mixed"]) {
    const single = (await catalog("access-validate", {
      format: "access-widener",
      path: unmappedFile(name),
      version: OBF_VERSION,
      mapping: "intermediary",
      scope: "vanilla"
    })).envelope.result!.validation;
    const item = items[`${name}.accesswidener`];
    assert.equal(item.status, single.status, `${name}: the same status as access-validate`);
    assert.deepEqual(item.errors, single.errors, `${name}: the same errors as access-validate`);
    assert.deepEqual(
      item.issues.filter((entry: Record<string, any>) => entry.line !== undefined),
      single.entries.filter((entry: Record<string, any>) => entry.valid === false),
      `${name}: the same marked entries as access-validate`
    );
  }
});

test("an access widener checked against another version's jar is partial with a version-mismatch warning", async () => {
  const reason = "Runtime evidence comes from Minecraft 1.21.9, not the requested 1.21.10; entries were checked against a different version's bytecode.";
  const services = {
    workspaceMappingService: {
      detectProjectMinecraftVersion: async () => OBF_VERSION,
      detectCompileMapping: async () => ({ resolved: false, evidence: [], warnings: [] })
    },
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
  const reply = await runCatalogTool(projectValidateSpec, { projectPath: WIDENER_ONLY, detail: "full" }, { ...stubRuntime({}), services });
  const envelope = reply.structuredContent as Envelope;
  checkReply("project-validate", { envelope, text: (reply.content as Array<{ text: string }>)[0]!.text });
  const project = envelope.result!.project;
  const widener = join(WIDENER_ONLY, RESOURCES, "example.accesswidener");
  assert.deepEqual(project.items.map((item: Record<string, any>) => [item.path, item.status, item.approximate]), [[widener, "partial", true]]);
  assert.equal(project.status, "partial", "another version's evidence is not plain success");
  assert.deepEqual(
    envelope.meta.warnings?.filter((warning) => warning.code === "version-mismatch"),
    [{ code: "version-mismatch", severity: "warning", message: `${widener} was checked against another version's runtime jar: ${reason}` }]
  );
  assert.deepEqual(
    envelope.meta.warnings?.filter((warning) => warning.message.includes(reason)).map((warning) => warning.code),
    ["version-mismatch"],
    "the reason is stated once, in the file's version-mismatch warning, as access-validate states it"
  );
});

test("a mixin file that cannot be read is named as a mixin file by both tools", async () => {
  const missing = join(root, "missing", "AbsentMixin.java");
  const mixins = await catalog("mixin-validate", { paths: [missing], version: OBF_VERSION, mapping: "obfuscated" });
  const item = mixins.envelope.result!.validation.items[0];
  assert.equal(item.status, "error");
  assert.ok(item.error.detail.startsWith(`Could not read the mixin file "${missing}" (resolved to "${missing}"): ENOENT`), item.error.detail);
  assert.equal(mixins.text.includes("sourcePath"), false);
  const legacy = await eightX("validate-mixin", { input: { mode: "paths", paths: [missing] }, version: OBF_VERSION, mapping: "obfuscated" });
  assert.match(legacy.envelope.result!.results[0].error, /^Could not read sourcePath/, "positive control: the service names sourcePath");

  const project = await catalog("project-validate", { projectPath: ABSENT, mapping: "obfuscated" });
  const config = project.envelope.result!.project.items[0];
  assert.equal(config.status, "partial", "a config with a source that could not be validated is partial");
  assert.equal(config.errors.length, 1);
  assert.match(config.errors[0], /: Could not read the mixin file "/);
  assert.equal(project.text.includes("sourcePath"), false);
});

test("project-validate hands its stages to the call's stage emitter", async () => {
  const stages: string[] = [];
  const services = {
    workspaceMappingService: {
      detectProjectMinecraftVersion: async () => MOJ_VERSION,
      detectCompileMapping: async () => ({ resolved: true, mappingApplied: "mojang", evidence: [], warnings: [] })
    },
    validateMixin: async (_input: unknown, options?: { stageEmitter?: (stage: string) => Promise<void> }) => {
      await options?.stageEmitter?.("target-lookup");
      return { mode: "config", results: [], summary: { ...EMPTY_COUNTS }, warnings: [] };
    },
    probeMinecraftArtifact: async () => ({ artifactId: "stub", mappingApplied: "mojang", warnings: [] })
  } as unknown as CatalogServices;
  const reply = await runCatalogTool(
    projectValidateSpec,
    { projectPath: GOOD },
    { ...stubRuntime({}), services, stageEmitterFor: () => async (stage: string) => { stages.push(stage); } }
  );
  assert.equal((reply.structuredContent as Envelope).result!.project.status, "ok");
  for (const stage of ["validate-project:workspace-discovery", "validate-project:mixin-validation", "target-lookup", "validate-project:task-report"]) {
    assert.ok(stages.includes(stage), `the supervisor sees ${stage}; saw ${stages.join(", ")}`);
  }
});

test("project-validate discovers an unmapped workspace once per request and sees later files", async (t) => {
  const projectPath = writeProject("discovery-reuse", {
    version: OBF_VERSION,
    accessWidener: "valid",
    accessTransformer: true
  });
  const glob = fastGlob.glob;
  let directoryReads = 0;
  t.mock.method(fastGlob, "glob", (patterns, options) => glob(patterns, {
    ...options,
    fs: {
      readdir: (path, ...args) => {
        // Build-script-only searches infer mapping independently of file discovery.
        const mappingSearch = patterns.every((pattern) => /(?:^|\/)build\.gradle(?:\.kts)?$/.test(pattern));
        if (String(path) === projectPath && !mappingSearch) directoryReads++;
        return readdir(path, ...args);
      }
    }
  }));

  for (const discover of [
    ["mixins", "access-wideners", "access-transformers"],
    ["access-wideners"],
    ["access-transformers"],
    ["mixins"]
  ]) {
    const request = { projectPath, discover, scope: "vanilla", detail: "standard" };
    directoryReads = 0;
    const mapped = await catalog("project-validate", { ...request, mapping: "obfuscated" });
    const oneDiscoveryReads = directoryReads;
    assert.ok(oneDiscoveryReads > 0, "the control performs real directory reads");
    directoryReads = 0;
    const unmapped = await catalog("project-validate", request);
    assert.deepEqual(unmapped.envelope.result!.project.workspace, mapped.envelope.result!.project.workspace,
      `${discover}: mapping detection preserves the selected discovered paths`);
    assert.deepEqual(unmapped.envelope.result!.project.items.map((item) => [item.path, item.kind, item.status]),
      mapped.envelope.result!.project.items.map((item) => [item.path, item.kind, item.status]),
      `${discover}: the same files receive the same validation outcomes`);
    assert.equal(directoryReads, oneDiscoveryReads,
      `${discover}: unresolved mapping must not double the directory scan workload`);
  }

  const addedResources = join(projectPath, "added", RESOURCES);
  mkdirSync(addedResources, { recursive: true });
  writeFileSync(join(addedResources, "fabric.mod.json"), JSON.stringify({ accessWidener: "added.accesswidener" }));
  const addedWidener = join(addedResources, "added.accesswidener");
  writeFileSync(addedWidener, "accessWidener v2 official\naccessible class a/b/C\n");
  const later = await catalog("project-validate", { projectPath, discover: ["access-wideners"], scope: "vanilla", detail: "standard" });
  assert.deepEqual(later.envelope.result!.project.workspace.accessWideners,
    [addedWidener, join(projectPath, RESOURCES, "example.accesswidener")],
    "a later request discovers files added after the first request");
});

test("project-validate validates wideners without a mapping when no mixin needs one", async () => {
  const { envelope } = await catalog("project-validate", { projectPath: WIDENER_ONLY, scope: "vanilla" });
  const project = envelope.result!.project;
  assert.equal(project.status, "ok");
  assert.deepEqual(project.items.map((item: Record<string, any>) => [item.kind, item.status]), [["access-widener", "ok"]]);
  assert.equal(project.tasks["minecraft.artifact.resolved"].status, "skipped", "no namespace is assumed for the artifact check");
  assert.ok(envelope.meta.warnings?.some((warning) => warning.code === "mapping-unresolved" && warning.severity === "info"));
});

test("project-validate reads a named widener in the project's mapping and keeps the namespace of an intermediary header", async () => {
  const fileName = (item: Record<string, any>) => item.path.split("/").at(-1);
  const { envelope } = await catalog("project-validate", { projectPath: HEADER_CASES, scope: "vanilla", detail: "standard" });
  const project = envelope.result!.project;
  const items = Object.fromEntries(project.items.map((item: Record<string, any>) => [fileName(item), item]));
  assert.ok(envelope.meta.warnings?.some((warning) => warning.code === "mapping-from-project"), "the mapping is read from the build");
  assert.equal(items["named.accesswidener"].status, "ok", "a named header is read as the project's Mojang names");

  const intermediary = items["intermediary.accesswidener"];
  assert.equal(intermediary.status, "partial", "positive control: an intermediary header keeps its own namespace");
  assert.ok(intermediary.issues.length > 0);
  for (const entry of intermediary.issues) {
    assert.match(entry.confidenceReason, /^(Could not map class "com\.mojang\.NamedClass" from intermediary |Mapping lookup failed for class "com\.mojang\.NamedClass")/);
  }

  const explicit = await catalog("project-validate", { projectPath: HEADER_CASES, mapping: "intermediary", scope: "vanilla" });
  const explicitItems = Object.fromEntries(
    explicit.envelope.result!.project.items.map((item: Record<string, any>) => [fileName(item), item])
  );
  assert.equal(explicitItems["named.accesswidener"].status, "partial", "an explicit mapping still overrides a named header");
});

test("project-validate reports nothing to validate in catalog terms", async () => {
  const legacy = await eightX("validate-project", { task: "project-summary", subject: { kind: "workspace", projectPath: EMPTY } });
  assert.ok(
    legacy.envelope.meta.warnings?.some((warning: string) => warning.includes("subject.discover")),
    "positive control: the 8.x notice names subject.discover"
  );
  const { envelope, text } = await catalog("project-validate", { projectPath: EMPTY });
  assert.equal(envelope.result!.project.status, "ok");
  assert.deepEqual(envelope.result!.project.items, []);
  assert.ok(envelope.meta.warnings?.some((warning) => warning.message.startsWith("Nothing was validated")));
  assert.ok(text.includes('only when discover includes \\"access-transformers\\"'));
  assert.equal(text.includes("subject.discover"), false);
});

test("the validation tools read a project given as a \\\\wsl.localhost or drive path on a WSL host", { skip: process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host" }, async () => {
  const distro = "validation-distro";
  const unc = `\\\\wsl.localhost\\${distro}\\${MOJ.replace(/^\//, "").replace(/\//g, "\\")}`;
  await withEnv({ WSL_DISTRO_NAME: distro }, async () => {
    const plain = (await catalog("project-validate", { projectPath: MOJ })).envelope.result!.project;
    const project = (await catalog("project-validate", { projectPath: unc })).envelope.result!.project;
    assert.equal(project.items.length, 1, `the UNC spelling ${unc} finds the mixin config`);
    assert.deepEqual(project.items, plain.items, "the same files and outcomes as the host path");

    const discovered = (await catalog("mixin-validate", { discover: true, projectPath: unc })).envelope.result!.validation;
    assert.equal(discovered.provenance.version, MOJ_VERSION, "the version is read through the normalized path");
    assert.deepEqual(discovered.items.map((item: Record<string, any>) => item.status), ["ok", "invalid", "invalid"]);

    const drive = await catalog("project-validate", { projectPath: "C:\\checks\\missing-project" });
    assert.equal(drive.envelope.result!.project.tasks["workspace.detected"].status, "missing");
    assert.match(
      drive.envelope.meta.warnings!.map((warning) => warning.message).join("\n"),
      /\/mnt\/c\/checks\/missing-project/,
      "the drive path is read as its /mnt path"
    );
  });
});
