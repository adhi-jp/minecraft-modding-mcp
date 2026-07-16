import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import type { ResolveWorkspaceSymbolInput } from "../../src/source-service.ts";
import type { WorkspaceCompileMappingOutput } from "../../src/workspace-mapping-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

function expectInvalidInput(messagePattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof Error, "expected an Error instance");
    const appError = error as Error & { code?: string };
    assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
    assert.match(appError.message, messagePattern);
    return true;
  };
}

function injectDetection(service: unknown, detection: WorkspaceCompileMappingOutput): void {
  (service as { workspaceMappingService: unknown }).workspaceMappingService = {
    async detectCompileMapping() {
      return detection;
    }
  };
}

function injectMappingService(service: unknown, fake: Record<string, unknown>): void {
  (service as { mappingService: unknown }).mappingService = fake;
}

test("SourceService resolveWorkspaceSymbol validates input before any workspace detection", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  const root = await mkdtemp(join(tmpdir(), "workspace-symbol-guards-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { workspaceMappingService: unknown }).workspaceMappingService = {
    async detectCompileMapping(): Promise<never> {
      assert.fail("input validation must reject before workspace detection runs");
    }
  };

  const base = { projectPath: root, version: "1.21.10", sourceMapping: "obfuscated" as const };

  const guardCases: Array<{ name: string; input: ResolveWorkspaceSymbolInput; pattern: RegExp }> = [
    {
      name: "rejects a whitespace-only projectPath",
      input: { ...base, projectPath: "   ", kind: "class", name: "a.b.C" },
      pattern: /projectPath, version, and name must be non-empty strings/
    },
    {
      // kind=field without an owner would trip the owner guard, so getting the
      // non-empty-strings message proves the name check runs first.
      name: "rejects an empty name before kind-specific owner checks",
      input: { ...base, kind: "field", name: "" },
      pattern: /projectPath, version, and name must be non-empty strings/
    },
    {
      name: "rejects an unsupported symbol kind",
      input: { ...base, kind: "package" as never, name: "a.b" },
      pattern: /Unsupported symbol kind "package"/
    },
    {
      name: "rejects an owner when kind is class and points at name as the FQCN",
      input: { ...base, kind: "class", owner: "a.b", name: "a.b.C" },
      pattern: /owner is not allowed when kind=class\. Use name as FQCN/
    },
    {
      name: "rejects a descriptor when kind is class",
      input: { ...base, kind: "class", name: "a.b.C", descriptor: "(I)V" },
      pattern: /descriptor is not allowed when kind=class/
    },
    {
      name: "rejects a field lookup without an owner",
      input: { ...base, kind: "field", name: "someField" },
      pattern: /owner is required when kind is field or method/
    },
    {
      name: "rejects a descriptor on a field lookup",
      input: { ...base, kind: "field", owner: "a.b.C", name: "someField", descriptor: "I" },
      pattern: /descriptor is not allowed when kind=field/
    },
    {
      name: "rejects a method lookup without a descriptor",
      input: { ...base, kind: "method", owner: "a.b.C", name: "f" },
      pattern: /descriptor is required when kind=method/
    }
  ];

  for (const guardCase of guardCases) {
    await t.test(guardCase.name, async () => {
      await assert.rejects(
        () => service.resolveWorkspaceSymbol(guardCase.input),
        expectInvalidInput(guardCase.pattern)
      );
    });
  }

  await t.test("rejects a missing version and echoes the raw inputs in details", async () => {
    const input = {
      projectPath: root,
      kind: "class",
      name: "a.b.C",
      sourceMapping: "obfuscated"
    } as unknown as ResolveWorkspaceSymbolInput;

    await assert.rejects(
      () => service.resolveWorkspaceSymbol(input),
      (error: unknown) => {
        assert.ok(error instanceof Error, "expected an Error instance");
        const appError = error as Error & {
          code?: string;
          details?: { projectPath?: unknown; version?: unknown; name?: unknown };
        };
        assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
        assert.match(appError.message, /projectPath, version, and name must be non-empty strings/);
        assert.equal(appError.details?.projectPath, root);
        assert.equal(appError.details?.version, undefined);
        assert.equal(appError.details?.name, "a.b.C");
        return true;
      }
    );
  });
});

