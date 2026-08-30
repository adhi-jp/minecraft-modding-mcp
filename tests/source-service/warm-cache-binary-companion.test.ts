import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withTempDir } from "../helpers/temp-dir.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * A binary companion jar that appears in ~/.m2 AFTER the artifact row was first
 * written must reach the row, not just the resolve-artifact response.
 *
 * The sources jar alone decides the artifact signature, so the second resolve
 * takes ingestIfNeeded's `already_current` warm-cache branch - the branch that
 * skips upsertArtifact entirely. Before the fix that branch persisted nothing
 * but alias and updated_at, so resolve-artifact reported the newly found
 * binaryJarPath from its in-memory object while get-class-members on the very
 * same artifactId read the persisted column and failed ERR_CONTEXT_UNRESOLVED.
 */
test("a binary companion discovered on a warm resolve is persisted onto the artifact row", async () => {
  const { SourceService } = await import("../../src/source-service.ts");

  await withTempDir("warm-cache-binary-companion-", async (root) => {
    const coordinate = "com.example:demo:1.0.0";
    const moduleDir = join(root, "m2", "com", "example", "demo", "1.0.0");
    const sourceJarPath = join(moduleDir, "demo-1.0.0-sources.jar");
    const binaryJarPath = join(moduleDir, "demo-1.0.0.jar");

    // (a) Only the sources jar exists at the coordinate's local-m2 path.
    await createJar(sourceJarPath, {
      "com/example/Demo.java": [
        "package com.example;",
        "public class Demo {",
        "  public void tick() {}",
        "}"
      ].join("\n")
    });

    const service = new SourceService(buildTestConfig(root));

    const first = await service.resolveArtifact({
      target: { kind: "coordinate", value: coordinate },
      mapping: "obfuscated"
    });
    assert.equal(first.binaryJarPath, undefined);
    assert.equal(service.getArtifact(first.artifactId).binaryJarPath, undefined);

    // (b) The binary companion lands on disk afterwards, where
    // resolveLocalCoordinateBinaryCandidates looks for it.
    await createJar(binaryJarPath, {
      "com/example/Demo.class": buildClassFile({
        internalName: "com/example/Demo",
        methods: [{ name: "tick", descriptor: "()V", accessFlags: 0x0001 }]
      })
    });

    // (c) Identical sources bytes mean an identical signature, so this resolve
    // is a warm cache hit on the same artifactId.
    const second = await service.resolveArtifact({
      target: { kind: "coordinate", value: coordinate },
      mapping: "obfuscated"
    });
    assert.equal(second.artifactId, first.artifactId);

    // (d) The response and the persisted row must now agree.
    assert.equal(second.binaryJarPath, binaryJarPath);
    assert.equal(service.getArtifact(second.artifactId).binaryJarPath, binaryJarPath);

    // (e) The artifactId-only members path reads that column; it must no longer
    // dead-end in ERR_CONTEXT_UNRESOLVED.
    const members = await service.getClassMembers({
      artifactId: second.artifactId,
      className: "com.example.Demo",
      mapping: "obfuscated"
    });
    assert.deepEqual(
      members.members.methods.map((method) => method.name),
      ["tick"]
    );
  });
});

/**
 * The companion write is one-directional on purpose. A resolve that finds no
 * binary jar is not evidence the persisted one is gone - only that this
 * cascade did not reach it - so a warm hit must never clear a good column and
 * re-break the members path it just fixed.
 */
test("a warm resolve that finds no binary jar leaves an existing binary_jar_path intact", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { ingestIfNeeded } = await import("../../src/source/indexer.ts");

  await withTempDir("warm-cache-binary-keep-", async (root) => {
    const service = new SourceService(buildTestConfig(root));
    const sourceJarPath = join(root, "demo-sources.jar");
    const binaryJarPath = join(root, "demo.jar");
    await createJar(sourceJarPath, {
      "com/example/Demo.java": "package com.example;\npublic class Demo {}"
    });
    await createJar(binaryJarPath, {
      "com/example/Demo.class": buildClassFile({ internalName: "com/example/Demo" })
    });

    const resolved = await service.resolveArtifact({
      target: { kind: "jar", value: binaryJarPath },
      mapping: "obfuscated"
    });
    assert.equal(service.getArtifact(resolved.artifactId).binaryJarPath, binaryJarPath);

    // Same artifact, same signature - a warm hit whose resolver output happens
    // to carry no binaryJarPath at all.
    await ingestIfNeeded(service, {
      artifactId: resolved.artifactId,
      artifactSignature: service.getArtifact(resolved.artifactId).artifactSignature!,
      origin: resolved.origin,
      sourceJarPath: resolved.resolvedSourceJarPath,
      binaryJarPath: undefined,
      isDecompiled: resolved.isDecompiled,
      resolvedAt: new Date().toISOString()
    });

    assert.equal(service.getArtifact(resolved.artifactId).binaryJarPath, binaryJarPath);
  });
});

/**
 * Guards the premise the fix rests on: without a binary companion the members
 * path really does dead-end, so the passing assertions above are not vacuous.
 */
test("a sources-only artifact still refuses an artifactId-only members lookup", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join((await import("node:os")).tmpdir(), "warm-cache-no-binary-"));
  const coordinate = "com.example:demo-no-binary:1.0.0";
  const sourceJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "demo-no-binary",
    "1.0.0",
    "demo-no-binary-1.0.0-sources.jar"
  );
  await createJar(sourceJarPath, {
    "com/example/Demo.java": "package com.example;\npublic class Demo {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "coordinate", value: coordinate },
    mapping: "obfuscated"
  });

  await assert.rejects(
    () =>
      service.getClassMembers({
        artifactId: resolved.artifactId,
        className: "com.example.Demo",
        mapping: "obfuscated"
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.CONTEXT_UNRESOLVED
  );
});
