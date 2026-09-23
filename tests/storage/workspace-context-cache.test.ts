import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeWorkspaceContextFingerprint,
  createWorkspaceContextCache,
  type WorkspaceContext
} from "../../src/workspace-context-cache.ts";

function makeContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    projectPath: "/tmp/project-a",
    detectedAt: 0,
    evidence: [],
    dependencyVersions: new Map(),
    ...overrides
  };
}

test("createWorkspaceContextCache write+read returns the same context", () => {
  let now = 0;
  const cache = createWorkspaceContextCache({ clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/project-a", minecraftVersion: "1.21.10", detectedAt: now }));
  const got = cache.read("/tmp/project-a");

  assert.ok(got);
  assert.equal(got?.minecraftVersion, "1.21.10");
});

test("createWorkspaceContextCache returns undefined for an unknown projectPath", () => {
  const cache = createWorkspaceContextCache();
  assert.equal(cache.read("/tmp/missing"), undefined);
});

test("createWorkspaceContextCache expires entries after ttlMs", () => {
  let now = 1000;
  const cache = createWorkspaceContextCache({ ttlMs: 500, clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/p", detectedAt: now }));
  assert.ok(cache.read("/tmp/p"));
  now += 600;
  assert.equal(cache.read("/tmp/p"), undefined);
});

test("createWorkspaceContextCache evicts the oldest entry when maxEntries is exceeded", () => {
  let now = 0;
  const cache = createWorkspaceContextCache({ maxEntries: 2, clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/a", detectedAt: now }));
  now += 1;
  cache.write(makeContext({ projectPath: "/tmp/b", detectedAt: now }));
  now += 1;
  cache.write(makeContext({ projectPath: "/tmp/c", detectedAt: now }));

  assert.equal(cache.read("/tmp/a"), undefined);
  assert.ok(cache.read("/tmp/b"));
  assert.ok(cache.read("/tmp/c"));
});

test("createWorkspaceContextCache invalidate removes a single entry", () => {
  let now = 0;
  const cache = createWorkspaceContextCache({ clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/p", detectedAt: now }));
  assert.equal(cache.invalidate("/tmp/p"), true);
  assert.equal(cache.invalidate("/tmp/p"), false);
  assert.equal(cache.read("/tmp/p"), undefined);
});

test("createWorkspaceContextCache list returns all non-expired entries", () => {
  let now = 0;
  const cache = createWorkspaceContextCache({ ttlMs: 100, clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/a", detectedAt: now }));
  cache.write(makeContext({ projectPath: "/tmp/b", detectedAt: now }));
  now += 50;
  const all = cache.list();
  assert.equal(all.length, 2);
  now += 100;
  assert.equal(cache.list().length, 0);
});

test("createWorkspaceContextCache clear removes everything", () => {
  let now = 0;
  const cache = createWorkspaceContextCache({ clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/a", detectedAt: now }));
  cache.write(makeContext({ projectPath: "/tmp/b", detectedAt: now }));
  assert.equal(cache.list().length, 2);
  cache.clear();
  assert.equal(cache.list().length, 0);
});

test("createWorkspaceContextCache write twice for the same projectPath updates and refreshes the entry", () => {
  let now = 0;
  const cache = createWorkspaceContextCache({ maxEntries: 2, clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/a", detectedAt: now, minecraftVersion: "1.21.0" }));
  now += 1;
  cache.write(makeContext({ projectPath: "/tmp/b", detectedAt: now }));
  now += 1;
  cache.write(makeContext({ projectPath: "/tmp/a", detectedAt: now, minecraftVersion: "1.21.10" }));
  now += 1;
  cache.write(makeContext({ projectPath: "/tmp/c", detectedAt: now }));

  assert.equal(cache.read("/tmp/b"), undefined);
  assert.equal(cache.read("/tmp/a")?.minecraftVersion, "1.21.10");
  assert.ok(cache.read("/tmp/c"));
});

test("createWorkspaceContextCache normalizes the projectPath using path.resolve", () => {
  let now = 0;
  const cache = createWorkspaceContextCache({ clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/dir-a", detectedAt: now }));
  assert.ok(cache.read("/tmp/dir-a"));
  assert.ok(cache.read("/tmp/./dir-a"));
  assert.ok(cache.read("/tmp/dir-b/../dir-a"));
});

// ---------------------------------------------------------------------------
// Fingerprint-based invalidation: a cache entry must not survive an edit to
// the project files its detection actually read, even well within the TTL.
// ---------------------------------------------------------------------------

test("createWorkspaceContextCache read() misses once a fingerprinted file's content changes within the TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "wcc-fingerprint-"));
  try {
    const propsPath = join(root, "gradle.properties");
    await writeFile(propsPath, "minecraft_version=1.21.4\n");

    const cache = createWorkspaceContextCache({ ttlMs: 5 * 60_000 });
    cache.write(
      makeContext({
        projectPath: root,
        minecraftVersion: "1.21.4",
        detectedAt: Date.now(),
        fingerprint: computeWorkspaceContextFingerprint([propsPath])
      })
    );
    assert.ok(cache.read(root), "unchanged file: still a hit");

    // Edit the file the detection read - well within the TTL.
    await writeFile(propsPath, "minecraft_version=1.21.10\n");

    assert.equal(
      cache.read(root),
      undefined,
      "an edit to a fingerprinted file must invalidate the entry even though the TTL has not elapsed"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorkspaceContextCache read() hits when every fingerprinted file is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "wcc-fingerprint-stable-"));
  try {
    const propsPath = join(root, "gradle.properties");
    await writeFile(propsPath, "minecraft_version=1.21.4\n");

    const cache = createWorkspaceContextCache({ ttlMs: 5 * 60_000 });
    cache.write(
      makeContext({
        projectPath: root,
        minecraftVersion: "1.21.4",
        detectedAt: Date.now(),
        fingerprint: computeWorkspaceContextFingerprint([propsPath])
      })
    );

    assert.ok(cache.read(root));
    assert.ok(cache.read(root), "reading again without any file change must still hit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorkspaceContextCache read() misses once a fingerprinted-absent file is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "wcc-fingerprint-absent-"));
  try {
    const propsPath = join(root, "gradle.properties");
    // No gradle.properties yet: detection ran and found nothing there.
    const cache = createWorkspaceContextCache({ ttlMs: 5 * 60_000 });
    cache.write(
      makeContext({
        projectPath: root,
        minecraftVersion: undefined,
        detectedAt: Date.now(),
        fingerprint: computeWorkspaceContextFingerprint([propsPath])
      })
    );
    assert.ok(cache.read(root), "absent file, still absent: a hit");

    // The user creates the file within the TTL.
    await writeFile(propsPath, "minecraft_version=1.21.4\n");

    assert.equal(
      cache.read(root),
      undefined,
      "a fingerprinted file going from absent to present must invalidate the entry"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorkspaceContextCache read() ignores fingerprint staleness for an entry with no recorded fingerprint", async () => {
  // A dependency-only partial entry (workspace-target.ts writes these before
  // full detection ever ran) carries no fingerprint; only the TTL applies.
  let now = 0;
  const cache = createWorkspaceContextCache({ clock: () => now });
  cache.write(makeContext({ projectPath: "/tmp/no-fingerprint", detectedAt: now, fingerprint: undefined }));
  assert.ok(cache.read("/tmp/no-fingerprint"));
});

test("computeWorkspaceContextFingerprint records size/mtime for an existing file and absent:true for a missing one", async () => {
  const root = await mkdtemp(join(tmpdir(), "wcc-fingerprint-compute-"));
  try {
    const presentPath = join(root, "gradle.properties");
    await writeFile(presentPath, "minecraft_version=1.21.4\n");
    const missingPath = join(root, "does-not-exist.gradle");

    const fingerprint = computeWorkspaceContextFingerprint([presentPath, missingPath]);

    const present = fingerprint.find((entry) => entry.path === presentPath);
    const missing = fingerprint.find((entry) => entry.path === missingPath);
    assert.ok(present && !("absent" in present));
    assert.ok(missing && "absent" in missing && missing.absent === true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
