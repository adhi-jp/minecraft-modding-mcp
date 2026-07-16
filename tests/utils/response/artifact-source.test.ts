import assert from "node:assert/strict";
import test from "node:test";

import {
  compactResponse,
  compactArtifactResponse,
  compactSourceResponse,
  stripSourceDiagnostics
} from "../../../src/response-utils.ts";

const ARTIFACT_FIXTURE: Record<string, unknown> = {
  artifactId: "artifact-1.21.10-mojang",
  origin: "remote-repo",
  isDecompiled: false,
  version: "1.21.10",
  requestedMapping: "mojang",
  mappingApplied: "mojang",
  qualityFlags: ["source-jar"],
  resolvedSourceJarPath: "/cache/sources/1.21.10-mojang-sources.jar",
  adjacentSourceCandidates: ["/cache/alt-sources.jar"],
  binaryJarPath: "/cache/1.21.10-client.jar",
  coordinate: "net.minecraft:client:1.21.10:sources",
  repoUrl: "https://libraries.minecraft.net",
  provenance: { source: "mojang-manifest", mappingArtifact: "mojmap.tiny", version: "1.21.10", priority: "loom-first" },
  artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" },
  sampleEntries: ["net/minecraft/world/level/Level.java", "net/minecraft/server/MinecraftServer.java"]
};

const ARTIFACT_KEPT_KEYS = [
  "artifactId", "origin", "isDecompiled", "version",
  "requestedMapping", "mappingApplied", "qualityFlags"
];

const ARTIFACT_OMITTED_KEYS = [
  "provenance", "artifactContents", "sampleEntries",
  "adjacentSourceCandidates", "binaryJarPath", "coordinate",
  "repoUrl", "resolvedSourceJarPath"
];

const SOURCE_FIXTURE: Record<string, unknown> = {
  className: "net.minecraft.world.entity.player.Player",
  mode: "snippet",
  sourceText: "public class Player {}",
  totalLines: 10,
  returnedRange: { start: 1, end: 10 },
  truncated: false,
  origin: "remote-repo",
  artifactId: "artifact-1.21.10-mojang",
  requestedMapping: "mojang",
  mappingApplied: "mojang",
  returnedNamespace: "mojang",
  provenance: { target: { kind: "version", value: "1.21.10" }, resolvedAt: "2026-04-18T00:00:00Z", resolvedFrom: { origin: "remote-repo" }, transformChain: ["mapping:mojang-source-backed"] },
  qualityFlags: ["source-jar"],
  artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" }
};

test("compactArtifactResponse projects fields: omits diagnostic, keeps essential, passes through unknown", () => {
  const input = { ...ARTIFACT_FIXTURE, customField: "extra" };
  const result = compactArtifactResponse(input);
  for (const key of ARTIFACT_OMITTED_KEYS) {
    assert.equal(key in result, false, `${key} should be omitted`);
  }
  for (const key of ARTIFACT_KEPT_KEYS) {
    assert.ok(key in result, `${key} should be preserved`);
    assert.deepEqual(result[key], ARTIFACT_FIXTURE[key]);
  }
  assert.equal(result.customField, "extra");
});

test("compactArtifactResponse handles missing optional fields gracefully", () => {
  const minimal: Record<string, unknown> = {
    artifactId: "artifact-1.21.10",
    origin: "decompiled",
    isDecompiled: true,
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    provenance: { source: "decompiled" },
    artifactContents: { sourceKind: "decompiled-binary", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "partial" }
  };
  const result = compactArtifactResponse(minimal);
  assert.equal(result.artifactId, "artifact-1.21.10");
  assert.equal("provenance" in result, false);
  assert.equal("artifactContents" in result, false);
  assert.equal("version" in result, false);
});

