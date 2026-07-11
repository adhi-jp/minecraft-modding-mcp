import assert from "node:assert/strict";
import test from "node:test";

import { AnalyzeSymbolService, analyzeSymbolSchema } from "../src/entry-tools/analyze-symbol-service.ts";

const throwingAnalyzeDeps = () => ({
  checkSymbolExists: async () => { throw new Error("not used"); },
  findMapping: async () => { throw new Error("not used"); },
  resolveMethodMappingExact: async () => { throw new Error("not used"); },
  traceSymbolLifecycle: async () => { throw new Error("not used"); },
  resolveWorkspaceSymbol: async () => { throw new Error("not used"); },
  getClassApiMatrix: async () => { throw new Error("not used"); }
});

const resolvedMapOutput = () => ({
  status: "resolved" as const,
  resolved: true,
  candidateCount: 1,
  candidatesTruncated: false,
  querySymbol: { kind: "method", name: "copy" },
  resolvedSymbol: { kind: "method", name: "copy" },
  mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", targetMapping: "mojang" },
  candidates: [{ kind: "method", symbol: { kind: "method", name: "copy" }, name: "copy", matchKind: "exact", confidence: 1 }],
  warnings: [] as string[]
});

const existsOutput = (kind: string, name: string) => ({
  status: "not_found" as const,
  resolved: false,
  candidateCount: 0,
  candidatesTruncated: false,
  querySymbol: { kind, name },
  resolvedSymbol: undefined,
  mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", targetMapping: "obfuscated" },
  candidates: [],
  warnings: [] as string[]
});

test("AnalyzeSymbolService returns matrix rows only when include=matrix is requested", async () => {
  const service = new AnalyzeSymbolService({
    checkSymbolExists: async () => {
      throw new Error("not used");
    },
    findMapping: async () => {
      throw new Error("not used");
    },
    resolveMethodMappingExact: async () => {
      throw new Error("not used");
    },
    traceSymbolLifecycle: async () => {
      throw new Error("not used");
    },
    resolveWorkspaceSymbol: async () => {
      throw new Error("not used");
    },
    getClassApiMatrix: async () => ({
      version: "1.21.10",
      className: "net.minecraft.world.level.block.Blocks",
      classNameMapping: "mojang",
      classIdentity: { mojang: "net.minecraft.world.level.block.Blocks" },
      rowCount: 2,
      rowsTruncated: false,
      ambiguousRowCount: 0,
      warnings: [],
      rows: [
        {
          kind: "field",
          mojang: {
            symbol: "net.minecraft.world.level.block.Blocks.AIR",
            owner: "net.minecraft.world.level.block.Blocks",
            name: "AIR"
          }
        }
      ]
    })
  });

  const summaryOnly = await service.execute({
    task: "api-overview",
    detail: "summary",
    subject: {
      kind: "class",
      name: "net.minecraft.world.level.block.Blocks"
    },
    version: "1.21.10",
    classNameMapping: "mojang"
  });
  assert.equal(summaryOnly.summary.status, "ok");
  assert.equal("matrix" in summaryOnly, false);

  const withMatrix = await service.execute({
    task: "api-overview",
    detail: "standard",
    include: ["matrix"],
    subject: {
      kind: "class",
      name: "net.minecraft.world.level.block.Blocks"
    },
    version: "1.21.10",
    classNameMapping: "mojang"
  });
  assert.equal(withMatrix.matrix?.rowCount, 2);
  assert.equal(withMatrix.matrix?.rows?.length, 1);
});

