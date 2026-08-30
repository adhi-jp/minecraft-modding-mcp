import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES } from "../../../src/errors.ts";
import {
  BatchClassMembersService,
  type BatchClassMembersDeps,
  type BatchClassMembersInput
} from "../../../src/entry-tools/batch-class-members-service.ts";
import type { GetClassMembersInput } from "../../../src/source-service.ts";
import "../../../src/index.ts";
import { buildOkMembers, buildResolved } from "../../helpers/batch-fixtures.ts";

function buildDeps(opts: { failClass?: string; resolveCallSpy?: { count: number } }): BatchClassMembersDeps {
  return {
    resolveArtifact: async () => {
      if (opts.resolveCallSpy) opts.resolveCallSpy.count += 1;
      return buildResolved();
    },
    getClassMembers: async (input: GetClassMembersInput) => {
      if (opts.failClass && input.className === opts.failClass) {
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: `class not found: ${input.className}`
        });
      }
      return buildOkMembers(input.className);
    }
  };
}

const baseInput: Omit<BatchClassMembersInput, "entries"> = {
  target: { kind: "version", value: "1.21.10" }
};

test("E1: 3 valid entries return ok in input order", async () => {
  const service = new BatchClassMembersService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }, { className: "b.B" }, { className: "c.C" }]
  });
  assert.equal(out.summary.ok, 3);
  for (let i = 0; i < 3; i++) assert.equal(out.results[i]!.index, i);
});

test("E2: failing entry preserves underlying error code", async () => {
  const service = new BatchClassMembersService(buildDeps({ failClass: "b.B" }));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }, { className: "b.B" }, { className: "c.C" }]
  });
  assert.equal(out.summary.ok, 2);
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.CLASS_NOT_FOUND);
});

test("E7: per-entry retry suggestedCall validates against get-class-members schema", async () => {
  const { validateToolParams } = await import("../../../src/tool-schema-registry.ts");
  const service = new BatchClassMembersService(buildDeps({ failClass: "boom" }));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "boom", memberPattern: "tick" }]
  });
  const suggested = (out.results[0] as { error: { suggestedCall?: { tool: string; params: Record<string, unknown> } } }).error.suggestedCall;
  assert.ok(suggested);
  assert.equal(suggested!.tool, "get-class-members");
  assert.equal((suggested!.params.target as { artifactId: string }).artifactId, "art-shared");
  assert.equal(suggested!.params.memberPattern, "tick");
  assert.equal(validateToolParams(suggested!.tool, suggested!.params).valid, true);
});

test("E8: detail=summary strips provenance/artifactContents/qualityFlags/context", async () => {
  const service = new BatchClassMembersService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    detail: "summary",
    entries: [{ className: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.ok(!("provenance" in result));
  assert.ok(!("artifactContents" in result));
  assert.ok(!("qualityFlags" in result));
  assert.ok(!("context" in result));
  // Members payload survives even when empty (TOOL_PRESERVE_PAYLOAD_KEYS).
  assert.ok("members" in result);
  assert.ok("counts" in result);
});

test("per-entry status field from single-tool result is preserved", async () => {
  const service = new BatchClassMembersService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.equal(result.status, "available");
});

test("projection is threaded from batch input to each get-class-members call", async () => {
  const seen: Array<string | undefined> = [];
  const deps: BatchClassMembersDeps = {
    resolveArtifact: async () => buildResolved(),
    getClassMembers: async (input: GetClassMembersInput) => {
      seen.push(input.projection);
      return buildOkMembers(input.className);
    }
  };
  const service = new BatchClassMembersService(deps);
  await service.execute({
    ...baseInput,
    projection: "names",
    entries: [{ className: "a.A" }, { className: "b.B" }]
  });
  assert.deepEqual(seen, ["names", "names"]);
});

// batch-class-members resolves its SHARED target ONCE and then dispatches every
// entry by the resulting artifactId. Downstream, "the caller passed an
// artifactId" used to be read as "the caller named this artifact", so a shared
// artifact that turned out to carry no binary jar was reported as the caller's
// mistake -- once per entry -- even though this tool's target schema has no way
// to name an artifact at all. The two tests below pin both halves of the
// corrected attribution: a tool-resolved shared target is the tool's problem, a
// jar the caller named is still theirs.
async function buildNoBinaryDeps(): Promise<BatchClassMembersDeps> {
  const { SourceService } = await import("../../../src/source-service.ts");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildTestConfig } = await import("../../helpers/test-config.ts");
  const { seedIndexedArtifact } = await import("../../helpers/seed-artifact.ts");
  const { createJar } = await import("../../helpers/zip.ts");

  const root = await mkdtemp(join(tmpdir(), "batch-members-no-binary-"));
  const sourceJarPath = join(root, "source-only.jar");
  await createJar(sourceJarPath, {
    "com/example/Demo.java": "package com.example;\npublic class Demo {}"
  });

  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "shared-source-only-artifact",
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    sourceJarPath,
    files: [{ filePath: "com/example/Demo.java", content: "package com.example;\npublic class Demo {}" }],
    symbols: []
  });

  return {
    // The shared resolve is stubbed to hand back that binary-jar-less artifact;
    // the per-entry call below is the REAL get-class-members, so the issueOrigin
    // asserted here is the one a caller would actually receive.
    resolveArtifact: async () =>
      ({ artifactId: "shared-source-only-artifact", warnings: [] }) as unknown as Awaited<
        ReturnType<BatchClassMembersDeps["resolveArtifact"]>
      >,
    getClassMembers: (input) =>
      (service as unknown as BatchClassMembersDeps).getClassMembers(input)
  };
}

test("batch-class-members reports a tool issue when the shared target resolved an artifact with no binary jar", async () => {
  const service = new BatchClassMembersService(await buildNoBinaryDeps());
  const out = await service.execute({
    target: { kind: "version", value: "1.21.10" },
    entries: [{ className: "com.example.Demo" }, { className: "com.example.Other" }]
  });

  assert.equal(out.summary.error, 2);
  for (const entry of out.results) {
    const error = (entry as { error: { code: string; issueOrigin: string } }).error;
    assert.equal(error.code, ERROR_CODES.CONTEXT_UNRESOLVED);
    assert.equal(
      error.issueOrigin,
      "tool_issue",
      "the batch target cannot name an artifact, so the caller has no input to fix here"
    );
  }
});

test("batch-class-members keeps a code issue when the caller named the jar target itself", async () => {
  const service = new BatchClassMembersService(await buildNoBinaryDeps());
  const out = await service.execute({
    target: { kind: "jar", value: "/nonexistent/named-by-caller.jar" },
    entries: [{ className: "com.example.Demo" }]
  });

  const error = (out.results[0] as { error: { code: string; issueOrigin: string } }).error;
  assert.equal(error.code, ERROR_CODES.CONTEXT_UNRESOLVED);
  assert.equal(
    error.issueOrigin,
    "code_issue",
    "a jar the caller named themselves stays their input to fix"
  );
});
