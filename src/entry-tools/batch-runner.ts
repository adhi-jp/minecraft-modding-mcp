import { mapWithConcurrencyLimit } from "../concurrency.js";
import {
  buildBatchAbortedProblem,
  errorToBatchEntryProblem,
  type ProblemDetails,
  type SuggestedCall
} from "../error-mapping.js";
import type {
  ResolveArtifactInput,
  ResolveArtifactOutput
} from "../source-service.js";
import type { SourceLookupTargetInput } from "../tool-schemas.js";
import type {
  ArtifactScope,
  MappingSourcePriority,
  SourceMapping
} from "../types.js";

export const BATCH_TOOLS_OFF = process.env.BATCH_TOOLS_OFF === "1";

export type BatchEntryOk<TResult> = {
  index: number;
  status: "ok";
  result: TResult;
  warnings: string[];
  durationMs: number;
};

export type BatchEntryError = {
  index: number;
  status: "error";
  error: ProblemDetails;
  warnings: string[];
  durationMs: number;
};

export type BatchEntryResult<TResult> = BatchEntryOk<TResult> | BatchEntryError;

export type BatchSummary = {
  total: number;
  ok: number;
  error: number;
  sharedArtifactId?: string;
  sharedArtifactProvenance?: Record<string, unknown>;
  /** Warnings from the one-shot shared `resolveArtifact` call (version
   * approximation, mapping fallback, source coverage gaps, workspace /
   * dependency resolution caveats). Per-entry dispatch is by `artifactId`
   * and never re-runs resolution, so these warnings reach the caller only
   * via this field. Omitted when the resolution emitted none. */
  sharedArtifactWarnings?: string[];
};

export type BatchOutput<TResult> = {
  results: BatchEntryResult<TResult>[];
  summary: BatchSummary;
};

/** The shared artifact a batch resolves once and dispatches every entry by. */
export type SharedArtifact = {
  artifactId: string;
  provenance?: Record<string, unknown>;
  warnings?: string[];
};

type BatchArtifactSummary = {
  sharedArtifactId?: string;
  sharedArtifactProvenance?: Record<string, unknown>;
  sharedArtifactWarnings?: string[];
};

/** Summary metadata for a resolved shared artifact. `runBatch` drops empty warnings. */
export function defaultArtifactSummary(artifact: SharedArtifact): BatchArtifactSummary {
  return {
    sharedArtifactId: artifact.artifactId,
    ...(artifact.provenance ? { sharedArtifactProvenance: artifact.provenance } : {}),
    ...(artifact.warnings ? { sharedArtifactWarnings: artifact.warnings } : {})
  };
}

export type TargetSharedArtifactInput = {
  target: SourceLookupTargetInput;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  gradleUserHome?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
};

/**
 * Resolves the shared artifact for a batch whose target is a source lookup
 * target. `target.kind === "artifact"` reuses an already-resolved artifactId,
 * short-circuiting resolution exactly as the single tools' own
 * `kind:"artifact"` target does (src/index.ts normalizeSourceLookupTarget).
 * No provenance is invented for a reused artifact: an unknown id is left to
 * surface per-entry (the same SOURCE_NOT_FOUND the per-entry tool raises for an
 * unknown artifactId), since existence cannot be validated without calling
 * resolveArtifact.
 */