test("AnalyzeSymbolService api-overview inherits sourceMapping when classNameMapping is omitted", async () => {
  let seenClassNameMapping: "obfuscated" | "mojang" | "intermediary" | "yarn" | undefined;

  const service = new AnalyzeSymbolService({
    checkSymbolExists: async () => {
      throw new Error("not used");
    },
    findMapping: async () => {
      throw new Error("not used");
    },
    resolveMethodMappingExact: async () => {
      throw new Error("not used");
    },
    traceSymbolLifecycle: async () => {
      throw new Error("not used");
    },
    resolveWorkspaceSymbol: async () => {
      throw new Error("not used");
    },
    getClassApiMatrix: async (input) => {
      seenClassNameMapping = input.classNameMapping;
      return {
        version: "1.21.10",
        className: "net.minecraft.world.item.Item",
        classNameMapping: input.classNameMapping,
        classIdentity: { mojang: "net.minecraft.world.item.Item" },
        rowCount: 1,
        rowsTruncated: false,
        ambiguousRowCount: 0,
        warnings: [],
        rows: []
      };
    }
  });

  const result = await service.execute({
    task: "api-overview",
    detail: "summary",
    subject: {
      kind: "class",
      name: "net.minecraft.world.item.Item"
    },
    version: "1.21.10",
    sourceMapping: "mojang"
  });

  assert.equal(seenClassNameMapping, "mojang");
  assert.equal(result.summary.subject.classNameMapping, "mojang");
});

test("AnalyzeSymbolService lifecycle scopes traceSymbolLifecycle to the requested version", async () => {
  let seenInput:
    | {
        symbol: string;
        descriptor?: string;
        mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
        fromVersion?: string;
        toVersion?: string;
        maxVersions?: number;
        includeSnapshots?: boolean;
        includeTimeline?: boolean;
      }
    | undefined;

  const service = new AnalyzeSymbolService({
    checkSymbolExists: async () => {
      throw new Error("not used");
    },
    findMapping: async () => {
      throw new Error("not used");
    },
    resolveMethodMappingExact: async () => {
      throw new Error("not used");
    },
    traceSymbolLifecycle: async (input) => {
      seenInput = input as typeof input & { toVersion?: string };
      return {
        query: {
          className: "net.minecraft.world.item.Item",
          methodName: "use",
          descriptor: "(Lnet/minecraft/world/item/ItemStack;)V",
          mapping: "mojang"
        },
        range: {
          fromVersion: "1.21.10",
          toVersion: "1.21.10",
          scannedCount: 1
        },
        presence: {
          firstSeen: "1.21.10",
          lastSeen: "1.21.10",
          missingBetween: [],
          existsNow: true
        },
        warnings: []
      };
    },
    resolveWorkspaceSymbol: async () => {
      throw new Error("not used");
    },
    getClassApiMatrix: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "lifecycle",
    detail: "summary",
    version: "1.21.10",
    sourceMapping: "mojang",
    subject: {
      kind: "method",
      owner: "net.minecraft.world.item.Item",
      name: "use",
      descriptor: "(Lnet/minecraft/world/item/ItemStack;)V"
    }
  });

  // version is forwarded as the toVersion back-compat alias; maxVersions is no longer
  // forced to 5 (the service applies its own 120 default / 400 clamp).
  assert.deepEqual(seenInput, {
    symbol: "net.minecraft.world.item.Item.use",
    descriptor: "(Lnet/minecraft/world/item/ItemStack;)V",
    mapping: "mojang",
    toVersion: "1.21.10"
  });
  assert.equal(result.summary.status, "ok");
});

