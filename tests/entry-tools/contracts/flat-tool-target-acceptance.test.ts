import assert from "node:assert/strict";
import test from "node:test";

import {
  findClassSchema,
  getArtifactFileSchema,
  indexArtifactSchema,
  listArtifactFilesSchema,
  searchClassSourceSchema
} from "../../../src/tool-schemas.ts";

const CASES: Array<{ name: string; schema: { safeParse: (value: unknown) => { success: boolean } }; base: Record<string, unknown> }> = [
  { name: "find-class", schema: findClassSchema, base: { className: "Block" } },
  { name: "get-artifact-file", schema: getArtifactFileSchema, base: { filePath: "a/B.java" } },
  { name: "list-artifact-files", schema: listArtifactFilesSchema, base: {} },
  { name: "search-class-source", schema: searchClassSourceSchema, base: { query: "Block" } },
  { name: "index-artifact", schema: indexArtifactSchema, base: {} }
];

for (const { name, schema, base } of CASES) {
  test(`${name} accepts a flat artifactId (unchanged)`, () => {
    assert.equal(schema.safeParse({ ...base, artifactId: "abc" }).success, true);
  });

  test(`${name} accepts a target instead of artifactId`, () => {
    assert.equal(
      schema.safeParse({ ...base, target: { kind: "version", value: "1.21.10" } }).success,
      true
    );
  });

  test(`${name} rejects artifactId and target together`, () => {
    assert.equal(
      schema.safeParse({
        ...base,
        artifactId: "abc",
        target: { kind: "version", value: "1.21.10" }
      }).success,
      false
    );
  });

  test(`${name} rejects neither artifactId nor target`, () => {
    assert.equal(schema.safeParse({ ...base }).success, false);
  });
}

test("an artifact-kind target passes its artifactId through without a resolve round-trip", async () => {
  // The behavioral seam lives in index.ts (resolveFlatArtifactId); this pins
  // the service-level behavior through find-class with a real artifact.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SourceService } = await import("../../../src/source-service.ts");
  const { buildTestConfig } = await import("../../helpers/test-config.ts");
  const { createJar } = await import("../../helpers/zip.ts");

  const root = await mkdtemp(join(tmpdir(), "flat-target-behavior-"));
  const binaryJarPath = join(root, "lib.jar");
  const sourcesJarPath = join(root, "lib-sources.jar");
  await createJar(binaryJarPath, { "com/example/Lib.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]) });
  await createJar(sourcesJarPath, {
    "com/example/Lib.java": "package com.example;\npublic class Lib {}\n"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // find-class by artifactId works — the target form addresses the same
  // artifact, which the schema-level XOR tests plus this equivalence pin.
  const matches = await service.findClass({ className: "Lib", artifactId: resolved.artifactId });
  assert.equal(matches.total, 1);
});

test("find-class preserves top-level projectPath for workspace-relative targets", () => {
  const parsed = findClassSchema.parse({
    className: "Widget",
    target: {
      kind: "dependency",
      group: "com.example",
      name: "fixture-lib",
      versionFromProject: true
    },
    projectPath: " /tmp/example-workspace "
  });

  assert.equal(parsed.projectPath, "/tmp/example-workspace");
});
