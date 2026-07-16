import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_CACHE_KINDS, type CacheEntry, type CacheRegistry } from "../../../src/cache-registry.ts";
import { ERROR_CODES } from "../../../src/errors.ts";
import { ManageCacheService, manageCacheSchema } from "../../../src/entry-tools/manage-cache-service.ts";

function createRegistry(overrides: Partial<CacheRegistry> = {}): CacheRegistry {
  return {
    summarize: async () => {
      throw new Error("summarize not used");
    },
    listEntries: async () => {
      throw new Error("listEntries not used");
    },
    inspectEntries: async () => {
      throw new Error("inspectEntries not used");
    },
    verifyEntries: async () => {
      throw new Error("verifyEntries not used");
    },
    deleteEntries: async () => {
      throw new Error("deleteEntries not used");
    },
    pruneEntries: async () => {
      throw new Error("pruneEntries not used");
    },
    rebuildEntries: async () => {
      throw new Error("rebuildEntries not used");
    },
    ...overrides
  };
}

function cacheEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    cacheKind: "downloads",
    entryId: "client-1.21.10.jar",
    path: "/cache/downloads/client-1.21.10.jar",
    sizeBytes: 16,
    status: "healthy",
    ...overrides
  };
}

test("summary aggregates entry counts and bytes across all default cache kinds and reports ok when every kind is healthy", async () => {
  let seenInput: { cacheKinds?: readonly string[] } | undefined;
  const service = new ManageCacheService({
    registry: createRegistry({
      summarize: async (input) => {
        seenInput = input;
        return {
          kinds: {
            downloads: { cacheKind: "downloads", entryCount: 2, totalBytes: 100, status: "healthy" },
            mapping: { cacheKind: "mapping", entryCount: 3, totalBytes: 50, status: "healthy" },
            // A kind whose per-kind stats are missing must fall back to 0, not NaN.
            registry: undefined
          }
        };
      }
    })
  });

  const result = await service.execute(manageCacheSchema.parse({ action: "summary" }));

  assert.equal(result.summary.status, "ok");
  assert.equal(result.summary.headline, `Summarized ${PUBLIC_CACHE_KINDS.length} cache kind(s).`);
  assert.deepEqual(result.summary.counts, { entries: 5, bytes: 150 });
  assert.deepEqual(seenInput?.cacheKinds, [...PUBLIC_CACHE_KINDS]);
  assert.equal(result.operation?.executionMode, "preview");
  assert.equal(result.stats, undefined);
  assert.deepEqual(result.warnings, []);
});

test("summary reports partial status and exposes per-kind stats at standard detail when a cache kind is unhealthy", async () => {
  const kinds = {
    downloads: { cacheKind: "downloads", entryCount: 1, totalBytes: 10, status: "healthy" },
    mapping: { cacheKind: "mapping", entryCount: 4, totalBytes: 40, status: "stale" }
  } as const;
  const service = new ManageCacheService({
    registry: createRegistry({
      summarize: async () => ({ kinds })
    })
  });

  const result = await service.execute(
    manageCacheSchema.parse({ action: "summary", cacheKinds: ["downloads", "mapping"], detail: "standard" })
  );

  assert.equal(result.summary.status, "partial");
  assert.equal(result.summary.headline, "Summarized 2 cache kind(s).");
  assert.deepEqual(result.summary.counts, { entries: 5, bytes: 50 });
  assert.deepEqual(result.stats, kinds);
});

test("list forwards limit and cursor to the registry and surfaces nextCursor in pagination meta", async () => {
  const entries = [
    cacheEntry({ entryId: "a.jar", path: "/cache/downloads/a.jar" }),
    cacheEntry({ entryId: "b.jar", path: "/cache/downloads/b.jar", status: "stale" })
  ];
  let seenInput: { limit?: number; cursor?: string } | undefined;
  const service = new ManageCacheService({
    registry: createRegistry({
      listEntries: async (input) => {
        seenInput = input;
        return { entries, nextCursor: "cursor-2" };
      }
    })
  });

  const result = await service.execute(
    manageCacheSchema.parse({
      action: "list",
      cacheKinds: ["downloads"],
      limit: 2,
      cursor: "cursor-1",
      detail: "standard"
    })
  );

  assert.equal(seenInput?.limit, 2);
  assert.equal(seenInput?.cursor, "cursor-1");
  assert.deepEqual(result.meta, { pagination: { nextCursor: "cursor-2" } });
  assert.equal(result.summary.status, "partial");
  assert.equal(result.summary.headline, "Listed 2 cache entries.");
  assert.deepEqual(result.summary.counts, { entries: 2 });
  assert.deepEqual(result.cacheEntries, entries);
  assert.equal(result.operation?.executionMode, "preview");
});