export async function resolveTargetSharedArtifact(
  resolveArtifact: (input: ResolveArtifactInput) => Promise<ResolveArtifactOutput>,
  input: TargetSharedArtifactInput
): Promise<SharedArtifact> {
  if (input.target.kind === "artifact") {
    return { artifactId: input.target.artifactId };
  }
  const resolved = await resolveArtifact({
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
    ...(Array.isArray(resolved.warnings) ? { warnings: [...resolved.warnings] } : {})
  };
}

export type BatchRunOptions<TEntry, TResult, TArtifact> = {
  entries: readonly TEntry[];
  concurrency: number;
  failFast: boolean;
  /** Resolve the shared artifact once. May return undefined for batch tools that
   * do not need a shared artifact (e.g. `batch-mappings`, where each entry is
   * mapping-graph-only and does not depend on the artifact). Throws to abort the
   * batch entirely with a top-level error envelope (handled by `runTool`). */
  resolveSharedArtifact: () => Promise<TArtifact | undefined>;
  /** Summary metadata derived from the resolved shared artifact. Defaults to
   * `defaultArtifactSummary`, which expects a `SharedArtifact`-shaped value. */
  artifactSummary?: (artifact: TArtifact) => BatchArtifactSummary;
  /** Per-entry handler. Returns `{ result, warnings }` on success. Errors thrown
   * here are caught and converted to a per-entry ProblemDetails — the mapper
   * itself never throws into `mapWithConcurrencyLimit`. */
  perEntry: (
    entry: TEntry,
    index: number,
    sharedArtifact: TArtifact | undefined
  ) => Promise<{ result: TResult; warnings?: string[] }>;
  /** Synthesize the per-entry retry suggestedCall (proposing the matching single
   * tool). Already validated through `buildSuggestedCall` by the caller; pass
   * `undefined` when the suggestedCall could not be synthesized for this entry. */
  buildErrorSuggestedCall: (
    entry: TEntry,
    sharedArtifact: TArtifact | undefined,
    error: unknown
  ) => SuggestedCall | undefined;
  /** Generate a fresh request-instance id per entry — defaults to the same
   * scheme `runTool` uses (`<base36-time>-<base36-rand>`). Per-entry uniqueness
   * is required so callers can correlate failed entries individually. */
  buildEntryInstance?: (index: number) => string;
};

function defaultEntryInstance(index: number): string {
  return `${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function runBatch<TEntry, TResult, TArtifact>(
  opts: BatchRunOptions<TEntry, TResult, TArtifact>
): Promise<BatchOutput<TResult>> {
  const sharedArtifact = await opts.resolveSharedArtifact();
  const summarize =
    opts.artifactSummary ??
    (defaultArtifactSummary as unknown as (artifact: TArtifact) => BatchArtifactSummary);
  const artifactSummary = sharedArtifact !== undefined ? summarize(sharedArtifact) : {};

  let abort = false;
  const buildInstance = opts.buildEntryInstance ?? defaultEntryInstance;

  const results = await mapWithConcurrencyLimit(
    opts.entries,
    opts.concurrency,
    async (entry, index): Promise<BatchEntryResult<TResult>> => {
      const startedAt = Date.now();

      if (abort) {
        return {
          index,
          status: "error",
          error: buildBatchAbortedProblem(buildInstance(index)),
          warnings: [],
          durationMs: Date.now() - startedAt
        };
      }

      try {
        const { result, warnings } = await opts.perEntry(entry, index, sharedArtifact);
        return {
          index,
          status: "ok",
          result,
          warnings: warnings ?? [],
          durationMs: Date.now() - startedAt
        };
      } catch (caught) {
        const suggestedCall = opts.buildErrorSuggestedCall(entry, sharedArtifact, caught);
        const problem = errorToBatchEntryProblem(
          caught,
          buildInstance(index),
          suggestedCall ? { suggestedCall } : undefined
        );
        if (opts.failFast) {
          abort = true;
        }
        return {
          index,
          status: "error",
          error: problem,
          warnings: [],
          durationMs: Date.now() - startedAt
        };
      }
    }
  );

  let okCount = 0;
  let errorCount = 0;
  for (const entry of results) {
    if (entry.status === "ok") okCount += 1;
    else errorCount += 1;
  }

  return {
    results,
    summary: {
      total: results.length,
      ok: okCount,
      error: errorCount,
      ...(artifactSummary.sharedArtifactId !== undefined
        ? { sharedArtifactId: artifactSummary.sharedArtifactId }
        : {}),
      ...(artifactSummary.sharedArtifactProvenance !== undefined
        ? { sharedArtifactProvenance: artifactSummary.sharedArtifactProvenance }
        : {}),
      ...(artifactSummary.sharedArtifactWarnings !== undefined &&
      artifactSummary.sharedArtifactWarnings.length > 0
        ? { sharedArtifactWarnings: artifactSummary.sharedArtifactWarnings }
        : {})
    }
  };
}

/** Lift `warnings: string[]` off a service result onto the per-entry batch
 * envelope, mirroring `runTool`'s `splitWarnings` for single-tool calls. */
export function splitEntryWarnings<T extends Record<string, unknown>>(
  raw: T
): { result: Omit<T, "warnings">; warnings: string[] } {
  const { warnings, ...rest } = raw as T & { warnings?: unknown };
  const list: string[] = [];
  if (Array.isArray(warnings)) {
    for (const w of warnings) {
      if (typeof w === "string") list.push(w);
    }
  }
  return { result: rest as Omit<T, "warnings">, warnings: list };
}