test("SourceService resolveWorkspaceSymbol routes by kind once a workspace mapping is known", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  async function createFixture(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = new SourceService(buildTestConfig(root));
    const base = { projectPath: root, version: "1.21.10", sourceMapping: "obfuscated" as const };
    return { root, service, base };
  }

  await t.test("returns mapping_unavailable when workspace mapping cannot be detected", async () => {
    const { service, base } = await createFixture("workspace-symbol-mapping-unavailable-");
    injectDetection(service, { resolved: false, evidence: [], warnings: ["No Gradle mapping evidence found."] });
    injectMappingService(service, {
      async getClassApiMatrix(): Promise<never> {
        assert.fail("class matrix lookup must not run without an applied workspace mapping");
      }
    });

    const result = await service.resolveWorkspaceSymbol({
      ...base,
      kind: "class",
      name: "net/minecraft/client/Minecraft"
    });

    assert.equal(result.resolved, false);
    assert.equal(result.status, "mapping_unavailable");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.candidateCount, 0);
    assert.deepEqual(result.warnings, ["No Gradle mapping evidence found."]);
    assert.equal(result.workspaceDetection.resolved, false);
    // Slash-separated class names are normalized to dotted form in the query echo.
    assert.deepEqual(result.querySymbol, {
      kind: "class",
      name: "net.minecraft.client.Minecraft",
      symbol: "net.minecraft.client.Minecraft"
    });
    // With no explicit sourcePriority the config default applies.
    assert.equal(result.mappingContext.sourcePriorityApplied, "loom-first");
    assert.equal(result.mappingContext.targetMapping, undefined);
  });

  await t.test("returns mapping_unavailable when detection resolves without an applied mapping", async () => {
    const { root, service, base } = await createFixture("workspace-symbol-no-applied-mapping-");
    injectDetection(service, {
      resolved: true,
      mappingApplied: undefined,
      evidence: [{ filePath: join(root, "build.gradle"), mapping: "mojang", reason: "ambiguous" }],
      warnings: []
    });
    injectMappingService(service, {
      async findMapping(): Promise<never> {
        assert.fail("field lookup must not delegate to findMapping without an applied mapping");
      }
    });

    const result = await service.resolveWorkspaceSymbol({
      ...base,
      kind: "field",
      owner: "a/b/C",
      name: "x",
      sourcePriority: "maven-first"
    });

    assert.equal(result.resolved, false);
    assert.equal(result.status, "mapping_unavailable");
    // The explicit input priority wins over the config default.
    assert.equal(result.mappingContext.sourcePriorityApplied, "maven-first");
    // A slash-form owner is normalized to dots in the locally built querySymbol.
    assert.equal(result.querySymbol.symbol, "a.b.C.x");
    assert.equal(result.querySymbol.owner, "a.b.C");
    assert.equal(result.querySymbol.descriptor, undefined);
  });

  await t.test("merges workspace detection warnings ahead of exact method mapping warnings", async () => {
    const { root, service, base } = await createFixture("workspace-symbol-method-delegation-");
    injectDetection(service, { resolved: true, mappingApplied: "mojang", evidence: [], warnings: ["workspace warning"] });

    let recorded: Record<string, unknown> | undefined;
    const exactCandidate = {
      kind: "method" as const,
      owner: "com.example.ValueOutput",
      name: "remove",
      descriptor: "(I)V",
      symbol: "com.example.ValueOutput.remove(I)V",
      matchKind: "exact" as const,
      confidence: 1
    };
    injectMappingService(service, {
      async resolveMethodMappingExact(input: Record<string, unknown>) {
        recorded = input;
        return {
          querySymbol: { kind: "method", owner: "a.b.C", name: "f", descriptor: "(I)V", symbol: "a.b.C.f(I)V" },
          mappingContext: {
            version: "1.21.10",
            sourceMapping: "obfuscated",
            targetMapping: "mojang",
            sourcePriorityApplied: "loom-first"
          },
          resolved: true,
          status: "resolved",
          resolvedSymbol: exactCandidate,
          candidates: [exactCandidate],
          candidateCount: 1,
          warnings: ["exact warning"]
        };
      }
    });

    const result = await service.resolveWorkspaceSymbol({
      ...base,
      kind: "method",
      owner: "a/b/C",
      name: "f",
      descriptor: "(I)V",
      maxCandidates: 3,
      gradleUserHome: join(root, "gh")
    });

    assert.ok(recorded, "expected resolveMethodMappingExact to be invoked");
    // The owner is handed through unnormalized; the delegate owns normalization.
    assert.equal(recorded.owner, "a/b/C");
    assert.equal(recorded.version, "1.21.10");
    assert.equal(recorded.descriptor, "(I)V");
    assert.equal(recorded.targetMapping, "mojang");
    assert.equal(recorded.sourcePriority, undefined);
    assert.equal(recorded.gradleUserHome, join(root, "gh"));
    assert.equal(recorded.maxCandidates, 3);

    assert.equal(result.status, "resolved");
    assert.deepEqual(result.warnings, ["workspace warning", "exact warning"]);
    assert.equal(result.workspaceDetection.mappingApplied, "mojang");
  });

  await t.test("returns not_found when the class identity lacks the workspace mapping", async () => {
    const { service, base } = await createFixture("workspace-symbol-class-not-found-");
    injectDetection(service, { resolved: true, mappingApplied: "mojang", evidence: [], warnings: ["workspace warning"] });

    let recorded: Record<string, unknown> | undefined;
    injectMappingService(service, {
      async getClassApiMatrix(input: Record<string, unknown>) {
        recorded = input;
        return { classIdentity: { obfuscated: "a.b.c" }, rows: [], warnings: ["matrix warning"] };
      }
    });

    const result = await service.resolveWorkspaceSymbol({ ...base, kind: "class", name: "a/b/c" });

    assert.ok(recorded, "expected getClassApiMatrix to be invoked");
    assert.equal(recorded.className, "a.b.c");
    assert.equal(recorded.classNameMapping, "obfuscated");
    assert.deepEqual(recorded.includeKinds, ["class"]);

    assert.equal(result.resolved, false);
    assert.equal(result.status, "not_found");
    assert.equal(result.resolvedSymbol, undefined);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.candidateCount, 0);
    assert.equal(result.mappingContext.targetMapping, "mojang");
    assert.deepEqual(result.warnings, ["workspace warning", "matrix warning"]);
  });

  await t.test("normalizes slashed class identities to dotted names in the resolved candidate", async () => {
    const { service, base } = await createFixture("workspace-symbol-class-resolved-");
    injectDetection(service, { resolved: true, mappingApplied: "mojang", evidence: [], warnings: [] });
    injectMappingService(service, {
      async getClassApiMatrix() {
        return { classIdentity: { mojang: "com/example/ValueOutput" }, rows: [], warnings: [] };
      }
    });

    const result = await service.resolveWorkspaceSymbol({ ...base, kind: "class", name: "a.b.c" });

    assert.equal(result.resolved, true);
    assert.equal(result.status, "resolved");
    assert.deepEqual(result.resolvedSymbol, {
      kind: "class",
      name: "com.example.ValueOutput",
      symbol: "com.example.ValueOutput"
    });
    assert.deepEqual(result.candidates, [
      {
        kind: "class",
        name: "com.example.ValueOutput",
        symbol: "com.example.ValueOutput",
        matchKind: "exact",
        confidence: 1
      }
    ]);
    assert.equal(result.candidateCount, 1);
  });
});

