import { buildSuggestedCall } from "../build-suggested-call.js";
import {
  compactResponse,
  compactMappingResponse
} from "../response-utils.js";
import type { SuggestedCall } from "../error-mapping.js";
import type {
  FindMappingInput,
  FindMappingOutput
} from "../source-service.js";
import type { MappingSourcePriority, SourceMapping } from "../types.js";

export type BatchMappingsDeps = {
  findMapping: (input: FindMappingInput) => Promise<FindMappingOutput>;
};
import {
  runBatch,
  splitEntryWarnings,
  type BatchOutput
} from "./batch-runner.js";

type SymbolKind = "class" | "field" | "method";

export type BatchMappingsEntry = {
  kind: SymbolKind;
  name: string;
  owner?: string;
  descriptor?: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  signatureMode?: "exact" | "name-only";
  disambiguation?: {
    ownerHint?: string;
    descriptorHint?: string;
  };
  maxCandidates?: number;
};

export type BatchMappingsInput = {
  version: string;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  gradleUserHome?: string;
  concurrency?: number;
  failFast?: boolean;
  compact?: boolean;
  entries: readonly BatchMappingsEntry[];
};

export class BatchMappingsService {
  constructor(private readonly deps: BatchMappingsDeps) {}

  async execute(input: BatchMappingsInput): Promise<BatchOutput<Record<string, unknown>>> {
    const concurrency = input.concurrency ?? 4;
    const failFast = input.failFast ?? false;
    const compact = input.compact ?? true;

    return runBatch<BatchMappingsEntry, Record<string, unknown>, undefined>({
      entries: input.entries,
      concurrency,
      failFast,
      resolveSharedArtifact: async () => undefined,
      perEntry: async (entry, _index) => {
        const raw = (await this.deps.findMapping({
          version: input.version,
          kind: entry.kind,
          name: entry.name,
          owner: entry.owner,
          descriptor: entry.descriptor,
          sourceMapping: entry.sourceMapping,
          targetMapping: entry.targetMapping,
          sourcePriority: input.sourcePriority,
          projectPath: input.projectPath,
          gradleUserHome: input.gradleUserHome,
          signatureMode: entry.signatureMode,
          disambiguation: entry.disambiguation,
          maxCandidates: entry.maxCandidates
        })) as unknown as Record<string, unknown>;
        const { result, warnings } = splitEntryWarnings(raw);
        const projected = compact
          ? compactResponse(compactMappingResponse(result))
          : (result as Record<string, unknown>);
        return { result: projected, warnings };
      },
      buildErrorSuggestedCall: (entry): SuggestedCall | undefined => {
        const params: Record<string, unknown> = {
          version: input.version,
          kind: entry.kind,
          name: entry.name,
          sourceMapping: entry.sourceMapping,
          targetMapping: entry.targetMapping
        };
        if (entry.owner !== undefined) params.owner = entry.owner;
        if (entry.descriptor !== undefined) params.descriptor = entry.descriptor;
        if (entry.signatureMode !== undefined) params.signatureMode = entry.signatureMode;
        if (entry.disambiguation !== undefined) params.disambiguation = entry.disambiguation;
        if (entry.maxCandidates !== undefined) params.maxCandidates = entry.maxCandidates;
        const { suggestedCall } = buildSuggestedCall({
          tool: "find-mapping",
          params
        });
        return suggestedCall;
      }
    });
  }
}
