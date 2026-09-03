import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

// ---------------------------------------------------------------------------
// The binary companion attached beside a LOCALLY resolved sources jar.
//
// Two legs return that shape - the ~/.m2 sources loop and the Gradle-cache
// sources branch - and both used to pick the companion on existence alone. Both
// consequences are the ones every other leg of this cascade already avoids: an
// interrupted copy in one store vetoes a perfectly good jar in the other, and a
// readable-but-class-free companion arrives with nothing to explain the empty
// decompile that follows.
// ---------------------------------------------------------------------------

const CLASS_FILE_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const NO_CLASSES_FLAG = "binary-jar-no-classes";

/** Gradle's cache layout for one coordinate: <group>/<artifact>/<version>/<hash>/<file>. */
function gradleCacheJarPath(
  gradleUserHome: string,
  groupId: string,
  artifactId: string,
  version: string,
  fileName: string
): string {
  return join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    groupId,
    artifactId,
    version,
    "binary-hash",
    fileName
  );
}

/** Write a file that passes an existence check but is not a readable archive. */
async function writeUnreadableJar(jarPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(jarPath), { recursive: true });
  await writeFile(jarPath, bytes);
}

/** Run `body` with GRADLE_USER_HOME pinned so no real user cache leaks into the test. */
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

/** No repository is reachable: every local leg under test must answer on its own. */
const offlineFetch: typeof fetch = (async () =>
  new Response("not found", { status: 404 })) as typeof fetch;

async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("resolveSourceTarget(targetKind=coordinate) skips a corrupt m2 binary companion for the readable Gradle one beside LOCAL m2 sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-a1-m2-sources-companion-order-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:local-shadowed:1.0";
  const versionDir = join(root, "m2", "com", "example", "local-shadowed", "1.0");

  await createJar(join(versionDir, "local-shadowed-1.0-sources.jar"), {
    "com/example/LocalShadowed.java": [
      "package com.example;",
      "public class LocalShadowed {}"
    ].join("\n")
  });
  const corruptM2JarPath = join(versionDir, "local-shadowed-1.0.jar");
  await writeUnreadableJar(corruptM2JarPath, Buffer.from("this is not a zip archive", "utf8"));

  const gradleJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "local-shadowed",
    "1.0",
    "local-shadowed-1.0.jar"
  );
  await createJar(gradleJarPath, {
    "com/example/LocalShadowed.class": CLASS_FILE_MAGIC
  });

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(offlineFetch, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: coordinate },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(
    resolved.binaryJarPath,
    gradleJarPath,
    "a corrupt companion in the first store must not shadow a good companion in the second"
  );
});

test("resolveSourceTarget(targetKind=coordinate) flags a class-free m2 binary companion attached beside LOCAL m2 sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-a1-m2-sources-companion-flag-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:local-empty-companion:1.0";
  const versionDir = join(root, "m2", "com", "example", "local-empty-companion", "1.0");

  await createJar(join(versionDir, "local-empty-companion-1.0-sources.jar"), {
    "com/example/LocalEmptyCompanion.java": [
      "package com.example;",
      "public class LocalEmptyCompanion {}"
    ].join("\n")
  });
  // Readable, well-formed, and holding nothing a decompiler could use.
  const classFreeJarPath = join(versionDir, "local-empty-companion-1.0.jar");
  await createJar(classFreeJarPath, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    "assets/example/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47])
  });

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(offlineFetch, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: coordinate },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.binaryJarPath, classFreeJarPath);
  assert.deepEqual(
    resolved.qualityFlags ?? [],
    [NO_CLASSES_FLAG],
    "a class-free companion must arrive with its reason attached, as it does on every other leg"
  );
});

test("resolveSourceTarget(targetKind=coordinate) skips a corrupt Gradle binary companion for the readable m2 one beside GRADLE sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-a1-gradle-sources-companion-order-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:gradle-shadowed:1.0";

  const gradleSourcesJarPath = join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    "com.example",
    "gradle-shadowed",
    "1.0",
    "sources-hash",
    "gradle-shadowed-1.0-sources.jar"
  );
  await createJar(gradleSourcesJarPath, {
    "com/example/GradleShadowed.java": [
      "package com.example;",
      "public class GradleShadowed {}"
    ].join("\n")
  });
  const corruptGradleJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "gradle-shadowed",
    "1.0",
    "gradle-shadowed-1.0.jar"
  );
  await writeUnreadableJar(corruptGradleJarPath, Buffer.alloc(0));

  const m2JarPath = join(
    root,
    "m2",
    "com",
    "example",
    "gradle-shadowed",
    "1.0",
    "gradle-shadowed-1.0.jar"
  );
  await createJar(m2JarPath, { "com/example/GradleShadowed.class": CLASS_FILE_MAGIC });

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(offlineFetch, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: coordinate },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.sourceJarPath, gradleSourcesJarPath);
  assert.equal(
    resolved.binaryJarPath,
    m2JarPath,
    "a corrupt companion in the sources jar's own store must not shadow a good one next door"
  );
});

test("resolveSourceTarget(targetKind=coordinate) flags a class-free Gradle binary companion attached beside GRADLE sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-a1-gradle-sources-companion-flag-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:gradle-empty-companion:1.0";

  const gradleSourcesJarPath = join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    "com.example",
    "gradle-empty-companion",
    "1.0",
    "sources-hash",
    "gradle-empty-companion-1.0-sources.jar"
  );
  await createJar(gradleSourcesJarPath, {
    "com/example/GradleEmptyCompanion.java": [
      "package com.example;",
      "public class GradleEmptyCompanion {}"
    ].join("\n")
  });
  const classFreeJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "gradle-empty-companion",
    "1.0",
    "gradle-empty-companion-1.0.jar"
  );
  await createJar(classFreeJarPath, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    "data/example/recipe.json": "{}"
  });

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(offlineFetch, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: coordinate },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.sourceJarPath, gradleSourcesJarPath);
  assert.equal(resolved.binaryJarPath, classFreeJarPath);
  assert.deepEqual(resolved.qualityFlags ?? [], [NO_CLASSES_FLAG]);
});
