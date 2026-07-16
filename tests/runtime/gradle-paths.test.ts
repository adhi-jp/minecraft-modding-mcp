import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildLoaderRuntimeSearchRoots,
  buildVersionSourceSearchRoots
} from "../../src/gradle-paths.ts";
import { withGradleUserHome } from "../helpers/env.ts";

test("buildVersionSourceSearchRoots prefers explicit Gradle user home over process default", async () => {
  const root = await mkdtemp(join(tmpdir(), "gradle-paths-version-roots-"));
  const projectPath = join(root, "workspace");
  const explicitGradleUserHome = join(root, "explicit-gradle-home");
  const defaultGradleUserHome = join(root, "default-gradle-home");

  await withGradleUserHome(defaultGradleUserHome, async () => {
    const roots = buildVersionSourceSearchRoots({
      projectPath,
      gradleUserHome: explicitGradleUserHome
    } as any);

    assert.deepEqual(roots, [
      resolve(projectPath, ".gradle", "loom-cache"),
      resolve(projectPath, ".gradle-user", "caches", "fabric-loom"),
      resolve(projectPath, ".gradle", "caches", "fabric-loom"),
      resolve(root, ".gradle-user-home", "loom-cache"),
      resolve(root, ".gradle-user-home", "caches", "fabric-loom"),
      resolve(explicitGradleUserHome, "loom-cache"),
      resolve(explicitGradleUserHome, "caches", "fabric-loom")
    ]);
    assert.ok(!roots.some((entry) => entry.startsWith(defaultGradleUserHome)));
  });
});

test("buildLoaderRuntimeSearchRoots prefers explicit Gradle user home over process default", async () => {
  const root = await mkdtemp(join(tmpdir(), "gradle-paths-loader-roots-"));
  const projectPath = join(root, "workspace");
  const explicitGradleUserHome = join(root, "explicit-gradle-home");
  const defaultGradleUserHome = join(root, "default-gradle-home");

  await withGradleUserHome(defaultGradleUserHome, async () => {
    const roots = buildLoaderRuntimeSearchRoots({
      projectPath,
      gradleUserHome: explicitGradleUserHome
    } as any);

    assert.ok(roots.includes(resolve(projectPath, "build")));
    assert.ok(roots.includes(resolve(projectPath, ".gradle", "caches", "moddev")));
    assert.ok(roots.includes(resolve(explicitGradleUserHome, "caches", "forge_gradle")));
    assert.ok(roots.includes(resolve(explicitGradleUserHome, "caches", "neogradle")));
    assert.ok(roots.includes(resolve(explicitGradleUserHome, "caches", "neoformruntime")));
    assert.ok(roots.includes(resolve(explicitGradleUserHome, "caches", "moddev")));
    assert.ok(!roots.some((entry) => entry.startsWith(defaultGradleUserHome)));
  });
});

import {
  normalizeOptionalGradleUserHomePath,
  resolveGradleUserHomePath
} from "../../src/gradle-paths.ts";
import { homedir } from "node:os";

test("normalizeOptionalGradleUserHomePath returns undefined for undefined, empty, and whitespace-only input", () => {
  assert.equal(normalizeOptionalGradleUserHomePath(undefined), undefined);
  assert.equal(normalizeOptionalGradleUserHomePath(""), undefined);
  assert.equal(normalizeOptionalGradleUserHomePath("   "), undefined);
  assert.equal(normalizeOptionalGradleUserHomePath("\t\n"), undefined);
});

test("normalizeOptionalGradleUserHomePath resolves relative paths against cwd and keeps absolute paths verbatim", () => {
  const absolute = "/tmp/explicit-gradle-home";
  assert.equal(normalizeOptionalGradleUserHomePath(absolute), absolute);
  const relative = "relative-gradle";
  assert.equal(
    normalizeOptionalGradleUserHomePath(relative),
    resolve(process.cwd(), relative)
  );
});

test("resolveGradleUserHomePath prefers an explicit argument over GRADLE_USER_HOME env", async () => {
  const envHome = "/tmp/from-env";
  const explicit = "/tmp/from-arg";
  await withGradleUserHome(envHome, async () => {
    assert.equal(resolveGradleUserHomePath(explicit), explicit);
  });
});

test("resolveGradleUserHomePath falls back to GRADLE_USER_HOME env when no explicit argument is provided", async () => {
  const envHome = "/tmp/env-only-gradle-home";
  await withGradleUserHome(envHome, async () => {
    assert.equal(resolveGradleUserHomePath(undefined), envHome);
    assert.equal(resolveGradleUserHomePath(""), envHome);
    assert.equal(resolveGradleUserHomePath("   "), envHome);
  });
});

test("resolveGradleUserHomePath falls back to ~/.gradle when both explicit and env are absent", async () => {
  const previous = process.env.GRADLE_USER_HOME;
  delete process.env.GRADLE_USER_HOME;
  try {
    const result = resolveGradleUserHomePath(undefined);
    assert.equal(result, resolve(homedir(), ".gradle"));
  } finally {
    if (previous !== undefined) {
      process.env.GRADLE_USER_HOME = previous;
    }
  }
});

test("resolveGradleUserHomePath treats whitespace-only GRADLE_USER_HOME env as absent (falls back to ~/.gradle)", async () => {
  await withGradleUserHome("   ", async () => {
    assert.equal(resolveGradleUserHomePath(undefined), resolve(homedir(), ".gradle"));
  });
});

test("buildVersionSourceSearchRoots accepts the legacy string overload (projectPath only)", async () => {
  const root = await mkdtemp(join(tmpdir(), "gradle-paths-string-overload-"));
  const projectPath = join(root, "workspace");
  await withGradleUserHome("/tmp/legacy-string-overload", async () => {
    const fromObject = buildVersionSourceSearchRoots({ projectPath });
    const fromString = buildVersionSourceSearchRoots(projectPath);
    assert.deepEqual(fromObject, fromString);
  });
});
