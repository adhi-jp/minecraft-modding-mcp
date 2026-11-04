/**
 * Resolution family (version-list, artifact-resolve, artifact-index,
 * file-list, file-read, class-find) through the in-process MCP session that
 * serves the catalog and the 8.x tools side by side.
 *
 * Fixtures, all local:
 *  - a jar with an adjacent `-sources.jar` (artifact, file and class parity);
 *  - a Maven-local dependency read from a workspace's gradle.properties;
 *  - a stubbed Mojang manifest and client jar plus a Loom cache holding only
 *    1.21.10 sources, so a 1.21.11 request is served as an approximation
 *    (the scenario of the service-level version-approximation tests);
 *  - injected services for the binary-backed class fallback of a workspace
 *    whose sources omit net.minecraft (the scenario of the inspect-minecraft
 *    workspace fallback tests).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { buildClassFile } from "../helpers/classfile.ts";
import { createJar } from "../helpers/zip.ts";
import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { RESOLUTION_TOOL_SPECS } from "../../src/tools/families/resolution.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import { DETAIL_LEVELS } from "../../src/tools/schemas.ts";
import { translateServiceSuggestedCall } from "../../src/tools/translation.ts";
import { buildCatalogWarnings } from "../../src/tools/warnings.ts";
import type { CatalogRuntime, CatalogServices } from "../../src/tools/types.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-resolution-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";
process.env.GRADLE_USER_HOME = join(root, "gradle-home");

const MANIFEST_URL = "https://manifest.test/version_manifest_v2.json";
process.env.MCP_VERSION_MANIFEST_URL = MANIFEST_URL;
const APPROX_VERSION = "1.21.11";
const LOOM_VERSION = "1.21.10";
const VERSION_JSON_URL = `https://manifest.test/versions/${APPROX_VERSION}.json`;
const CLIENT_JAR_URL = `https://manifest.test/downloads/client-${APPROX_VERSION}.jar`;
const clientJarPath = join(root, "client.jar");
let clientJarBytes: Buffer = Buffer.alloc(0);
const LOOM_VERSION_JSON_URL = `https://manifest.test/versions/${LOOM_VERSION}.json`;
const LOOM_CLIENT_JAR_URL = `https://manifest.test/downloads/client-${LOOM_VERSION}.jar`;
/** The exact-version test turns this on; every other test sees 1.21.10's metadata as a 404. */
let serveLoomVersion = false;