test("SourceService resolveWorkspaceSymbol derives field status from kind-filtered findMapping candidates", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  const fieldCandidate = {
    kind: "field" as const,
    owner: "a.b.C",
    name: "x",
    symbol: "a.b.C.x",
    matchKind: "exact" as const,
    confidence: 1
  };
  const methodCandidate = {
    kind: "method" as const,
    owner: "a.b.C",
    name: "x",
    descriptor: "()I",
    symbol: "a.b.C.x()I",
    matchKind: "exact" as const,
    confidence: 1
  };

  async function createFieldFixture(options: {
    prefix: string;
    detectionWarnings: string[];
    findMappingResult: {
      status: string;
      candidates: Array<typeof fieldCandidate | typeof methodCandidate>;
      candidateCount: number;
      candidatesTruncated?: boolean;
      warnings: string[];
    };
  }) {
    const root = await mkdtemp(join(tmpdir(), options.prefix));
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = new SourceService(buildTestConfig(root));

    injectDetection(service, {
      resolved: true,
      mappingApplied: "mojang",
      evidence: [],
      warnings: options.detectionWarnings
    });

    let recorded: Record<string, unknown> | undefined;
    injectMappingService(service, {
      async findMapping(input: Record<string, unknown>) {
        recorded = input;
        return {
          querySymbol: { kind: "field", name: "x", owner: "a.b.C", symbol: "a.b.C.x" },
          mappingContext: {
            version: "1.21.10",
            sourceMapping: "obfuscated",
            targetMapping: "mojang",
            sourcePriorityApplied: "loom-first"
          },
          resolved: options.findMappingResult.status === "resolved",
          ...options.findMappingResult
        };
      }
    });

    const resolveField = (extra: Partial<ResolveWorkspaceSymbolInput> = {}) =>
      service.resolveWorkspaceSymbol({
        projectPath: root,
        version: "1.21.10",
        kind: "field",
        owner: "a.b.C",
        name: "x",
        sourceMapping: "obfuscated",
        ...extra
      });

    return { resolveField, getRecorded: () => recorded };
  }

  await t.test("resolves a field and filters out non-field candidates from findMapping", async () => {
    const { resolveField, getRecorded } = await createFieldFixture({
      prefix: "workspace-symbol-field-resolved-",
      detectionWarnings: [],
      findMappingResult: {
        status: "resolved",
        candidates: [methodCandidate, fieldCandidate],
        candidateCount: 2,
        candidatesTruncated: false,
        warnings: ["map warning"]
      }
    });

    const result = await resolveField({
      sourcePriority: "maven-first",
      gradleUserHome: "/tmp/fake-gradle-home",
      maxCandidates: 7
    });

    const recorded = getRecorded();
    assert.ok(recorded, "expected findMapping to be invoked");
    assert.equal(recorded.kind, "field");
    assert.equal(recorded.name, "x");
    assert.equal(recorded.owner, "a.b.C");
    assert.equal(recorded.descriptor, undefined);
    assert.equal(recorded.targetMapping, "mojang");
    assert.equal(recorded.version, "1.21.10");
    assert.equal(recorded.sourceMapping, "obfuscated");
    assert.equal(recorded.sourcePriority, "maven-first");
    assert.equal(recorded.gradleUserHome, "/tmp/fake-gradle-home");
    assert.equal(recorded.maxCandidates, 7);

    assert.equal(result.resolved, true);
    assert.equal(result.status, "resolved");
    assert.deepEqual(result.candidates, [fieldCandidate]);
    assert.deepEqual(result.resolvedSymbol, fieldCandidate);
    // candidateCount echoes the pre-filter count from findMapping even though
    // candidates holds only the kind-filtered survivors.
    assert.equal(result.candidateCount, 2);
    assert.equal(result.candidatesTruncated, false);
    assert.deepEqual(result.warnings, ["map warning"]);
    assert.deepEqual(result.querySymbol, { kind: "field", name: "x", owner: "a.b.C", symbol: "a.b.C.x" });
  });

  await t.test("reports ambiguous when multiple field candidates remain after filtering", async () => {
    const { resolveField } = await createFieldFixture({
      prefix: "workspace-symbol-field-ambiguous-",
      detectionWarnings: [],
      findMappingResult: {
        status: "ambiguous",
        candidates: [fieldCandidate, { ...fieldCandidate, owner: "a.b.D", symbol: "a.b.D.x" }],
        candidateCount: 2,
        warnings: []
      }
    });

    const result = await resolveField();

    assert.equal(result.resolved, false);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.resolvedSymbol, undefined);
    assert.equal(result.candidates.length, 2);
  });

  await t.test("reports not_found when the kind filter removes every candidate", async () => {
    const { resolveField } = await createFieldFixture({
      prefix: "workspace-symbol-field-filtered-out-",
      detectionWarnings: [],
      findMappingResult: {
        // findMapping claims resolution, but its only candidate is a method:
        // the field filter drops it and the status is recomputed as not_found.
        status: "resolved",
        candidates: [methodCandidate],
        candidateCount: 1,
        warnings: []
      }
    });

    const result = await resolveField();

    assert.equal(result.resolved, false);
    assert.equal(result.status, "not_found");
    assert.equal(result.resolvedSymbol, undefined);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.candidateCount, 1);
  });

  await t.test("propagates mapping_unavailable from findMapping and prepends detection warnings", async () => {
    // A surviving field candidate proves mapping_unavailable takes precedence over
    // the filtered-candidate count when statuses are recomputed.
    const { resolveField } = await createFieldFixture({
      prefix: "workspace-symbol-field-mapping-unavailable-",
      detectionWarnings: ["workspace warning"],
      findMappingResult: {
        status: "mapping_unavailable",
        candidates: [fieldCandidate],
        candidateCount: 1,
        warnings: ["graph empty"]
      }
    });

    const result = await resolveField();

    assert.equal(result.resolved, false);
    assert.equal(result.status, "mapping_unavailable");
    assert.equal(result.resolvedSymbol, undefined);
    assert.deepEqual(result.candidates, [fieldCandidate]);
    assert.deepEqual(result.warnings, ["workspace warning", "graph empty"]);
  });
});
