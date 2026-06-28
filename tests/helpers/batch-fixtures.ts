import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  GetClassMembersOutput,
  GetClassSourceOutput,
  ResolveArtifactOutput
} from "../../src/source-service.ts";

/**
 * Shared `resolveArtifact` fixture for the batch-tool service tests. Without a
 * `workspace` argument it resolves a version-targeted artifact (`version`
 * present); pass `{ minecraftVersion }` to model a workspace resolution whose
 * Minecraft version is only recoverable from `provenance.workspaceResolution`.
 */
export function buildResolved(workspace?: { minecraftVersion: string }): ResolveArtifactOutput {
  return {
    artifactId: "art-shared",
    artifactAlias: "art-shared-alias",
    origin: "local-jar",
    isDecompiled: false,
    version: workspace ? undefined : "1.21.10",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    provenance: {
      target: workspace
        ? ({ kind: "workspace" } as unknown as never)
        : { kind: "version", value: "1.21.10" },
      resolvedAt: "2026-01-01T00:00:00Z",
      resolvedFrom: { origin: "local-jar" },
      transformChain: [],
      ...(workspace
        ? {
            workspaceResolution: {
              projectPath: "/tmp/proj",
              detected: { minecraftVersion: workspace.minecraftVersion },
              source: "test",
              cacheHit: false
            }
          }
        : {})
    },
    qualityFlags: [],
    artifactContents: {
      sourceKind: "source-jar",
      indexedContentKinds: ["source"],
      resourcesIncluded: false,
      sourceCoverage: "full"
    },
    warnings: []
  };
}

export function buildOkMembers(className: string): GetClassMembersOutput {
  return {
    className,
    members: { constructors: [], fields: [], methods: [] },
    counts: { constructors: 0, fields: 0, methods: 0, total: 0 },
    truncated: false,
    context: {} as unknown as GetClassMembersOutput["context"],
    origin: "local-jar",
    artifactId: "art-shared",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    returnedNamespace: "obfuscated",
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: "2026-01-01T00:00:00Z",
      resolvedFrom: { origin: "local-jar" },
      transformChain: []
    },
    qualityFlags: [],
    artifactContents: {
      sourceKind: "source-jar",
      indexedContentKinds: ["source"],
      resourcesIncluded: false,
      sourceCoverage: "full"
    },
    status: "available" as GetClassMembersOutput["status"],
    warnings: []
  };
}

export function buildOkSource(className: string): GetClassSourceOutput {
  return {
    className,
    mode: "metadata",
    sourceText: `class ${className} {}`,
    totalLines: 1,
    returnedRange: { start: 1, end: 1 },
    truncated: false,
    origin: "local-jar",
    artifactId: "art-shared",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    returnedNamespace: "obfuscated",
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: "2026-01-01T00:00:00Z",
      resolvedFrom: { origin: "local-jar" },
      transformChain: []
    },
    qualityFlags: ["ok"],
    artifactContents: {
      sourceKind: "source-jar",
      indexedContentKinds: ["source"],
      resourcesIncluded: false,
      sourceCoverage: "full"
    },
    warnings: ["fixture-warning"]
  };
}

export function buildOkExistence(input: CheckSymbolExistsInput): CheckSymbolExistsOutput {
  return {
    querySymbol: {
      kind: input.kind,
      symbol: input.name,
      owner: input.owner,
      name: input.name,
      descriptor: input.descriptor
    } as unknown as CheckSymbolExistsOutput["querySymbol"],
    mappingContext: {
      version: input.version,
      sourceMapping: input.sourceMapping,
      sourcePriorityApplied: "loom-first"
    },
    resolved: true,
    status: "resolved",
    candidates: [],
    candidateCount: 0,
    warnings: []
  };
}