test("AnalyzeSymbolService lifecycle forwards fromVersion/toVersion/maxVersions/includeTimeline range controls", async () => {
  let seenInput: Record<string, unknown> | undefined;
  const service = new AnalyzeSymbolService({
    checkSymbolExists: async () => { throw new Error("not used"); },
    findMapping: async () => { throw new Error("not used"); },
    resolveMethodMappingExact: async () => { throw new Error("not used"); },
    traceSymbolLifecycle: async (input) => {
      seenInput = input as Record<string, unknown>;
      return {
        query: { className: "net.minecraft.world.item.Item", methodName: "use", mapping: "mojang" },
        range: { fromVersion: "1.20", toVersion: "1.21.10", scannedCount: 8 },
        presence: { firstSeen: "1.20", lastSeen: "1.21.10", missingBetween: [], existsNow: true },
        warnings: []
      };
    },
    resolveWorkspaceSymbol: async () => { throw new Error("not used"); },
    getClassApiMatrix: async () => { throw new Error("not used"); }
  });

  await service.execute({
    task: "lifecycle",
    detail: "summary",
    sourceMapping: "mojang",
    fromVersion: "1.20",
    toVersion: "1.21.10",
    maxVersions: 200,
    includeTimeline: true,
    subject: { kind: "method", owner: "net.minecraft.world.item.Item", name: "use" }
  });

  assert.equal(seenInput?.fromVersion, "1.20");
  assert.equal(seenInput?.toVersion, "1.21.10");
  assert.equal(seenInput?.maxVersions, 200, "maxVersions must be forwarded, not forced to 5");
  assert.equal(seenInput?.includeTimeline, true);
});

test("analyzeSymbolSchema rejects lifecycle-only range fields on non-lifecycle tasks", () => {
  for (const field of ["fromVersion", "toVersion", "maxVersions", "includeTimeline", "includeSnapshots"] as const) {
    const value = field === "maxVersions" ? 5 : field.startsWith("include") ? true : "1.21.10";
    const parsed = analyzeSymbolSchema.safeParse({
      task: "exists",
      version: "1.21.10",
      subject: { kind: "class", name: "net.minecraft.server.Main" },
      [field]: value
    });
    assert.equal(parsed.success, false, `${field} must be rejected on task=exists`);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.path[0] === field), `issue path should name ${field}`);
    }
  }
});

test("analyzeSymbolSchema accepts a toVersion-only lifecycle request without version", () => {
  const parsed = analyzeSymbolSchema.safeParse({
    task: "lifecycle",
    toVersion: "1.21.10",
    subject: { kind: "method", owner: "net.minecraft.world.item.Item", name: "use" }
  });
  assert.equal(parsed.success, true);
  // And a lifecycle request with neither version nor toVersion is rejected (end anchor required).
  const missing = analyzeSymbolSchema.safeParse({
    task: "lifecycle",
    subject: { kind: "method", owner: "net.minecraft.world.item.Item", name: "use" }
  });
  assert.equal(missing.success, false);
});

test("AnalyzeSymbolService includes summary.subject for mapping flows", async () => {
  const service = new AnalyzeSymbolService({
    checkSymbolExists: async () => {
      throw new Error("not used");
    },
    findMapping: async () => ({
      status: "resolved",
      resolved: true,
      candidateCount: 1,
      candidatesTruncated: false,
      querySymbol: {
        kind: "class",
        name: "net.minecraft.world.item.ItemStack"
      },
      resolvedSymbol: {
        kind: "class",
        name: "net.minecraft.world.item.ItemStack"
      },
      mappingContext: {
        version: "1.21.10",
        sourceMapping: "obfuscated",
        targetMapping: "mojang"
      },
      candidates: [],
      warnings: []
    }),
    resolveMethodMappingExact: async () => {
      throw new Error("not used");
    },
    traceSymbolLifecycle: async () => {
      throw new Error("not used");
    },
    resolveWorkspaceSymbol: async () => {
      throw new Error("not used");
    },
    getClassApiMatrix: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "map",
    detail: "summary",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    targetMapping: "mojang",
    subject: {
      kind: "class",
      name: "net.minecraft.world.item.ItemStack"
    }
  });

  assert.deepEqual(result.summary.subject, {
    task: "map",
    kind: "class",
    name: "net.minecraft.world.item.ItemStack",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    targetMapping: "mojang"
  });
});