// The source service captures `fetch` when it is first built, which happens
// on the first tool call of this file; everything outside the stub is a 404.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === MANIFEST_URL) {
    return new Response(
      JSON.stringify({
        latest: { release: APPROX_VERSION, snapshot: "25w40a" },
        versions: [
          { id: "25w40a", type: "snapshot", url: "https://manifest.test/versions/25w40a.json" },
          { id: APPROX_VERSION, type: "release", url: VERSION_JSON_URL },
          { id: LOOM_VERSION, type: "release", url: LOOM_VERSION_JSON_URL },
          { id: "1.21.9", type: "release", url: "https://manifest.test/versions/1.21.9.json" }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (url === VERSION_JSON_URL) {
    return new Response(JSON.stringify({ id: APPROX_VERSION, downloads: { client: { url: CLIENT_JAR_URL } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (url === CLIENT_JAR_URL) {
    return new Response(clientJarBytes, { status: 200 });
  }
  if (serveLoomVersion && url === LOOM_VERSION_JSON_URL) {
    return new Response(JSON.stringify({ id: LOOM_VERSION, downloads: { client: { url: LOOM_CLIENT_JAR_URL } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (serveLoomVersion && url === LOOM_CLIENT_JAR_URL) {
    return new Response(clientJarBytes, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const jarPath = join(root, "jars", "fixture-lib-1.0.0.jar");
const approxProject = join(root, "approx-workspace");
const dependencyProject = join(root, "dependency-workspace");

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

type Envelope = {
  result?: Record<string, any>;
  error?: Record<string, any> & { fieldErrors?: Array<Record<string, any>> };
  meta: Record<string, any> & {
    warnings?: Array<{ code: string; severity: string; message: string }>;
    nextActions?: Array<{ tool: string; params: Record<string, unknown>; template?: true }>;
    pagination?: { hasMore: boolean; nextCursor?: string };
    truncation?: Array<{ field: string; limitedBy: string }>;
  };
};

let session: CatalogSession;

before(async () => {
  mkdirSync(join(root, "jars"), { recursive: true });
  await createJar(jarPath, {
    "com/example/FixtureWidget.class": buildClassFile({ internalName: "com/example/FixtureWidget" }),
    "com/example/FixtureGadget.class": buildClassFile({ internalName: "com/example/FixtureGadget" }),
    "com/example/other/FixtureWidget.class": buildClassFile({ internalName: "com/example/other/FixtureWidget" })
  });
  await createJar(join(root, "jars", "fixture-lib-1.0.0-sources.jar"), {
    "com/example/FixtureWidget.java": "package com.example;\npublic class FixtureWidget {\n  int size;\n}\n",
    "com/example/FixtureGadget.java": "package com.example;\npublic class FixtureGadget {}\n",
    "com/example/other/FixtureWidget.java": "package com.example.other;\npublic class FixtureWidget {}\n"
  });

  const m2Version = join(root, "m2", "com", "example", "dep-lib", "1.0.0");
  mkdirSync(m2Version, { recursive: true });
  await createJar(join(m2Version, "dep-lib-1.0.0.jar"), {
    "com/example/dep/DepWidget.class": buildClassFile({ internalName: "com/example/dep/DepWidget" })
  });
  await createJar(join(m2Version, "dep-lib-1.0.0-sources.jar"), {
    "com/example/dep/DepWidget.java": "package com.example.dep;\npublic class DepWidget {}\n"
  });
  mkdirSync(dependencyProject, { recursive: true });
  writeFileSync(join(dependencyProject, "gradle.properties"), "dep_lib_version=1.0.0\n", "utf8");

  const loomCache = join(approxProject, ".gradle", "loom-cache");
  mkdirSync(loomCache, { recursive: true });
  await createJar(join(loomCache, `minecraft-${LOOM_VERSION}-merged-sources.jar`), {
    "net/minecraft/world/level/block/Blocks.java": "package net.minecraft.world.level.block;\npublic class Blocks {}"
  });
  await createJar(clientJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  clientJarBytes = readFileSync(clientJarPath);

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
 * and no 8.x tool, carries no internal fallback sentence, and publishes only
 * executable next actions for catalog tools or flagged templates.
 */
async function catalog(name: string, args: unknown) {
  const reply = envelopeOf(await session.callTool(name, args));
  assert.equal(reply.envelope.meta.tool, name);
  assert.ok(reply.text.includes(`"${name}"`), "positive control: the catalog tool name is in the reply");
  assert.doesNotMatch(reply.text, ALIAS_NAME_PATTERN, `no 8.x tool name in the ${name} reply: ${reply.text}`);
  assert.equal(reply.text.includes(FALLBACK_SENTENCE), false);
  for (const action of reply.envelope.meta.nextActions ?? []) {
    assert.ok(RESOLUTION_TOOL_SPECS.some((spec) => spec.name === action.tool), `${action.tool} is a catalog tool`);
    if (action.template !== true) {
      assert.deepEqual(finalizeNextActions([action]), [action], `next action ${JSON.stringify(action)} validates`);
    }
  }
  return reply;
}

async function eightX(name: string, args: unknown) {
  return envelopeOf(await session.callTool(name, args));
}

function specOf(name: string) {
  const spec = RESOLUTION_TOOL_SPECS.find((entry) => entry.name === name);
  assert.ok(spec, `${name} is a resolution spec`);
  return spec;
}

/** Checks the reply status against the tool's declared subset, when the reply carries one. */
function assertDeclaredStatus(name: string, result: Record<string, any> | undefined): void {
  if (result?.status !== undefined) {
    assert.ok(specOf(name).statuses.includes(result.status), `${name} status ${result.status} is declared`);
  }
}

let jarArtifactId = "";

test("version-list matches list-versions on the same manifest", async () => {
  const args = { includeSnapshots: true, limit: 2 };
  const { envelope } = await catalog("version-list", args);
  const legacy = (await eightX("list-versions", args)).envelope.result!;
  const entry = (type: string) => (version: { id: string; unobfuscated: boolean }) => ({
    version: version.id,
    type,
    unobfuscated: version.unobfuscated,
    cached: legacy.cached.includes(version.id)
  });
  // Releases first, then snapshots, each in manifest (newest-first) order.
  assert.deepEqual(envelope.result!.versions, [
    ...legacy.releases.map(entry("release")),
    ...legacy.snapshots.map(entry("snapshot"))
  ]);
  assert.ok(legacy.releases.length > 0 && legacy.snapshots.length > 0, "positive control: both types are listed");
  assert.deepEqual(envelope.result!.latest, legacy.latest);
  assert.deepEqual(envelope.result!.cached, legacy.cached);
  assert.equal(envelope.result!.totalAvailable, legacy.totalAvailable);
});

test("artifact-resolve matches resolve-artifact and every detail level keeps the artifact", async () => {
  const levels: Record<string, Record<string, any>> = {};
  for (const detail of DETAIL_LEVELS) {
    const { envelope } = await catalog("artifact-resolve", { target: { kind: "jar", jarPath }, detail });
    assert.ok(envelope.result?.artifact, `detail ${detail} keeps result.artifact`);
    assertDeclaredStatus("artifact-resolve", envelope.result);
    levels[detail] = envelope.result!.artifact;
  }
  const legacy = (await eightX("resolve-artifact", { target: { kind: "jar", value: jarPath }, detail: "full" }))
    .envelope.result!;
  jarArtifactId = legacy.artifactId;
  for (const key of ["artifactId", "version", "mappingApplied", "origin", "isDecompiled", "qualityFlags"]) {
    assert.deepEqual(levels.summary![key], legacy[key], `summary ${key}`);
  }
  assert.deepEqual(levels.standard!.artifactContents, legacy.artifactContents);
  assert.deepEqual(levels.full!.sampleEntries, legacy.sampleEntries);
  assert.equal(levels.full!.provenance?.resolvedFrom?.origin, legacy.provenance.resolvedFrom.origin);
  assert.equal("artifactContents" in levels.summary!, false, "summary leaves out the contents summary");
  assert.equal("provenance" in levels.standard!, false, "provenance is kept only at full");
  assert.equal("provenance" in levels.summary!, false);
});

test("artifact-index matches index-artifact for a reused artifact", async () => {
  const { envelope } = await catalog("artifact-index", {
    target: { kind: "artifact", artifactId: jarArtifactId },
    force: true
  });
  const legacy = (await eightX("index-artifact", { artifactId: jarArtifactId, force: true })).envelope.result!;
  const artifact = envelope.result!.artifact;
  assert.equal(artifact.artifactId, legacy.artifactId);
  assert.equal(artifact.reindexed, legacy.reindexed);
  assert.equal(artifact.reason, legacy.reason);
  assert.deepEqual(artifact.counts, legacy.counts);
  assert.equal(artifact.mappingApplied, legacy.mappingApplied);
  assert.equal("versionApproximated" in artifact, false, "an exact artifact is reused as plain success");
  assert.equal(envelope.meta.warnings?.some((warning) => warning.code === "version-mismatch") ?? false, false);
});

test("file-list matches list-artifact-files page by page and its next page is a valid file-list call", async () => {
  const first = await catalog("file-list", {
    target: { kind: "artifact", artifactId: jarArtifactId },
    prefix: "com/example/",
    limit: 2
  });
  const legacyFirst = (await eightX("list-artifact-files", { artifactId: jarArtifactId, prefix: "com/example/", limit: 2 }))
    .envelope.result!;
  assert.deepEqual(first.envelope.result!.files, legacyFirst.items);
  assert.deepEqual(first.envelope.meta.pagination, { hasMore: true, nextCursor: legacyFirst.nextCursor });
  assert.equal(first.envelope.result!.artifact.artifactId, jarArtifactId);

  const next = first.envelope.meta.nextActions?.find((action) => action.tool === "file-list");
  assert.ok(next, "a next-page action is offered");
  assert.equal(next.params.cursor, legacyFirst.nextCursor);
  const second = await catalog("file-list", next.params);
  const legacySecond = (await eightX("list-artifact-files", {
    artifactId: jarArtifactId,
    prefix: "com/example/",
    limit: 2,
    cursor: legacyFirst.nextCursor
  })).envelope.result!;
  assert.deepEqual(second.envelope.result!.files, legacySecond.items);
  assert.equal(second.envelope.meta.pagination?.hasMore, legacySecond.nextCursor !== undefined);
});

test("file-read matches get-artifact-file and reports a maxBytes cut in meta.truncation", async () => {
  const filePath = "com/example/FixtureWidget.java";
  const { envelope } = await catalog("file-read", { target: { kind: "jar", jarPath }, filePath });
  const legacy = (await eightX("get-artifact-file", { target: { kind: "jar", value: jarPath }, filePath })).envelope.result!;
  assert.equal(envelope.result!.content, legacy.content);
  assert.equal(envelope.result!.contentBytes, legacy.contentBytes);
  assert.equal(envelope.result!.artifact.artifactId, jarArtifactId);
  assert.equal(envelope.meta.truncation, undefined);

  const cut = await catalog("file-read", { target: { kind: "artifact", artifactId: jarArtifactId }, filePath, maxBytes: 10 });
  const legacyCut = (await eightX("get-artifact-file", { artifactId: jarArtifactId, filePath, maxBytes: 10 })).envelope.result!;
  assert.equal(legacyCut.truncated, true);
  assert.equal(cut.envelope.result!.content, legacyCut.content);
  assert.deepEqual(cut.envelope.meta.truncation, [{ field: "content", limitedBy: "maxBytes" }]);
  assert.equal("truncated" in cut.envelope.result!, false, "no truncation flag inside result");
});

test("target locators are trimmed, and a whitespace-only locator fails naming its path", async () => {
  const padded = await catalog("file-read", {
    target: { kind: "artifact", artifactId: `  ${jarArtifactId}  ` },
    filePath: " com/example/FixtureWidget.java "
  });
  assert.equal(padded.envelope.error, undefined, JSON.stringify(padded.envelope.error));
  assert.equal(padded.envelope.result!.artifact.artifactId, jarArtifactId);
  assert.match(padded.envelope.result!.content, /class FixtureWidget/);

  const blank = await catalog("file-list", { target: { kind: "jar", jarPath: "   " } });
  assert.equal(blank.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.ok(blank.envelope.error?.fieldErrors?.some((entry) => entry.path === "target.jarPath"));
});

test("class-find matches find-class and reports ok, ambiguous and not_found", async () => {
  const target = { kind: "artifact", artifactId: jarArtifactId };
  const cases: Array<[string, string]> = [
    ["FixtureGadget", "ok"],
    ["FixtureWidget", "ambiguous"],
    ["NoSuchFixtureClass", "not_found"]
  ];
  for (const [className, status] of cases) {
    const { envelope } = await catalog("class-find", { target, className });
    const legacy = (await eightX("find-class", { artifactId: jarArtifactId, className })).envelope.result!;
    assert.equal(envelope.result!.status, status, className);
    assertDeclaredStatus("class-find", envelope.result);
    assert.deepEqual(
      envelope.result!.classes.map((entry: { className: string }) => entry.className),
      legacy.matches.map((match: { qualifiedName: string }) => match.qualifiedName)
    );
    assert.equal(envelope.meta.truncation, undefined, `${className}: nothing was cut`);
  }

  // Two matches with limit 1: one class is returned, the name stays ambiguous and the cut is reported.
  const cut = await catalog("class-find", { target, className: "FixtureWidget", limit: 1 });
  const legacyCut = (await eightX("find-class", { artifactId: jarArtifactId, className: "FixtureWidget", limit: 1 }))
    .envelope.result!;
  assert.equal(cut.envelope.result!.status, "ambiguous");
  assert.deepEqual(
    cut.envelope.result!.classes.map((entry: { className: string }) => entry.className),
    legacyCut.matches.map((match: { qualifiedName: string }) => match.qualifiedName)
  );
  assert.deepEqual(cut.envelope.meta.truncation, [{ field: "classes", limitedBy: "limit" }]);

  // A limit that holds every match cuts nothing.
  const both = await catalog("class-find", { target, className: "FixtureWidget", limit: 2 });
  assert.equal(both.envelope.result!.status, "ambiguous");
  assert.equal(both.envelope.result!.classes.length, 2);
  assert.equal(both.envelope.meta.truncation, undefined);
  const single = await catalog("class-find", { target, className: "FixtureGadget", limit: 1 });
  assert.equal(single.envelope.result!.status, "ok");
  assert.equal(single.envelope.meta.truncation, undefined);
});

test("class-find at the service's 200-match cap reports a full page as possibly cut", async () => {
  const servicesWith = (available: number): CatalogServices =>
    ({
      resolveArtifact: async (input: any) => ({
        artifactId: "artifact-many",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: "obfuscated",
        mappingApplied: "obfuscated",
        version: "1.21.10",
        provenance: { target: input.target, resolvedAt: "", resolvedFrom: { origin: "local-jar" }, transformChain: [] },
        qualityFlags: [],
        artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "full" },
        warnings: []
      }),
      // Like the service: at most min(limit, 200) matches, `total` counting the returned ones.
      findClassIncludingNested: async (input: { limit?: number }) => {
        const count = Math.min(available, input.limit ?? 20, 200);
        const matches = Array.from({ length: count }, (_, index) => ({
          qualifiedName: `p${index}.Widget`,
          filePath: `p${index}/Widget.java`,
          line: 1,
          symbolKind: "class"
        }));
        return { matches, total: matches.length, warnings: [] };
      }
    }) as unknown as CatalogServices;
  const request = { target: { kind: "version", version: "1.21.10" }, className: "Widget", limit: 200 };

  const full = (await runCatalogTool(specOf("class-find"), request, injectedRuntime(servicesWith(200))))
    .structuredContent as Envelope;
  assert.equal(full.result!.classes.length, 200);
  assert.deepEqual(full.meta.truncation, [{ field: "classes", limitedBy: "limit" }]);

  const partial = (await runCatalogTool(specOf("class-find"), request, injectedRuntime(servicesWith(150))))
    .structuredContent as Envelope;
  assert.equal(partial.result!.classes.length, 150);
  assert.equal(partial.result!.status, "ambiguous");
  assert.equal(partial.meta.truncation, undefined);
});

test("a dependency target reads its version from target.projectPath or takes dependencyVersion", async () => {
  const fromProject = await catalog("file-read", {
    target: { kind: "dependency", group: "com.example", name: "dep-lib", projectPath: dependencyProject },
    filePath: "com/example/dep/DepWidget.java"
  });
  const legacy = await eightX("get-artifact-file", {
    target: { kind: "dependency", group: "com.example", name: "dep-lib", versionFromProject: true },
    projectPath: dependencyProject,
    filePath: "com/example/dep/DepWidget.java"
  });
  assert.equal(fromProject.isError, false);
  assert.equal(fromProject.envelope.result!.content, legacy.envelope.result!.content);

  const explicit = await catalog("class-find", {
    target: { kind: "dependency", group: "com.example", name: "dep-lib", dependencyVersion: "1.0.0" },
    className: "DepWidget"
  });
  assert.deepEqual(explicit.envelope.result!.classes.map((entry: { className: string }) => entry.className), [
    "com.example.dep.DepWidget"
  ]);
  assert.equal(explicit.envelope.result!.artifact.artifactId, fromProject.envelope.result!.artifact.artifactId);

  const neither = await catalog("class-find", {
    target: { kind: "dependency", group: "com.example", name: "dep-lib" },
    className: "DepWidget"
  });
  assert.equal(neither.envelope.error?.code, "ERR_INVALID_INPUT");
  const fieldError = neither.envelope.error?.fieldErrors?.find((entry) => entry.path === "target.dependencyVersion");
  assert.ok(fieldError, "the missing version is named by its path");
  assert.match(fieldError.message, /dependencyVersion/);
  assert.match(fieldError.message, /projectPath/);

  // The resolver's own check of the version is reported under the catalog name.
  const unsafe = await catalog("class-find", {
    target: { kind: "dependency", group: "com.example", name: "dep-lib", dependencyVersion: "../bad" },
    className: "DepWidget"
  });
  assert.equal(unsafe.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(unsafe.envelope.error?.fieldErrors?.map((entry) => entry.path), ["target.dependencyVersion"]);
});

test("a strict version request fails like resolve-artifact and offers the non-strict artifact-resolve call", async () => {
  const request = {
    target: { kind: "version", version: APPROX_VERSION, projectPath: approxProject },
    mapping: "mojang",
    strictVersion: true
  };
  const { envelope, isError } = await catalog("artifact-resolve", request);
  const legacy = (await eightX("resolve-artifact", {
    target: { kind: "version", value: APPROX_VERSION },
    projectPath: approxProject,
    mapping: "mojang",
    strictVersion: true
  })).envelope.error!;
  assert.equal(isError, true);
  assert.equal(legacy.suggestedCall?.tool, "resolve-artifact", "positive control: the service suggestion exists");
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(envelope.error?.[key], legacy[key], key);
  }
  assert.equal("suggestedCall" in envelope.error!, false);
  // The retry keeps the request's mapping and projectPath: without the mapping
  // it would resolve another artifact than the approximated Mojang source.
  assert.deepEqual(envelope.meta.nextActions, [
    {
      tool: "artifact-resolve",
      params: { target: { kind: "version", version: APPROX_VERSION, projectPath: approxProject }, mapping: "mojang", strictVersion: false }
    }
  ]);
  const retried = await catalog("artifact-resolve", envelope.meta.nextActions![0]!.params);
  assert.equal(retried.isError, false, JSON.stringify(retried.envelope.error));
  assert.equal(retried.envelope.result!.artifact.versionApproximated, true);
  assert.equal(retried.envelope.result!.artifact.mappingApplied, "mojang");
});

test("a version served by approximation is never plain success", async () => {
  const target = { kind: "version", version: APPROX_VERSION, projectPath: approxProject };
  const resolved = await catalog("artifact-resolve", { target, mapping: "mojang" });
  assert.equal(resolved.envelope.error, undefined, JSON.stringify(resolved.envelope.error));
  const artifact = resolved.envelope.result!.artifact;
  assert.equal(artifact.versionApproximated, true);
  assert.equal(artifact.requestedVersion, APPROX_VERSION);
  assert.equal(artifact.version, LOOM_VERSION);
  const mismatch = resolved.envelope.meta.warnings?.filter((warning) => warning.code === "version-mismatch") ?? [];
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0]!.severity, "warning");
  assert.match(mismatch[0]!.message, new RegExp(`Minecraft ${LOOM_VERSION.replace(/\./g, "\\.")}`));
  assert.equal(
    resolved.envelope.meta.warnings?.some((warning) => warning.message.includes("does not contain exact version string")),
    false,
    "the resolver's own approximation sentence is replaced by the structured warning"
  );
  assert.equal(
    resolved.envelope.meta.warnings?.some((warning) =>
      warning.message.startsWith("Resolved source-backed artifact from Loom cache candidate:")
    ),
    false,
    "the routine Loom resolution notice is left out"
  );

  // Reusing the returned artifactId names no version, so it reports the
  // served version and no approximation.
  const reused = await catalog("file-read", {
    target: { kind: "artifact", artifactId: artifact.artifactId },
    filePath: "net/minecraft/world/level/block/Blocks.java"
  });
  assert.equal(reused.envelope.error, undefined, JSON.stringify(reused.envelope.error));
  assert.deepEqual(reused.envelope.result!.artifact, {
    artifactId: artifact.artifactId,
    version: LOOM_VERSION,
    mappingApplied: artifact.mappingApplied
  });
  assert.equal(reused.envelope.meta.warnings?.some((warning) => warning.code === "version-mismatch") ?? false, false);

  const misplaced = await catalog("artifact-resolve", { target, version: LOOM_VERSION });
  assert.equal(misplaced.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.equal(misplaced.envelope.error?.fieldErrors?.[0]?.path, "version");
});

test("an artifactId shared by an approximated and an exact version reports the served version on reuse, in either order", async (t) => {
  const blocksPath = "net/minecraft/world/level/block/Blocks.java";
  const orders: Array<[string, string[]]> = [
    ["approx-first", [APPROX_VERSION, LOOM_VERSION]],
    ["exact-first", [LOOM_VERSION, APPROX_VERSION]]
  ];
  const idsByOrder: string[] = [];
  serveLoomVersion = true;
  try {
    for (const [order, versions] of orders) {
      // A subtest per order, so one order failing still runs the other.
      await t.test(order, async () => {
        // Each order gets its own Loom cache, so its first resolve stores a fresh artifact.
        const project = join(root, `shared-artifact-${order}`);
        const loomCache = join(project, ".gradle", "loom-cache");
        mkdirSync(loomCache, { recursive: true });
        await createJar(join(loomCache, `minecraft-${LOOM_VERSION}-merged-sources.jar`), {
          [blocksPath]: `package net.minecraft.world.level.block;\n// ${order}\npublic class Blocks {}`
        });
        const ids: string[] = [];
        for (const version of versions) {
          const resolved = await catalog("artifact-resolve", {
            target: { kind: "version", version, projectPath: project },
            mapping: "mojang"
          });
          assert.equal(resolved.envelope.error, undefined, `${order} ${version}: ${JSON.stringify(resolved.envelope.error)}`);
          const fresh = resolved.envelope.result!.artifact;
          // Positive control: artifact-resolve still discloses its own request.
          assert.equal(fresh.versionApproximated === true, version === APPROX_VERSION, `${order} ${version}: artifact-resolve`);
          ids.push(fresh.artifactId);

          const reused = await catalog("file-read", {
            target: { kind: "artifact", artifactId: fresh.artifactId },
            filePath: blocksPath
          });
          assert.equal(reused.envelope.error, undefined, `${order} ${version}: ${JSON.stringify(reused.envelope.error)}`);
          const artifact = reused.envelope.result!.artifact;
          assert.equal(artifact.version, LOOM_VERSION, `${order} after ${version}: the served version`);
          assert.equal("requestedVersion" in artifact, false, `${order} after ${version}: no requestedVersion`);
          assert.equal("versionApproximated" in artifact, false, `${order} after ${version}: no versionApproximated`);
          assert.equal(
            reused.envelope.meta.warnings?.some((warning) => warning.code === "version-mismatch") ?? false,
            false,
            `${order} after ${version}: no version-mismatch warning`
          );
        }
        assert.equal(ids[0], ids[1], `${order}: both versions share one artifactId`);
        idsByOrder.push(ids[0]!);
      });
    }
  } finally {
    serveLoomVersion = false;
  }
  assert.notEqual(idsByOrder[0], idsByOrder[1], "each order resolved its own artifact");
});

test("every resolution tool validates its examples and rejects unknown and misspelled keys", async () => {
  for (const spec of RESOLUTION_TOOL_SPECS) {
    for (const example of spec.examples) {
      const reply = await catalog(spec.name, example);
      assert.notEqual(reply.envelope.error?.code, "ERR_INVALID_INPUT", `${spec.name} example ${JSON.stringify(example)}`);
      for (const action of reply.envelope.meta.nextActions ?? []) {
        if (action.template !== true) {
          assert.equal(JSON.stringify(action.params).includes('"version":"latest"'), false, `${spec.name}: no "latest" call`);
        }
      }
    }
    const example = spec.examples[0]!;

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

    const shape = (spec.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    const key = Object.keys(shape)[0]!;
    const nearMiss = key.slice(0, 1) + key.slice(2);
    const { [key]: original, ...rest } = example as Record<string, unknown>;
    const misspelled = await catalog(spec.name, { ...rest, [nearMiss]: original ?? 1 });
    assert.equal(misspelled.envelope.error?.code, "ERR_INVALID_INPUT");
    const suggestion = misspelled.envelope.error?.fieldErrors?.find((entry) => entry.path === nearMiss);
    assert.ok(suggestion?.suggestions?.includes(key), `${spec.name}: "${nearMiss}" suggests "${key}"`);
  }
});

test("an unknown artifactId fails with the code get-artifact-file reports and offers an artifact-resolve template with a version placeholder", async () => {
  const request = { target: { kind: "artifact", artifactId: "artifact-id" }, filePath: "a/B.java" };
  const { envelope } = await catalog("file-read", request);
  const legacy = (await eightX("get-artifact-file", { artifactId: "artifact-id", filePath: "a/B.java" })).envelope.error!;
  assert.equal(envelope.error?.code, legacy.code);
  assert.equal(legacy.suggestedCall?.params?.target?.value, "latest", "positive control: the service suggests \"latest\"");
  const template = envelope.meta.nextActions?.find((action) => action.tool === "artifact-resolve");
  assert.deepEqual(template, {
    tool: "artifact-resolve",
    params: { target: { kind: "version", version: "<version>" } },
    reason: "Pick a Minecraft version from version-list and put it in place of <version>.",
    template: true
  });
});

test("the Loom resolution notice is routine and left out, while an actionable warning stays", () => {
  const warnings = buildCatalogWarnings(
    [
      "Resolved source-backed artifact from Loom cache candidate: /home/user/mod/.gradle/loom-cache/minecraft-1.21.10-merged-sources.jar.",
      "Source coverage does not include net.minecraft for /x/sources.jar; class lookups may fall back to the binary artifact."
    ],
    "artifact-resolve"
  );
  assert.deepEqual(
    warnings.map((warning) => warning.message),
    ["Source coverage does not include net.minecraft for /x/sources.jar; class lookups may fall back to the binary artifact."]
  );
});

test("artifact-resolve forwards its resolution options to the resolver", async () => {
  let received: Record<string, unknown> | undefined;
  const services = {
    resolveArtifact: async (input: Record<string, unknown>) => {
      received = input;
      return {
        artifactId: "artifact-options",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: "mojang",
        mappingApplied: "mojang",
        version: "1.21.10",
        provenance: { target: { kind: "version", value: "1.21.10" }, resolvedAt: "", resolvedFrom: { origin: "local-jar" }, transformChain: [] },
        qualityFlags: [],
        artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "full" },
        warnings: []
      };
    }
  } as unknown as CatalogServices;
  const reply = await runCatalogTool(
    specOf("artifact-resolve"),
    {
      target: { kind: "version", version: "1.21.10", projectPath: "/w", scope: "merged" },
      mapping: "mojang",
      sourcePriority: "maven-first",
      allowDecompile: false,
      gradleUserHome: "/g",
      preferProjectVersion: true,
      strictVersion: false
    },
    injectedRuntime(services)
  );
  assert.equal((reply.structuredContent as Envelope).result?.artifact?.artifactId, "artifact-options");
  assert.deepEqual(received, {
    target: { kind: "version", value: "1.21.10" },
    projectPath: "/w",
    scope: "merged",
    mapping: "mojang",
    sourcePriority: "maven-first",
    allowDecompile: false,
    gradleUserHome: "/g",
    preferProjectVersion: true,
    strictVersion: false,
    includeSampleEntries: false
  });
});

test("service suggestions naming the replaced 8.x tools become valid catalog calls", () => {
  const cases: Array<[{ tool: string; params: Record<string, unknown> }, { tool: string; params: Record<string, unknown> }]> = [
    [{ tool: "list-versions", params: {} }, { tool: "version-list", params: {} }],
    [
      { tool: "resolve-artifact", params: { target: { kind: "workspace" }, projectPath: "/w", mapping: "mojang" } },
      { tool: "artifact-resolve", params: { target: { kind: "workspace", projectPath: "/w" }, mapping: "mojang" } }
    ],
    [
      { tool: "resolve-artifact", params: { target: { kind: "jar", value: "/j.jar" }, mapping: "mojang", scope: "merged", projectPath: "/w" } },
      { tool: "artifact-resolve", params: { target: { kind: "jar", jarPath: "/j.jar" }, mapping: "mojang" } }
    ],
    [
      {
        tool: "resolve-artifact",
        params: { target: { kind: "dependency", group: "g", name: "n", versionFromProject: true }, projectPath: "/w" }
      },
      { tool: "artifact-resolve", params: { target: { kind: "dependency", group: "g", name: "n", projectPath: "/w" } } }
    ],
    [
      { tool: "list-artifact-files", params: { artifactId: "a1", limit: 50 } },
      { tool: "file-list", params: { target: { kind: "artifact", artifactId: "a1" }, limit: 50 } }
    ],
    [
      { tool: "get-artifact-file", params: { artifactId: "a1", filePath: "a/B.java" } },
      { tool: "file-read", params: { target: { kind: "artifact", artifactId: "a1" }, filePath: "a/B.java" } }
    ],
    [
      { tool: "find-class", params: { className: "Blocks", artifactId: "a1" } },
      { tool: "class-find", params: { target: { kind: "artifact", artifactId: "a1" }, className: "Blocks" } }
    ]
  ];
  for (const [service, expected] of cases) {
    const translated = translateServiceSuggestedCall(service);
    assert.deepEqual(translated, expected, service.tool);
    assert.deepEqual(finalizeNextActions([translated!]), [expected], `${expected.tool} call validates`);
  }
  assert.deepEqual(
    translateServiceSuggestedCall({ tool: "resolve-artifact", params: { target: { kind: "version", value: "latest" } } }),
    {
      tool: "artifact-resolve",
      params: { target: { kind: "version", version: "<version>" } },
      reason: "Pick a Minecraft version from version-list and put it in place of <version>.",
      template: true
    },
    "\"latest\" names no version, so the call is a template"
  );
  assert.equal(
    translateServiceSuggestedCall({ tool: "resolve-artifact", params: { mapping: "obfuscated" } }),
    undefined,
    "a suggestion without a target has no catalog form"
  );
});

test("every target-taking tool reports an approximated version in result.artifact", async () => {
  const services = {
    resolveArtifact: async (input: any) => ({
      artifactId: "artifact-approx",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      version: APPROX_VERSION,
      provenance: {
        target: input.target,
        resolvedAt: "",
        resolvedFrom: { origin: "local-jar" },
        transformChain: [],
        versionApproximation: { requestedVersion: APPROX_VERSION, sourceJarPath: "/loom/minecraft-sources.jar" }
      },
      qualityFlags: ["version-approximated"],
      artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "full" },
      warnings: []
    }),
    indexArtifact: async () => ({
      artifactId: "artifact-approx",
      reindexed: false,
      reason: "already_current",
      counts: { files: 0, symbols: 0, ftsRows: 0 },
      indexedAt: "",
      durationMs: 0,
      mappingApplied: "obfuscated"
    }),
    listArtifactFiles: async () => ({ items: [], mappingApplied: "obfuscated", warnings: [] }),
    getArtifactFile: async () => ({ filePath: "a/B.java", content: "", contentBytes: 0, truncated: false, mappingApplied: "obfuscated" }),
    findClassIncludingNested: async () => ({ matches: [], total: 0, warnings: [] })
  } as unknown as CatalogServices;
  const runtime = injectedRuntime(services);
  const target = { kind: "version", version: APPROX_VERSION };
  const requests: Array<[string, Record<string, unknown>]> = [
    ["artifact-resolve", { target }],
    ["artifact-index", { target }],
    ["file-list", { target }],
    ["file-read", { target, filePath: "a/B.java" }],
    ["class-find", { target, className: "B" }]
  ];
  for (const [name, args] of requests) {
    const envelope = (await runCatalogTool(specOf(name), args, runtime)).structuredContent as Envelope;
    const artifact = envelope.result?.artifact;
    assert.equal(artifact?.versionApproximated, true, name);
    assert.equal(artifact?.requestedVersion, APPROX_VERSION, name);
    assert.equal("version" in artifact, false, `${name}: an unknown served version is not reported as the requested one`);
    const mismatch = envelope.meta.warnings?.find((warning) => warning.code === "version-mismatch");
    assert.equal(mismatch?.severity, "warning", name);
    assert.match(mismatch!.message, /another version/);
  }
});

/** Injected services for a workspace whose sources omit net.minecraft. */
function partialWorkspaceServices(calls: { checkSymbolExists: number }): CatalogServices {
  return {
    resolveArtifact: async (input: any) => ({
      artifactId: "artifact-partial",
      artifactAlias: "partial",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      version: "1.21.10",
      binaryJarPath: "/cache/minecraft-merged-1.21.10.jar",
      provenance: { target: input.target, resolvedAt: "", resolvedFrom: { origin: "local-jar" }, transformChain: [] },
      qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: ["Source coverage does not include net.minecraft."]
    }),
    findClassIncludingNested: async () => ({
      matches: [],
      total: 0,
      warnings: [
        "Artifact source coverage is partial and excludes net.minecraft; returning non-vanilla matches would be misleading."
      ],
      suggestedCall: { tool: "find-class", params: { className: "Item", artifactId: "artifact-partial" } }
    }),
    checkSymbolExists: async (input: any) => {
      calls.checkSymbolExists += 1;
      assert.equal(input.kind, "class");
      assert.equal(input.name, "net.minecraft.world.item.Item");
      assert.equal(input.sourceMapping, "mojang");
      assert.equal(input.version, "1.21.10");
      return {
        resolved: true,
        status: "resolved",
        querySymbol: { kind: "class", name: input.name, symbol: input.name },
        resolvedSymbol: { kind: "class", name: input.name, symbol: input.name },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    }
  } as unknown as CatalogServices;
}

function injectedRuntime(services: CatalogServices): CatalogRuntime {
  return {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  };
}

test("class-find confirms a vanilla class in the binary jar when workspace sources omit net.minecraft", async () => {
  const calls = { checkSymbolExists: 0 };
  const runtime = injectedRuntime(partialWorkspaceServices(calls));
  const reply = await runCatalogTool(
    specOf("class-find"),
    { target: { kind: "workspace", projectPath: "/workspace/demo-mod" }, className: "net.minecraft.world.item.Item" },
    runtime
  );
  const envelope = reply.structuredContent as Envelope;
  assert.equal(calls.checkSymbolExists, 1);
  assert.equal(envelope.result!.status, "ok");
  assert.deepEqual(envelope.result!.classes, [{ className: "net.minecraft.world.item.Item", binaryOnly: true }]);
  assert.equal(envelope.result!.artifact.artifactId, "artifact-partial");
  assert.ok(envelope.meta.warnings?.some((warning) => warning.code === "binary-fallback"));
  assert.equal(envelope.meta.nextActions, undefined, "the source suggestion is dropped once the class is confirmed");

  // A version target has no workspace fallback: the empty index answer stands.
  const versionReply = await runCatalogTool(
    specOf("class-find"),
    { target: { kind: "version", version: "1.21.10" }, className: "net.minecraft.world.item.Item" },
    runtime
  );
  assert.equal((versionReply.structuredContent as Envelope).result!.status, "not_found");
  assert.deepEqual(
    (versionReply.structuredContent as Envelope).meta.nextActions,
    [{ tool: "class-find", params: { target: { kind: "artifact", artifactId: "artifact-partial" }, className: "Item" } }],
    "positive control: without the fallback the service suggestion is offered"
  );
  assert.equal(calls.checkSymbolExists, 1);
});
