import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { composeArtifactId, contentDigestSignature } from "../../src/artifact-identity.ts";
import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * The composed artifactId strings themselves, pinned as literals.
 *
 * Every other artifactId test in this suite compares one resolve against
 * another, so a change that rekeys BOTH sides stays green. These do not: the
 * expected values below were computed once from the layout as shipped, and any
 * edit to how an id is assembled - a reordered part, a renamed id space, a
 * different signature going in - changes the digest and fails here.
 *
 * A deliberate rekey is allowed to update these constants. What is not allowed
 * is a rekey nobody noticed.
 */

/**
 * A stand-in for a jar's content signature: the sha256 of the ASCII string
 * "pinned-jar-bytes", written out so the composed literals below can be
 * recomputed by hand from the recipes quoted in their assertion messages.
 */
const PINNED_JAR_DIGEST = "e890fbabaf994fe9d2cbdf60af72676d71a25b7c80686d7e60e9e5e0c385fd2a";

/** The sha256 of a file's bytes, which is what a jar's signature now is. */
async function sha256OfFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function withGradleHome<T>(gradleUserHome: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = gradleUserHome;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previous;
    }
  }
}

test("the jar id space composes the exact artifactId strings it shipped with", () => {
  assert.equal(
    composeArtifactId({
      space: "jar",
      jarPath: "/artifacts/demo.jar",
      signature: contentDigestSignature(PINNED_JAR_DIGEST)
    }),
    "73ee942babcd4e6192ea96c63ce8a9c1361d622510ef7466a67e10a7f210f244",
    "sha256 of `jar|/artifacts/demo.jar|<PINNED_JAR_DIGEST>|source`"
  );
  assert.equal(
    composeArtifactId({
      space: "jar",
      jarPath: "/artifacts/demo.jar",
      signature: contentDigestSignature(PINNED_JAR_DIGEST),
      signatureQualifier: "decompile",
      mappingVariant: "pass"
    }),
    "671fbaef2358763bceb885775885700e2d758e7499e988b942ae82d135fd37a2",
    "sha256 of `jar|/artifacts/demo.jar|<PINNED_JAR_DIGEST>:decompile|source`"
  );
  assert.equal(
    composeArtifactId({
      space: "jar",
      jarPath: "/artifacts/demo.jar",
      signature: contentDigestSignature(PINNED_JAR_DIGEST),
      signatureQualifier: "decompile",
      mappingVariant: "mojang-remapped"
    }),
    "016726607b45a938b1a48ac5fb37ad82d41a1d06aa0f8c726025cf3906660f92",
    "sha256 of `jar|/artifacts/demo.jar|<PINNED_JAR_DIGEST>:decompile|source|mojang-remapped`"
  );
});

test("a resolved jar target reproduces the jar id recipe from its own path and bytes", async () => {
  // The composer test above pins the layout; this one pins that the jar branch
  // of `resolveSourceTarget` is still the caller feeding it - same id space,
  // same symlink-resolved path, same content digest, same default suffix. The
  // expected value is rebuilt here rather than written out because the path is
  // a temp directory.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "artifact-id-layout-jar-")));
  const sourceJarPath = join(root, "layout-pinned-sources.jar");
  await createJar(sourceJarPath, {
    "com/example/LayoutPinned.java": [
      "package com.example;",
      "public class LayoutPinned {}"
    ].join("\n")
  });

  const resolved = await resolveSourceTarget(
    { kind: "jar", value: sourceJarPath },
    { allowDecompile: true },
    buildTestConfig(root)
  );

  const jarDigest = await sha256OfFile(sourceJarPath);
  const expected = createHash("sha256")
    .update(`jar|${sourceJarPath}|${jarDigest}|source`)
    .digest("hex");

  assert.equal(resolved.origin, "local-jar");
  assert.equal(resolved.artifactSignature, jarDigest);
  assert.equal(resolved.artifactId, expected);
});

test("the coordinate id space composes the exact artifactId string it shipped with", async () => {
  // Fully deterministic end to end: `createJar` writes no timestamps, so the
  // fixture's bytes - and therefore the content digest that becomes the
  // coordinate signature - are the same on every machine. That makes the whole
  // composed id a literal, unlike the jar route whose path is a temp directory.
  const root = await mkdtemp(join(tmpdir(), "artifact-id-layout-coord-"));
  const gradleUserHome = join(root, "gradle-home");
  const moduleDir = join(root, "m2", "com", "example", "pinned-module", "9.8.7");
  await createJar(join(moduleDir, "pinned-module-9.8.7-sources.jar"), {
    "com/example/PinnedLayout.java": [
      "package com.example;",
      "public class PinnedLayout {}"
    ].join("\n")
  });
  // A readable binary companion beside the sources jar, so the cascade never
  // globs a real Gradle cache looking for one. It does not enter the id.
  await createJar(join(moduleDir, "pinned-module-9.8.7.jar"), {
    "com/example/PinnedLayout.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const resolved = await withGradleHome(gradleUserHome, () =>
    resolveSourceTarget(
      { kind: "coordinate", value: "com.example:pinned-module:9.8.7" },
      { allowDecompile: true },
      buildTestConfig(root)
    )
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(
    resolved.artifactSignature,
    "b285de776e08dc394140f470a35e1873250e1939042164830258304ccfe0d161",
    "sha256 of the fixture jar's bytes"
  );
  assert.equal(
    resolved.artifactId,
    "599b2677b014a4bf8fc93ddcf999723594ac1aa8bc53e42c8a4fac6008dce985",
    "sha256 of `coord|com.example:pinned-module:9.8.7|local-m2|<content digest above>`"
  );
});