test("list omits pagination meta and reports ok for a single healthy entry", async () => {
  let seenInput: { limit?: number } | undefined;
  const service = new ManageCacheService({
    registry: createRegistry({
      listEntries: async (input) => {
        seenInput = input;
        return { entries: [cacheEntry()], nextCursor: undefined };
      }
    })
  });

  const result = await service.execute(manageCacheSchema.parse({ action: "list", cacheKinds: ["downloads"] }));

  assert.equal(result.meta, undefined);
  assert.equal(result.summary.status, "ok");
  assert.equal(result.summary.headline, "Listed 1 cache entry.");
  assert.equal(seenInput?.limit, 50);
});

test("inspect returns entries without pagination and is normalized to preview even when apply is requested", async () => {
  const corruptEntry = cacheEntry({ entryId: "broken.jar", path: "/cache/downloads/broken.jar", status: "corrupt" });
  let seenInput: Record<string, unknown> | undefined;
  const service = new ManageCacheService({
    registry: createRegistry({
      inspectEntries: async (input) => {
        seenInput = input;
        return [corruptEntry];
      }
    })
  });

  const result = await service.execute(
    manageCacheSchema.parse({
      action: "inspect",
      cacheKinds: ["downloads"],
      executionMode: "apply",
      include: ["cacheEntries"]
    })
  );

  assert.equal(result.meta, undefined);
  assert.equal(result.summary.status, "partial");
  assert.equal(result.summary.headline, "Inspected 1 cache entry.");
  assert.deepEqual(result.cacheEntries, [corruptEntry]);
  assert.equal(result.operation?.executionMode, "preview");
  assert.equal(seenInput?.limit, 50);
  assert.equal(seenInput !== undefined && "cursor" in seenInput, false);
});

test("verify reports partial with checked and unhealthy counts and passes registry warnings through", async () => {
  let seenInput: { cacheKinds?: readonly string[]; selector?: Record<string, unknown> } | undefined;
  const service = new ManageCacheService({
    registry: createRegistry({
      verifyEntries: async (input) => {
        seenInput = input;
        return {
          checkedEntries: 3,
          unhealthyEntries: 1,
          warnings: ["Detected cache entries with health states: corrupt."]
        };
      }
    })
  });

  const result = await service.execute(
    manageCacheSchema.parse({ action: "verify", cacheKinds: ["downloads"], selector: { status: "corrupt" } })
  );

  assert.equal(result.summary.status, "partial");
  assert.equal(result.summary.headline, "Verified 3 cache entries.");
  assert.deepEqual(result.summary.counts, { checkedEntries: 3, unhealthyEntries: 1 });
  assert.deepEqual(result.warnings, ["Detected cache entries with health states: corrupt."]);
  assert.deepEqual(seenInput?.cacheKinds, ["downloads"]);
  assert.deepEqual(seenInput?.selector, { status: "corrupt" });
});

test("verify reports ok for a single healthy entry and stays in preview mode even when apply is requested", async () => {
  const service = new ManageCacheService({
    registry: createRegistry({
      verifyEntries: async () => ({ checkedEntries: 1, unhealthyEntries: 0, warnings: [] })
    })
  });

  const result = await service.execute(manageCacheSchema.parse({ action: "verify", executionMode: "apply" }));

  assert.equal(result.summary.status, "ok");
  assert.equal(result.summary.headline, "Verified 1 cache entry.");
  assert.equal(result.operation?.executionMode, "preview");
  assert.deepEqual(result.warnings, []);
});

test("prune in apply mode without a selector is rejected with ERR_INVALID_INPUT before calling the registry", async () => {
  let pruneCalls = 0;
  const service = new ManageCacheService({
    registry: createRegistry({
      pruneEntries: async () => {
        pruneCalls += 1;
        return { deletedEntries: 0, deletedBytes: 0, warnings: [] };
      }
    })
  });

  await assert.rejects(
    () => service.execute(manageCacheSchema.parse({ action: "prune", executionMode: "apply", cacheKinds: ["downloads"] })),
    (error: any) =>
      error.code === ERROR_CODES.INVALID_INPUT &&
      error.message === "prune apply requires a non-empty selector."
  );
  assert.equal(pruneCalls, 0);
});

