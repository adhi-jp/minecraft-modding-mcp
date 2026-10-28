import assert from "node:assert/strict";
import test from "node:test";

import { InspectMinecraftService } from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

const ARTIFACT_ID = "artifact-files-page";
const CURSOR = "cursor-after-page-1";

function pagePaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `net/example/File${index + 1}.java`);
}

function buildService(page: { items: string[]; nextCursor?: string }) {
  return new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input: { target: { kind: string; value?: string }; mapping?: string }) => ({
      artifactId: ARTIFACT_ID,
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: input.mapping,
      mappingApplied: input.mapping ?? "obfuscated",
      version: "1.21.10",
      provenance: { requestedTarget: input.target },
      qualityFlags: [],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "full"
      },
      warnings: []
    }),
    listArtifactFiles: async () => ({
      items: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      mappingApplied: "mojang",
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "full"
      },
      warnings: []
    }),
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));
}

function listFiles(
  service: InspectMinecraftService,
  options: { detail: "summary" | "standard" | "full"; include?: string[] }
) {
  return service.execute({
    task: "list-files",
    detail: options.detail,
    ...(options.include ? { include: options.include } : {}),
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true
    }
  } as never) as Promise<{
    summary: Record<string, unknown>;
    files?: { items: string[]; nextCursor?: string };
    meta?: { pagination?: Record<string, unknown> };
  }>;
}

test("list-files at summary without include omits the files block but reports continuation in meta.pagination", async () => {
  const paths = pagePaths(12);
  const result = await listFiles(buildService({ items: paths, nextCursor: CURSOR }), { detail: "summary" });

  assert.equal(result.files, undefined);
  assert.deepEqual(result.meta?.pagination, { returnedCount: 10, hasMore: true, nextCursor: CURSOR });
});

test("list-files at summary with include files returns the first ten paths and the same pagination", async () => {
  const paths = pagePaths(12);
  const result = await listFiles(buildService({ items: paths, nextCursor: CURSOR }), {
    detail: "summary",
    include: ["files"]
  });

  assert.deepEqual(result.files?.items, paths.slice(0, 10));
  assert.equal(result.files?.nextCursor, CURSOR);
  assert.deepEqual(result.meta?.pagination, { returnedCount: 10, hasMore: true, nextCursor: CURSOR });
});

test("list-files at standard and full returns the whole fetched page and counts it in meta.pagination", async () => {
  const paths = pagePaths(12);
  for (const detail of ["standard", "full"] as const) {
    const result = await listFiles(buildService({ items: paths, nextCursor: CURSOR }), { detail });

    assert.deepEqual(result.files?.items, paths, detail);
    assert.deepEqual(result.meta?.pagination, { returnedCount: 12, hasMore: true, nextCursor: CURSOR }, detail);
  }
});

test("list-files takes hasMore from the listing cursor, not from sampling", async () => {
  const uncursored = buildService({ items: pagePaths(12) });
  assert.deepEqual((await listFiles(uncursored, { detail: "summary" })).meta?.pagination, {
    returnedCount: 10,
    hasMore: false
  });
  assert.deepEqual((await listFiles(uncursored, { detail: "full" })).meta?.pagination, {
    returnedCount: 12,
    hasMore: false
  });

  const fullTenPage = buildService({ items: pagePaths(10), nextCursor: CURSOR });
  for (const detail of ["summary", "full"] as const) {
    assert.deepEqual((await listFiles(fullTenPage, { detail })).meta?.pagination, {
      returnedCount: 10,
      hasMore: true,
      nextCursor: CURSOR
    }, detail);
  }
});

test("list-files on a last page reports hasMore false and no nextCursor key", async () => {
  const paths = pagePaths(4);
  for (const detail of ["summary", "standard", "full"] as const) {
    const result = await listFiles(buildService({ items: paths }), { detail });
    assert.deepEqual(result.meta?.pagination, { returnedCount: 4, hasMore: false }, detail);
    assert.equal("nextCursor" in (result.meta?.pagination ?? {}), false, detail);
  }
});

test("list-files keeps its headline, file count and next action when pagination is reported", async () => {
  const paths = pagePaths(12);
  const result = await listFiles(buildService({ items: paths, nextCursor: CURSOR }), { detail: "summary" });

  assert.equal(result.summary.status, "ok");
  assert.equal(result.summary.headline, `Listed 12 files for ${ARTIFACT_ID}.`);
  assert.deepEqual(result.summary.counts, { files: 12 });
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "inspect-minecraft",
      params: {
        task: "file",
        subject: {
          kind: "file",
          filePath: "net/example/File1.java",
          artifact: { type: "resolved-id", artifactId: ARTIFACT_ID }
        }
      }
    }
  ]);
});