test("AnalyzeSymbolService omits the redundant lone exact candidate on a resolved map", async () => {
  const service = new AnalyzeSymbolService({
    ...throwingAnalyzeDeps(),
    findMapping: async () => ({
      status: "resolved",
      resolved: true,
      candidateCount: 1,
      candidatesTruncated: false,
      querySymbol: { kind: "class", name: "a.A" },
      resolvedSymbol: { kind: "class", name: "b.B" },
      mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", targetMapping: "mojang" },
      candidates: [{ kind: "class", symbol: { kind: "class", name: "b.B" }, name: "b.B", matchKind: "exact", confidence: 1 }],
      warnings: []
    })
  } as never);

  const result = await service.execute({
    task: "map",
    detail: "standard",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    targetMapping: "mojang",
    subject: { kind: "class", name: "a.A" }
  });

  assert.deepEqual(result.match, { kind: "class", name: "b.B" });
  // The lone exact candidate duplicates `match`, so it is suppressed.
  assert.equal((result as { candidates?: unknown }).candidates, undefined);
});

test("AnalyzeSymbolService slims the unresolved candidate tail and flags candidateDetailsTruncated", async () => {
  const candidate = (n: string) => ({
    kind: "method",
    symbol: { kind: "method", name: n },
    owner: "o",
    name: n,
    descriptor: "()V",
    confidence: 0.5,
    matchKind: "heuristic",
    provenance: { foo: "bar" },
    ambiguityReasons: ["x"]
  });
  const service = new AnalyzeSymbolService({
    ...throwingAnalyzeDeps(),
    findMapping: async () => ({
      status: "ambiguous",
      resolved: false,
      candidateCount: 5,
      candidatesTruncated: false,
      querySymbol: { kind: "method", name: "m" },
      resolvedSymbol: undefined,
      mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", targetMapping: "mojang" },
      candidates: [candidate("c0"), candidate("c1"), candidate("c2"), candidate("c3"), candidate("c4")],
      warnings: []
    })
  } as never);

  const result = await service.execute({
    task: "map",
    detail: "full",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    targetMapping: "mojang",
    subject: { kind: "method", name: "m" }
  });

  const cands = (result as { candidates?: Array<Record<string, unknown>> }).candidates!;
  assert.equal(cands.length, 5);
  // Head keeps full metadata; tail (index >= 3) is slimmed (provenance dropped).
  assert.deepEqual(cands[0]!.provenance, { foo: "bar" });
  assert.equal(cands[4]!.provenance, undefined);
  assert.equal(cands[4]!.name, "c4");
  assert.equal((result as { candidateDetailsTruncated?: boolean }).candidateDetailsTruncated, true);
});

test("AnalyzeSymbolService keeps candidates for an exists query that did not resolve", async () => {
  const service = new AnalyzeSymbolService({
    ...throwingAnalyzeDeps(),
    checkSymbolExists: async () => ({
      status: "not_found",
      resolved: false,
      candidateCount: 1,
      candidatesTruncated: false,
      querySymbol: { kind: "class", name: "a.A" },
      resolvedSymbol: undefined,
      mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", targetMapping: "obfuscated" },
      candidates: [{ kind: "class", symbol: { kind: "class", name: "a.A" }, name: "a.A", matchKind: "exact", confidence: 1 }],
      warnings: []
    })
  } as never);

  const result = await service.execute({
    task: "exists",
    detail: "standard",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    subject: { kind: "class", name: "a.A" }
  });

  // No resolvedSymbol => the resolved-exact suppression must NOT fire.
  assert.equal((result as { candidates?: unknown[] }).candidates?.length, 1);
});

test("AnalyzeSymbolService task=map kind=symbol with owner+descriptor auto-detects method and warns", async () => {
  let seenKind: string | undefined;
  const service = new AnalyzeSymbolService({
    ...throwingAnalyzeDeps(),
    findMapping: async (input: { kind?: string }) => {
      seenKind = input.kind;
      return resolvedMapOutput();
    }
  } as never);

  const result = await service.execute({
    task: "map",
    detail: "standard",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    targetMapping: "mojang",
    subject: { kind: "symbol", name: "copy", owner: "net.minecraft.world.item.ItemStack", descriptor: "()Lnet/minecraft/world/item/ItemStack;" }
  });

  assert.equal(seenKind, "method", "owner+descriptor must infer method (not coerced to class)");
  assert.equal((result.summary as { subject?: { kind?: string } }).subject?.kind, "method");
  assert.ok((result.warnings ?? []).some((w) => /auto-detected as "method"/.test(w)));
});

