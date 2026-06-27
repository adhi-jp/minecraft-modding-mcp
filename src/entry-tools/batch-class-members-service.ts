import { buildSuggestedCall } from "../build-suggested-call.js";
import { projectByDetail, type ResponseDetailLevel } from "../response-utils.js";
import type { SuggestedCall } from "../error-mapping.js";
import type {
  GetClassMembersInput,
  GetClassMembersOutput,
  ResolveArtifactInput,
  ResolveArtifactOutput
} from "../source-service.js";
import type {
  ArtifactScope,
  MappingSourcePriority,
  ResolveArtifactTargetInput,
  SourceMapping
} from "../types.js";
import type { MemberProjection } from "../source/class-source/members-builder.js";
import {
  runBatch,
  splitEntryWarnings,
  type BatchOutput
} from "./batch-runner.js";

export type BatchClassMembersDeps = {
  resolveArtifact: (input: ResolveArtifactInput) => Promise<ResolveArtifactOutput>;
  getClassMembers: (input: GetClassMembersInput) => Promise<GetClassMembersOutput>;
};

export type BatchClassMembersEntry = {
  className: string;
  access?: "public" | "all";
  includeSynthetic?: boolean;
  includeInherited?: boolean;
  memberPattern?: string;
  maxMembers?: number;
};

export type BatchClassMembersInput = {
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
  detail?: ResponseDetailLevel;
  projection?: MemberProjection;
  include?: readonly string[];
  entries: readonly BatchClassMembersEntry[];
};

type SharedArtifact = {
  artifactId: string;
  provenance?: Record<string, unknown>;
  warnings?: string[];
};

export class BatchClassMembersService {
  constructor(private readonly deps: BatchClassMembersDeps) {}

  async execute(input: BatchClassMembersInput): Promise<BatchOutput<Record<string, unknown>>> {
    const concurrency = input.concurrency ?? 4;
    const failFast = input.failFast ?? false;
    const detail = input.detail ?? "summary";
    const include = new Set(input.include ?? []);

    return runBatch<BatchClassMembersEntry, Record<string, unknown>, SharedArtifact>({
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
        const raw = (await this.deps.getClassMembers({
          artifactId: sharedArtifact.artifactId,
          className: entry.className,
          access: entry.access,
          includeSynthetic: entry.includeSynthetic,
          includeInherited: entry.includeInherited,
          memberPattern: entry.memberPattern,
          maxMembers: entry.maxMembers,
          projection: input.projection,
          includeDescriptors: include.has("descriptors"),
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
        const projected = projectByDetail(
          "get-class-members",
          result as Record<string, unknown>,
          detail,
          include
        );
        return { result: projected, warnings };
      },
      buildErrorSuggestedCall: (entry, sharedArtifact): SuggestedCall | undefined => {
        if (!sharedArtifact) return undefined;
        const params: Record<string, unknown> = {
          target: { kind: "artifact", artifactId: sharedArtifact.artifactId },
          className: entry.className
        };
        if (entry.access !== undefined) params.access = entry.access;
        if (entry.includeSynthetic !== undefined) params.includeSynthetic = entry.includeSynthetic;
        if (entry.includeInherited !== undefined) params.includeInherited = entry.includeInherited;
        if (entry.memberPattern !== undefined) params.memberPattern = entry.memberPattern;
        if (entry.maxMembers !== undefined) params.maxMembers = entry.maxMembers;
        if (input.mapping !== undefined) params.mapping = input.mapping;
        const { suggestedCall } = buildSuggestedCall({
          tool: "get-class-members",
          params
        });
        return suggestedCall;
      }
    });
  }
}
