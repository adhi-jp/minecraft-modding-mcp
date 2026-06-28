/**
 * Shared fixtures for seeding an indexed artifact directly into a SourceService's
 * SQLite-backed repos (bypassing real jar resolution) and for stubbing the
 * bytecode explorer. Factored from the duplicated copies in source-service.test.ts
 * and source-service-get-class-members-status.test.ts so both slices share one
 * definition.
 */

export type ArtifactSeed = {
  artifactId: string;
  origin: "local-jar" | "local-m2" | "remote-repo" | "decompiled";
  requestedMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
  mappingApplied: "obfuscated" | "mojang" | "intermediary" | "yarn";
  qualityFlags: string[];
  files: Array<{ filePath: string; content: string }>;
  symbols: Array<{
    filePath: string;
    symbolKind: string;
    symbolName: string;
    qualifiedName?: string;
    line: number;
  }>;
  version?: string;
  sourceJarPath?: string;
  binaryJarPath?: string;
  provenance?: Record<string, unknown>;
  isDecompiled?: boolean;
};

export function seedIndexedArtifact(service: unknown, input: ArtifactSeed): void {
  const repos = service as {
    artifactsRepo: {
      upsertArtifact: (value: {
        artifactId: string;
        origin: ArtifactSeed["origin"];
        requestedMapping: ArtifactSeed["requestedMapping"];
        mappingApplied: ArtifactSeed["mappingApplied"];
        qualityFlags: string[];
        artifactSignature: string;
        isDecompiled: boolean;
        timestamp: string;
        version?: string;
        sourceJarPath?: string;
        binaryJarPath?: string;
        provenance?: Record<string, unknown>;
      }) => void;
    };
    filesRepo: {
      insertFilesForArtifact: (
        artifactId: string,
        files: Array<{ filePath: string; content: string; contentBytes: number; contentHash: string }>
      ) => void;
    };
    symbolsRepo: {
      insertSymbolsForArtifact: (artifactId: string, symbols: ArtifactSeed["symbols"]) => void;
    };
  };
  const timestamp = new Date().toISOString();
  repos.artifactsRepo.upsertArtifact({
    artifactId: input.artifactId,
    origin: input.origin,
    version: input.version,
    sourceJarPath: input.sourceJarPath,
    binaryJarPath: input.binaryJarPath,
    requestedMapping: input.requestedMapping,
    mappingApplied: input.mappingApplied,
    provenance: input.provenance,
    qualityFlags: input.qualityFlags,
    artifactSignature: `${input.artifactId}-sig`,
    isDecompiled: input.isDecompiled ?? false,
    timestamp
  });
  repos.filesRepo.insertFilesForArtifact(
    input.artifactId,
    input.files.map((file) => ({
      filePath: file.filePath,
      content: file.content,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      contentHash: `${input.artifactId}:${file.filePath}`
    }))
  );
  repos.symbolsRepo.insertSymbolsForArtifact(input.artifactId, input.symbols);
}

export function stubExplorer(
  service: unknown,
  result: {
    constructors?: unknown[];
    fields?: unknown[];
    methods?: unknown[];
    throwError?: Error;
  }
): void {
  (service as { explorerService: unknown }).explorerService = {
    async getSignature() {
      if (result.throwError) {
        throw result.throwError;
      }
      return {
        constructors: result.constructors ?? [],
        fields: result.fields ?? [],
        methods: result.methods ?? [],
        warnings: [],
        context: {
          minecraftVersion: "1.21.10",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarHash: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };
}
