import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildLoaderRuntimeSearchRoots,
  buildVersionSourceSearchRoots
} from "../src/gradle-paths.ts";
import { withGradleUserHome } from "./helpers/env.ts";

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