test("rebuild in apply mode without a selector is rejected with ERR_INVALID_INPUT before calling the registry", async () => {
  let rebuildCalls = 0;
  const service = new ManageCacheService({
    registry: createRegistry({
      rebuildEntries: async () => {
        rebuildCalls += 1;
        return { rebuiltEntries: 0, warnings: [] };
      }
    })
  });

  await assert.rejects(
    () => service.execute(manageCacheSchema.parse({ action: "rebuild", executionMode: "apply" })),
    (error: any) =>
      error.code === ERROR_CODES.INVALID_INPUT &&
      error.message === "rebuild apply requires a non-empty selector."
  );
  assert.equal(rebuildCalls, 0);
});

test("prune preview forwards the selector, reports unchanged, and offers the apply follow-up call", async () => {
  let seenInput: { executionMode?: string; selector?: Record<string, unknown> } | undefined;
  const service = new ManageCacheService({
    registry: createRegistry({
      pruneEntries: async (input) => {
        seenInput = input;
        return { deletedEntries: 3, deletedBytes: 1024, warnings: [] };
      }
    })
  });

  const result = await service.execute(
    manageCacheSchema.parse({
      action: "prune",
      cacheKinds: ["downloads"],
      selector: { status: "stale" }
    })
  );

  assert.equal(seenInput?.executionMode, "preview");
  assert.deepEqual(seenInput?.selector, { status: "stale" });
  assert.equal(result.summary.status, "unchanged");
  assert.equal(result.summary.headline, "Previewed prune across 1 cache kind(s).");
  assert.deepEqual(result.summary.counts, { deletedEntries: 3, deletedBytes: 1024 });
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "manage-cache",
      params: {
        action: "prune",
        cacheKinds: ["downloads"],
        executionMode: "apply",
        selector: { status: "stale" }
      }
    }
  ]);
  assert.deepEqual(result.operation, { executionMode: "preview", deletedEntries: 3, deletedBytes: 1024 });
});

test("rebuild preview reports unchanged with rebuilt counts and offers the apply follow-up call", async () => {
  const service = new ManageCacheService({
    registry: createRegistry({
      rebuildEntries: async () => ({ rebuiltEntries: 2, warnings: [] })
    })
  });

  const result = await service.execute(
    manageCacheSchema.parse({
      action: "rebuild",
      cacheKinds: ["artifact-index"],
      selector: { artifactId: "net.fabricmc:yarn" }
    })
  );

  assert.equal(result.summary.status, "unchanged");
  assert.equal(result.summary.headline, "Previewed rebuild for 1 cache kind(s).");
  assert.deepEqual(result.summary.counts, { rebuiltEntries: 2 });
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "manage-cache",
      params: {
        action: "rebuild",
        cacheKinds: ["artifact-index"],
        executionMode: "apply",
        selector: { artifactId: "net.fabricmc:yarn" }
      }
    }
  ]);
  assert.deepEqual(result.operation, { executionMode: "preview", rebuiltEntries: 2 });
});

test("rebuild in apply mode with a selector reports changed with rebuilt counts and no preview follow-up", async () => {
  let seenInput: { executionMode?: string; selector?: Record<string, unknown> } | undefined;
  const service = new ManageCacheService({
    registry: createRegistry({
      rebuildEntries: async (input) => {
        seenInput = input;
        return { rebuiltEntries: 2, warnings: ["rebuilt artifact index"] };
      }
    })
  });

  const result = await service.execute(
    manageCacheSchema.parse({
      action: "rebuild",
      executionMode: "apply",
      cacheKinds: ["artifact-index"],
      selector: { artifactId: "net.fabricmc:yarn" }
    })
  );

  assert.equal(result.summary.status, "changed");
  assert.equal(result.summary.headline, "Applied rebuild for 1 cache kind(s).");
  assert.deepEqual(result.summary.counts, { rebuiltEntries: 2 });
  assert.equal(result.summary.nextActions, undefined);
  assert.deepEqual(result.summary.subject, {
    action: "rebuild",
    cacheKinds: ["artifact-index"],
    executionMode: "apply",
    selector: { artifactId: "net.fabricmc:yarn" }
  });
  assert.deepEqual(result.operation, { executionMode: "apply", rebuiltEntries: 2 });
  assert.deepEqual(result.warnings, ["rebuilt artifact index"]);
  assert.equal(seenInput?.executionMode, "apply");
  assert.deepEqual(seenInput?.selector, { artifactId: "net.fabricmc:yarn" });
});
