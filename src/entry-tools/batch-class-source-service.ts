import { buildSuggestedCall } from "../build-suggested-call.js";
import {
  compactResponse,
  compactSourceResponse,
  TOOL_PRESERVE_PAYLOAD_KEYS
} from "../response-utils.js";
import type { SuggestedCall } from "../error-mapping.js";
import type {
  GetClassSourceInput,
  GetClassSourceOutput,
  ResolveArtifactInput,
  ResolveArtifactOutput
} from "../source-service.js";
import type {
  ArtifactScope,
  MappingSourcePriority,
  ResolveArtifactTargetInput,
  SourceMapping
} from "../types.js";
import {
  runBatch,
  splitEntryWarnings,
  type BatchOutput
} from "./batch-runner.js";

type SourceMode = "metadata" | "snippet" | "full";

export type BatchClassSourceEntry = {
  className: string;
  mode?: SourceMode;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  maxChars?: number;
  outputFile?: string;
};

export type BatchClassSourceInput = {
  target: ResolveArtifactTargetInput;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  gradleUserHome?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
  concurrency?: number;
  failFast?: boolean;
  compact?: boolean;
  entries: readonly BatchClassSourceEntry[];
};

export type BatchClassSourceDeps = {
  resolveArtifact: (input: ResolveArtifactInput) => Promise<ResolveArtifactOutput>;
  getClassSource: (input: GetClassSourceInput) => Promise<GetClassSourceOutput>;
};

type SharedArtifact = {
  artifactId: string;
  provenance?: Record<string, unknown>;
  warnings?: string[];
};

export class BatchClassSourceService {
  constructor(private readonly deps: BatchClassSourceDeps) {}

  async execute(input: BatchClassSourceInput): Promise<BatchOutput<Record<string, unknown>>> {
    const concurrency = input.concurrency ?? 4;
    const failFast = input.failFast ?? false;
    const compact = input.compact ?? true;

    return runBatch<BatchClassSourceEntry, Record<string, unknown>, SharedArtifact>({
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
          gradleUserHome: input.gradleUserHome,
          scope: input.scope,
          preferProjectVersion: input.preferProjectVersion,
          strictVersion: input.strictVersion
        });
        return {
          artifactId: resolved.artifactId,
          provenance: resolved.provenance as unknown as Record<string, unknown>,
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
        const raw = (await this.deps.getClassSource({
          artifactId: sharedArtifact.artifactId,
          className: entry.className,
          mode: entry.mode,
          startLine: entry.startLine,
          endLine: entry.endLine,
          maxLines: entry.maxLines,
          maxChars: entry.maxChars,
          outputFile: entry.outputFile,
          mapping: input.mapping,
          sourcePriority: input.sourcePriority,
          allowDecompile: input.allowDecompile,
          projectPath: input.projectPath,
          gradleUserHome: input.gradleUserHome,
          scope: input.scope,
          preferProjectVersion: input.preferProjectVersion,
          strictVersion: input.strictVersion
        })) as unknown as Record<string, unknown>;
        const { result, warnings } = splitEntryWarnings(raw);
        const projected = compact
          ? compactResponse(
              compactSourceResponse(result),
              TOOL_PRESERVE_PAYLOAD_KEYS["get-class-source"]
            )
          : (result as Record<string, unknown>);
        return { result: projected, warnings };
      },
      buildErrorSuggestedCall: (entry, sharedArtifact): SuggestedCall | undefined => {
        if (!sharedArtifact) return undefined;
        const params: Record<string, unknown> = {
          target: { type: "artifact", artifactId: sharedArtifact.artifactId },
          className: entry.className
        };
        if (entry.mode !== undefined) params.mode = entry.mode;
        if (entry.startLine !== undefined) params.startLine = entry.startLine;
        if (entry.endLine !== undefined) params.endLine = entry.endLine;
        if (entry.maxLines !== undefined) params.maxLines = entry.maxLines;
        if (entry.maxChars !== undefined) params.maxChars = entry.maxChars;
        if (entry.outputFile !== undefined) params.outputFile = entry.outputFile;
        if (input.mapping !== undefined) params.mapping = input.mapping;
        const { suggestedCall } = buildSuggestedCall({
          tool: "get-class-source",
          params
        });
        return suggestedCall;
      }
    });
  }
}