test("AnalyzeSymbolService task=exists kind=symbol with owner only auto-detects field", async () => {
  let seenKind: string | undefined;
  const service = new AnalyzeSymbolService({
    ...throwingAnalyzeDeps(),
    checkSymbolExists: async (input: { kind?: string }) => {
      seenKind = input.kind;
      return existsOutput("field", "count");
    }
  } as never);

  const result = await service.execute({
    task: "exists",
    detail: "standard",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    subject: { kind: "symbol", name: "count", owner: "a.A" }
  });

  assert.equal(seenKind, "field");
  assert.equal((result.summary as { subject?: { kind?: string } }).subject?.kind, "field");
  assert.ok((result.warnings ?? []).some((w) => /auto-detected as "field"/.test(w)));
});

test("AnalyzeSymbolService task=exists kind=symbol with no owner auto-detects class", async () => {
  let seenKind: string | undefined;
  const service = new AnalyzeSymbolService({
    ...throwingAnalyzeDeps(),
    checkSymbolExists: async (input: { kind?: string }) => {
      seenKind = input.kind;
      return existsOutput("class", "a.A");
    }
  } as never);

  const result = await service.execute({
    task: "exists",
    detail: "standard",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    subject: { kind: "symbol", name: "a.A" }
  });

  assert.equal(seenKind, "class");
  assert.equal((result.summary as { subject?: { kind?: string } }).subject?.kind, "class");
  assert.ok((result.warnings ?? []).some((w) => /auto-detected as "class"/.test(w)));
});

test("analyzeSymbolSchema accepts kind=symbol for task=api-overview (infers class)", () => {
  const parsed = analyzeSymbolSchema.safeParse({
    task: "api-overview",
    version: "1.21.10",
    subject: { kind: "symbol", name: "net.minecraft.world.item.ItemStack" }
  });
  assert.equal(parsed.success, true, "kind=symbol must no longer be parse-rejected for api-overview");
});

test("analyzeSymbolSchema requires version for task=workspace", () => {
  // With a projectPath, an omitted version is now inferred from the
  // workspace at execution time instead of being rejected at schema time.
  const inferable = analyzeSymbolSchema.safeParse({
    task: "workspace",
    projectPath: "/workspace/demo-mod",
    subject: { kind: "class", name: "net.minecraft.world.item.ItemStack" }
  });
  assert.equal(inferable.success, true, "projectPath allows version inference");

  const missing = analyzeSymbolSchema.safeParse({
    task: "workspace",
    subject: { kind: "class", name: "net.minecraft.world.item.ItemStack" }
  });
  assert.equal(missing.success, false, "no version and no projectPath must be rejected");
  if (!missing.success) {
    assert.ok(missing.error.issues.some((i) => i.path[0] === "version"), "issue path should name version");
  }
  const withVersion = analyzeSymbolSchema.safeParse({
    task: "workspace",
    version: "1.21.10",
    projectPath: "/workspace/demo-mod",
    subject: { kind: "class", name: "net.minecraft.world.item.ItemStack" }
  });
  assert.equal(withVersion.success, true, "task=workspace with version must be accepted");
});

test("AnalyzeSymbolService explicit kind=class emits no inference warning", async () => {
  const service = new AnalyzeSymbolService({
    ...throwingAnalyzeDeps(),
    findMapping: async () => resolvedMapOutput()
  } as never);

  const result = await service.execute({
    task: "map",
    detail: "standard",
    version: "1.21.10",
    sourceMapping: "obfuscated",
    targetMapping: "mojang",
    subject: { kind: "class", name: "a.A" }
  });

  assert.ok(!(result.warnings ?? []).some((w) => /auto-detected/.test(w)), "explicit kinds must not warn");
});