test("compactArtifactResponse + compactResponse pipeline on resolve-artifact shape", () => {
  const withWarnings = { ...ARTIFACT_FIXTURE, warnings: ["version approximated"] };
  const afterSplit = { ...withWarnings };
  delete afterSplit.warnings;

  const afterArtifactProjection = compactArtifactResponse(afterSplit);
  const afterCompact = compactResponse(afterArtifactProjection);

  for (const key of ARTIFACT_OMITTED_KEYS) {
    assert.equal(key in afterCompact, false, `${key} should be omitted after pipeline`);
  }
  for (const key of ARTIFACT_KEPT_KEYS) {
    assert.ok(key in afterCompact, `${key} should survive pipeline`);
  }
});

test("compactSourceResponse omits provenance / artifactContents / qualityFlags and preserves payload", () => {
  const result = compactSourceResponse(SOURCE_FIXTURE);
  for (const key of ["provenance", "artifactContents", "qualityFlags"]) {
    assert.equal(key in result, false, `${key} should be omitted`);
  }
  for (const key of [
    "className", "mode", "sourceText", "totalLines", "returnedRange", "truncated",
    "origin", "artifactId", "requestedMapping", "mappingApplied", "returnedNamespace"
  ]) {
    assert.ok(key in result, `${key} should survive compact`);
  }
  assert.equal(result.sourceText, SOURCE_FIXTURE.sourceText);
});

test("compactSourceResponse is idempotent and passes through unknown keys", () => {
  const input = { ...SOURCE_FIXTURE, customField: "extra" };
  const once = compactSourceResponse(input);
  assert.deepEqual(once, compactSourceResponse(once));
  assert.equal(once.customField, "extra");
});

test("stripSourceDiagnostics omits the 3 diagnostics by default while keeping source payload", () => {
  const result = stripSourceDiagnostics(SOURCE_FIXTURE);
  for (const key of ["provenance", "artifactContents", "qualityFlags"]) {
    assert.equal(key in result, false, `${key} should be omitted by default`);
  }
  for (const key of ["className", "sourceText", "origin", "artifactId"]) {
    assert.ok(key in result, `${key} should survive the default strip`);
  }
  // Idempotent w.r.t. a later compact pass.
  assert.deepEqual(stripSourceDiagnostics(result), result);
});

test("compactSourceResponse + compactResponse pipeline strips empty warnings", () => {
  const input: Record<string, unknown> = {
    ...SOURCE_FIXTURE,
    warnings: []
  };
  const projected = compactSourceResponse(input);
  const compacted = compactResponse(projected);
  assert.equal("warnings" in compacted, false, "empty warnings should be stripped by compactResponse");
  assert.equal("provenance" in compacted, false);
  assert.equal("sourceText" in compacted, true);
});

test("compactSourceResponse reduces serialized size vs full response", () => {
  const compact = compactSourceResponse(SOURCE_FIXTURE);
  const fullBytes = Buffer.byteLength(JSON.stringify(SOURCE_FIXTURE), "utf8");
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  assert.ok(
    compactBytes < fullBytes,
    `compact (${compactBytes}B) should be smaller than full (${fullBytes}B)`
  );
});

test("compactArtifactResponse reduces serialized size below 60% of full", () => {
  const full: Record<string, unknown> = {
    artifactId: "artifact-1.21.10-mojang",
    origin: "remote-repo",
    isDecompiled: false,
    version: "1.21.10",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-jar"],
    resolvedSourceJarPath: "/cache/sources/1.21.10-mojang-sources.jar",
    adjacentSourceCandidates: ["/cache/alt-sources.jar"],
    binaryJarPath: "/cache/1.21.10-client.jar",
    coordinate: "net.minecraft:client:1.21.10:sources",
    repoUrl: "https://libraries.minecraft.net",
    provenance: { source: "mojang-manifest", mappingArtifact: "mojmap.tiny", version: "1.21.10", priority: "loom-first" },
    artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" },
    sampleEntries: ["net/minecraft/world/level/Level.java", "net/minecraft/server/MinecraftServer.java"]
  };
  const compact = compactArtifactResponse(full);

  const fullBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");

  assert.ok(
    compactBytes < fullBytes * 0.6,
    `compact (${compactBytes}B) should be < 60% of full (${fullBytes}B)`
  );
});
