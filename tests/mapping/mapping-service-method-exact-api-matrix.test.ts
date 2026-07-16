import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SourceMapping } from "../../src/types.ts";
import {
  installGradleUserHomeIsolation,
  buildTestConfig,
  withCwd,
  createVersionServiceStub,
  createLoomService,
  TEST_TINY,
  TEST_AMBIGUOUS_METHOD_TINY,
  TEST_DESCRIPTOR_REMAP_TINY,
  TEST_MOJANG_CLIENT_MAPPINGS
} from "../helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

test("MappingService resolveMethodMappingExact resolves representative exact lookup backends", async (t) => {
  const { MappingService } = await import("../../src/mapping-service.ts");

  await t.test("remaps descriptor class refs before strict matching", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-method-exact-descriptor-remap-",
      TEST_DESCRIPTOR_REMAP_TINY
    );
    try {
      const descriptor = "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z";
      const expectedTargetDescriptor =
        "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z";

      const exactResult = await withCwd(root, () =>
        service.resolveMethodMappingExact({
          version: "1.21.10",
          owner: "net.minecraft.class_1937",
          name: "method_1725",
          descriptor,
          sourceMapping: "intermediary",
          targetMapping: "yarn"
        })
      );

      assert.equal(exactResult.resolved, true);
      assert.equal(exactResult.status, "resolved");
      assert.equal(exactResult.resolvedSymbol?.name, "setBlock");
      assert.equal(exactResult.resolvedSymbol?.owner, "net.minecraft.world.level.Level");
      assert.equal(exactResult.resolvedSymbol?.descriptor, expectedTargetDescriptor);

      // findMapping now defaults to signatureMode="name-only" at the service layer too, so
      // internal callers that want strict descriptor preservation must opt in explicitly.
      const findResult = await withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          kind: "method",
          owner: "net.minecraft.class_1937",
          name: "method_1725",
          descriptor,
          sourceMapping: "intermediary",
          targetMapping: "yarn",
          signatureMode: "exact"
        })
      );
      assert.equal(findResult.resolved, true);
      assert.equal(findResult.resolvedSymbol?.descriptor, expectedTargetDescriptor);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("preserves descriptor path through tiny mappings", async () => {
    const { root, service } = await createLoomService("mapping-service-method-exact-", TEST_TINY);
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            resolveMethodMappingExact: (input: {
              version: string;
              kind: "method";
              owner: string;
              name: string;
              descriptor: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
              sourcePriority?: "loom-first" | "maven-first";
            }) => Promise<{
              resolved: boolean;
              status: string;
              resolvedSymbol?: {
                name: string;
                owner?: string;
                descriptor?: string;
              };
              warnings: string[];
            }>;
          }
        ).resolveMethodMappingExact({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.resolved, true);
      assert.equal(result.status, "resolved");
      assert.equal(result.resolvedSymbol?.name, "interMethod");
      assert.equal(result.resolvedSymbol?.owner, "intermediary.pkg.InterClass");
      assert.equal(result.resolvedSymbol?.descriptor, "(I)V");
      assert.equal(result.warnings.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("resolves through mojang client mappings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapping-service-method-exact-mojang-"));
    try {
      const config = buildTestConfig(root);
      const fetchStub = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.test/mappings/client.txt") {
          return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const service = new MappingService(
        config,
        createVersionServiceStub("https://example.test/mappings/client.txt"),
        fetchStub
      );
      const result = await (
        service as unknown as {
          resolveMethodMappingExact: (input: {
            version: string;
            kind: "method";
            owner: string;
            name: string;
            descriptor: string;
            sourceMapping: SourceMapping;
            targetMapping: SourceMapping;
          }) => Promise<{
            resolved: boolean;
            status: string;
            warnings: string[];
          }>;
        }
      ).resolveMethodMappingExact({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(I)V",
        sourceMapping: "obfuscated",
        targetMapping: "mojang"
      });

      assert.equal(result.resolved, true);
      assert.equal(result.status, "resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("MappingService resolveMethodMappingExact reports representative unresolved result states", async (t) => {
  await t.test("returns explicit not_found for misses", async () => {
    const { root, service } = await createLoomService("mapping-service-method-exact-miss-", TEST_TINY);
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            resolveMethodMappingExact: (input: {
              version: string;
              kind: "method";
              owner: string;
              name: string;
              descriptor: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
            }) => Promise<{
              resolved: boolean;
              status: string;
              candidates: unknown[];
            }>;
          }
        ).resolveMethodMappingExact({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "missing",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.resolved, false);
      assert.equal(result.status, "not_found");
      assert.equal(result.candidates.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("returns ambiguous when duplicate target names exist", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-method-exact-ambiguous-",
      TEST_AMBIGUOUS_METHOD_TINY
    );
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            resolveMethodMappingExact: (input: {
              version: string;
              kind: "method";
              owner: string;
              name: string;
              descriptor: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
            }) => Promise<{
              resolved: boolean;
              status: string;
              candidates: Array<{ name: string }>;
            }>;
          }
        ).resolveMethodMappingExact({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.resolved, false);
      assert.equal(result.status, "ambiguous");
      assert.equal(result.candidates.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("applies maxCandidates to ambiguous result sets", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-method-exact-max-candidates-",
      TEST_AMBIGUOUS_METHOD_TINY
    );
    try {
      const result = await withCwd(root, () =>
        service.resolveMethodMappingExact({
          version: "1.21.10",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary",
          maxCandidates: 1
        } as never)
      );

      assert.equal(result.status, "ambiguous");
      assert.equal(result.candidateCount, 2);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidatesTruncated, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("MappingService builds class API matrix across mappings", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          getClassApiMatrix: (input: {
            version: string;
            className: string;
            classNameMapping: SourceMapping;
          }) => Promise<{
            classIdentity: Record<string, string | undefined>;
            rows: Array<{
              kind: string;
              descriptor?: string;
              obfuscated?: { name: string };
              intermediary?: { name: string };
              yarn?: { name: string };
              mojang?: { name: string };
            }>;
          }>;
        }
      ).getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated"
      })
    );

    assert.equal(result.classIdentity.obfuscated, "a.b.C");
    assert.equal(result.classIdentity.intermediary, "intermediary.pkg.InterClass");
    assert.equal(result.classIdentity.yarn, "yarn.pkg.NamedClass");
    assert.equal(result.classIdentity.mojang, "com.mojang.NamedClass");

    const row = result.rows.find(
      (entry) => entry.kind === "method" && entry.descriptor === "(I)V" && entry.obfuscated?.name === "e"
    );
    assert.ok(row);
    assert.equal(row?.intermediary?.name, "interMethod");
    assert.equal(row?.yarn?.name, "namedMethod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix supports maxRows", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-maxrows-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated",
        maxRows: 2
      } as never)
    );

    assert.equal(result.rowCount > 2, true);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rowsTruncated, true);

    // An over-cap maxRows is silently clamped to 5000 downstream; surface a clamp warning.
    const clamped = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated",
        maxRows: 100000
      } as never)
    );
    assert.ok(
      clamped.warnings.some((w: string) => /maxRows was clamped to 5000 from 100000\./.test(w)),
      "expected a maxRows clamp warning"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix maps only the windowed rows (per-row mapping scales with maxRows, not rowCount)", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-windowmap-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const query = { version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated" } as const;

    const beforeWindow = service.apiMatrixStats.rowMaps;
    const windowed = await withCwd(root, () => service.getClassApiMatrix({ ...query, maxRows: 1 } as never));
    const windowMaps = service.apiMatrixStats.rowMaps - beforeWindow;

    const beforeFull = service.apiMatrixStats.rowMaps;
    const full = await withCwd(root, () => service.getClassApiMatrix({ ...query } as never));
    const fullMaps = service.apiMatrixStats.rowMaps - beforeFull;

    // rowCount stays the full deduped count regardless of the window.
    assert.equal(windowed.rowCount, full.rowCount);
    assert.equal(full.rowCount > 1, true);
    // The single-row window maps far fewer rows than the whole class.
    assert.equal(windowMaps < fullMaps, true);
    // Bounded by ~ window rows * (SUPPORTED_MAPPINGS-1) + class-identity hops.
    assert.equal(windowMaps <= 1 * 3 + 6, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix paginates rows with a stable nextCursor", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-cursor-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    // Injective row key: include the descriptor so overloaded members (same
    // name, different descriptor) are distinct, making this a real no-overlap
    // oracle.
    const rowKey = (r: { kind: string; descriptor?: string; obfuscated?: { name?: string }; mojang?: { name?: string } }) =>
      `${r.kind}:${r.obfuscated?.name ?? r.mojang?.name ?? ""}:${r.descriptor ?? ""}`;

    const page1 = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated", maxRows: 1
      } as never)
    );
    assert.equal(page1.rows.length, 1);
    assert.equal(page1.rowsTruncated, true);
    assert.ok(page1.nextCursor, "page 1 must carry a continuation cursor");
    const total = page1.rowCount;
    assert.ok(total > 2, "fixture must have several rows to exercise pagination");

    // Walk every page with maxRows:1; collect keys to prove gap-free, no-overlap,
    // terminating pagination.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await withCwd(root, () =>
        service.getClassApiMatrix({
          version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated", maxRows: 1,
          ...(cursor ? { cursor } : {})
        } as never)
      );
      assert.equal(page.cursorIgnored, undefined);
      assert.ok(page.rows.length <= 1);
      for (const r of page.rows) seen.push(rowKey(r));
      pages += 1;
      assert.ok(pages <= total + 2, "pagination must terminate");
      if (!page.nextCursor) {
        // The final page must not advertise a continuation.
        assert.equal(page.rowsTruncated, undefined);
        break;
      }
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, total, "every row returned exactly once across all pages");
    assert.equal(new Set(seen).size, total, "no row was returned twice (keys are unique)");

    // A malformed cursor is ignored and the scan restarts from the first row.
    const restarted = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated", maxRows: 1,
        cursor: "not-a-valid-cursor"
      } as never)
    );
    assert.equal(restarted.cursorIgnored, true);
    assert.equal(rowKey(restarted.rows[0]!), rowKey(page1.rows[0]!));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix prefers the explicit classNameMapping over obfuscated base rows", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-explicit-base-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);

    (service as any).loadGraph = async () => ({
      version: "1.21.10",
      priority: "loom-first",
      pairs: new Map(),
      adjacency: new Map(),
      pathCache: new Map(),
      classProjectionCache: new Map(),
      exactRecordIndex: new Map(),
      warnings: [],
      recordsByTarget: new Map([
        [
          "mojang",
          [
            {
              kind: "class",
              symbol: "com.mojang.NamedClass",
              name: "NamedClass"
            },
            {
              kind: "method",
              symbol: "com.mojang.NamedClass.namedMethod(I)V",
              owner: "com.mojang.NamedClass",
              name: "namedMethod",
              descriptor: "(I)V"
            }
          ]
        ],
        ["obfuscated", []],
        ["intermediary", []],
        ["yarn", []]
      ])
    });

    (service as any).mapRecordBetweenMappings = (
      _graph: unknown,
      sourceMapping: SourceMapping,
      targetMapping: SourceMapping,
      record: {
        kind: "class" | "field" | "method";
        owner?: string;
        name: string;
        descriptor?: string;
        symbol: string;
      }
    ) => {
      if (record.kind === "class" && sourceMapping === "mojang" && targetMapping === "obfuscated") {
        return [{ kind: "class", symbol: "a.b.C", name: "C" }];
      }
      if (record.kind === "class" && sourceMapping === "mojang" && targetMapping === "intermediary") {
        return [{ kind: "class", symbol: "intermediary.pkg.InterClass", name: "InterClass" }];
      }
      if (record.kind === "class" && sourceMapping === "mojang" && targetMapping === "yarn") {
        return [{ kind: "class", symbol: "yarn.pkg.NamedClass", name: "NamedClass" }];
      }
      if (record.kind === "method" && sourceMapping === "mojang" && targetMapping === "obfuscated") {
        return [{
          kind: "method",
          symbol: "a.b.C.e(I)V",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V"
        }];
      }
      if (record.kind === "method" && sourceMapping === "mojang" && targetMapping === "intermediary") {
        return [{
          kind: "method",
          symbol: "intermediary.pkg.InterClass.interMethod(I)V",
          owner: "intermediary.pkg.InterClass",
          name: "interMethod",
          descriptor: "(I)V"
        }];
      }
      if (record.kind === "method" && sourceMapping === "mojang" && targetMapping === "yarn") {
        return [{
          kind: "method",
          symbol: "yarn.pkg.NamedClass.namedMethod(I)V",
          owner: "yarn.pkg.NamedClass",
          name: "namedMethod",
          descriptor: "(I)V"
        }];
      }
      return [];
    };

    const result = await service.getClassApiMatrix({
      version: "1.21.10",
      className: "com.mojang.NamedClass",
      classNameMapping: "mojang"
    } as never);

    assert.equal(result.classIdentity.mojang, "com.mojang.NamedClass");
    assert.equal(result.classIdentity.obfuscated, "a.b.C");
    assert.equal(result.rowCount, 2);
    assert.ok(
      result.rows.some(
        (row) => row.kind === "method" && row.mojang?.name === "namedMethod" && row.obfuscated?.name === "e"
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix includes competing candidates in ambiguity warnings", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-matrix-competing-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    // Create ambiguous tiny data: two intermediary mappings for the same obfuscated method
    const ambiguousTiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/pkg/C\tyarn/pkg/C",
      "\tm\t(I)V\te\tinterMethod1\tnamedMethod",
      "\tm\t(I)V\te\tinterMethod2\tnamedMethodAlt"
    ].join("\n");

    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${ambiguousTiny}\n`, "utf8");

    const fetchStub = (async () => {
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          getClassApiMatrix: (input: {
            version: string;
            className: string;
            classNameMapping: SourceMapping;
          }) => Promise<{
            warnings: string[];
            ambiguousRowCount?: number;
            rows: Array<{ kind: string }>;
          }>;
        }
      ).getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated"
      })
    );

    const competingWarnings = result.warnings.filter((w: string) => w.includes("competing="));
    assert.equal(result.ambiguousRowCount, 1);
    assert.ok(competingWarnings.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix scopes ambiguity warnings to the returned page", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-matrix-competing-page-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    // Class row (a/b/C, non-ambiguous) sorts before the ambiguous method row.
    const ambiguousTiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/pkg/C\tyarn/pkg/C",
      "\tm\t(I)V\te\tinterMethod1\tnamedMethod",
      "\tm\t(I)V\te\tinterMethod2\tnamedMethodAlt"
    ].join("\n");

    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${ambiguousTiny}\n`, "utf8");

    const fetchStub = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub) as unknown as {
      getClassApiMatrix: (input: {
        version: string;
        className: string;
        classNameMapping: SourceMapping;
        maxRows?: number;
        cursor?: string;
      }) => Promise<{ warnings: string[]; ambiguousRowCount?: number; rowCount: number; nextCursor?: string }>;
    };
    const query = { version: "1.21.10" as const, className: "a.b.C", classNameMapping: "obfuscated" as const };

    // Page 1 (the non-ambiguous class row): ambiguity is NOT reported for rows the caller cannot see.
    const page1 = await withCwd(root, () => service.getClassApiMatrix({ ...query, maxRows: 1 }));
    assert.equal(page1.rowCount, 2, "rowCount stays the full deduped count");
    assert.equal(page1.ambiguousRowCount, undefined);
    assert.equal(page1.warnings.filter((w) => w.includes("competing=")).length, 0);
    assert.ok(page1.nextCursor);

    // Page 2 (the ambiguous method row): now the page-scoped ambiguity surfaces.
    const page2 = await withCwd(root, () => service.getClassApiMatrix({ ...query, maxRows: 1, cursor: page1.nextCursor }));
    assert.equal(page2.ambiguousRowCount, 1);
    assert.ok(page2.warnings.filter((w) => w.includes("competing=")).length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
