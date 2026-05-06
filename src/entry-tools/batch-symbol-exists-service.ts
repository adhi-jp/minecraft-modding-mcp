import { buildSuggestedCall } from "../build-suggested-call.js";
import { createError, ERROR_CODES } from "../errors.js";
import {
  compactResponse,
  compactMappingResponse
} from "../response-utils.js";
import type { SuggestedCall } from "../error-mapping.js";
import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  ResolveArtifactInput,
  ResolveArtifactOutput
} from "../source-service.js";
import type {
  ArtifactScope,
  MappingSourcePriority,
  SourceMapping,
  WorkspaceTargetInput,
  SourceTargetInput
} from "../types.js";

export type BatchSymbolExistsDeps = {
  resolveArtifact: (input: ResolveArtifactInput) => Promise<ResolveArtifactOutput>;
  checkSymbolExists: (input: CheckSymbolExistsInput) => Promise<CheckSymbolExistsOutput>;
};
import {
  runBatch,
  splitEntryWarnings,
  type BatchOutput
} from "./batch-runner.js";

type SymbolKind = "class" | "field" | "method";

export type BatchSymbolExistsEntry = {
  kind: SymbolKind;
  name: string;
  owner?: string;
  descriptor?: string;
  nameMode?: "fqcn" | "auto";
  signatureMode?: "exact" | "name-only";
  maxCandidates?: number;
};

/**
 * Subset of `ResolveArtifactTargetInput` accepted by `batch-symbol-exists`.
 * Library/jar/coordinate targets carry the library's own version, not the
 * Minecraft version, so querying the Minecraft mapping graph with that value
 * would be a category error. The zod schema rejects the disallowed kinds.
 */
export type BatchSymbolExistsTarget =
  | (SourceTargetInput & { kind: "version" })
  | WorkspaceTargetInput;

export type BatchSymbolExistsInput = {
  target: BatchSymbolExistsTarget;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
  concurrency?: number;
  failFast?: boolean;
  compact?: boolean;
  entries: readonly BatchSymbolExistsEntry[];
};

type SharedArtifact = {
  artifactId: string;
  provenance?: Record<string, unknown>;
  version: string;
  sourceMapping: SourceMapping;
  warnings?: string[];
};

function deriveMinecraftVersion(
  resolvedVersion: string | undefined,
  workspaceVersion: string | undefined
): string {
  const candidate = resolvedVersion?.trim() || workspaceVersion?.trim();
  if (!candidate) {
    throw createError({
      code: ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
      message:
        "batch-symbol-exists could not derive a Minecraft version from the shared artifact (use target.kind=version or set projectPath so the workspace resolution detects it).",
      details: {
        nextAction:
          "Pass target.kind=\"version\" with the desired Minecraft version, or ensure target.kind=\"workspace\" projectPath points to a Loom/Forge project whose gradle.properties carries minecraft_version."
      }
    });
  }
  return candidate;
}

export class BatchSymbolExistsService {
  constructor(private readonly deps: BatchSymbolExistsDeps) {}

  async execute(input: BatchSymbolExistsInput): Promise<BatchOutput<Record<string, unknown>>> {
    const concurrency = input.concurrency ?? 4;
    const failFast = input.failFast ?? false;
    const compact = input.compact ?? true;

    return runBatch<BatchSymbolExistsEntry, Record<string, unknown>, SharedArtifact>({
      entries: input.entries,
      concurrency,
      failFast,
      resolveSharedArtifact: async () => {
        const resolved = await this.deps.resolveArtifact({
          target: input.target,
          mapping: input.mapping,
          sourcePriority: input.sourcePriority,
          allowDecompile: input.allowDecompile,
          projectPath: input.projectPath,
          scope: input.scope,
          preferProjectVersion: input.preferProjectVersion,
          strictVersion: input.strictVersion
        });
        const provenance = resolved.provenance as
          | { workspaceResolution?: { detected?: { minecraftVersion?: string } } }
          | undefined;
        const workspaceVersion =
          provenance?.workspaceResolution?.detected?.minecraftVersion;
        const version = deriveMinecraftVersion(resolved.version, workspaceVersion);
        return {
          artifactId: resolved.artifactId,
          provenance: resolved.provenance as unknown as Record<string, unknown>,
          version,
          sourceMapping: resolved.mappingApplied,
          ...(Array.isArray(resolved.warnings) && resolved.warnings.length > 0
            ? { warnings: [...resolved.warnings] }
            : {})
        };
      },
      artifactSummary: (artifact) => ({
        sharedArtifactId: artifact.artifactId,
        ...(artifact.provenance ? { sharedArtifactProvenance: artifact.provenance } : {}),
        ...(artifact.warnings && artifact.warnings.length > 0
          ? { sharedArtifactWarnings: artifact.warnings }
          : {})
      }),
      perEntry: async (entry, _index, sharedArtifact) => {
        if (!sharedArtifact) {
          throw new Error("shared artifact not resolved");
        }
        const raw = (await this.deps.checkSymbolExists({
          version: sharedArtifact.version,
          kind: entry.kind,
          name: entry.name,
          owner: entry.owner,
          descriptor: entry.descriptor,
          sourceMapping: sharedArtifact.sourceMapping,
          sourcePriority: input.sourcePriority,
          nameMode: entry.nameMode,
          signatureMode: entry.signatureMode,
          maxCandidates: entry.maxCandidates,
          projectPath: input.projectPath
        } as unknown as CheckSymbolExistsInput)) as unknown as Record<string, unknown>;
        const { result, warnings } = splitEntryWarnings(raw);
        const projected = compact
          ? compactResponse(compactMappingResponse(result))
          : (result as Record<string, unknown>);
        return { result: projected, warnings };
      },
      buildErrorSuggestedCall: (entry, sharedArtifact): SuggestedCall | undefined => {
        if (!sharedArtifact) return undefined;
        const params: Record<string, unknown> = {
          version: sharedArtifact.version,
          kind: entry.kind,
          name: entry.name,
          sourceMapping: sharedArtifact.sourceMapping
        };
        if (entry.owner !== undefined) params.owner = entry.owner;
        if (entry.descriptor !== undefined) params.descriptor = entry.descriptor;
        if (entry.nameMode !== undefined) params.nameMode = entry.nameMode;
        if (entry.signatureMode !== undefined) params.signatureMode = entry.signatureMode;
        if (entry.maxCandidates !== undefined) params.maxCandidates = entry.maxCandidates;
        const { suggestedCall } = buildSuggestedCall({
          tool: "check-symbol-exists",
          params
        });
        return suggestedCall;
      }
    });
  }
}
