import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceContextCache, type WorkspaceContext } from "../../src/workspace-context-cache.ts";

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
