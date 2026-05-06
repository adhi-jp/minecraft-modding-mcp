import { mapWithConcurrencyLimit } from "../concurrency.js";
import {
  buildBatchAbortedProblem,
  errorToBatchEntryProblem,
  type ProblemDetails,
  type SuggestedCall
} from "../error-mapping.js";

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

export type BatchRunOptions<TEntry, TResult, TArtifact> = {
  entries: readonly TEntry[];
  concurrency: number;
  failFast: boolean;
  /** Resolve the shared artifact once. May return undefined for batch tools that
   * do not need a shared artifact (e.g. `batch-mappings`, where each entry is
   * mapping-graph-only and does not depend on the artifact). Throws to abort the
   * batch entirely with a top-level error envelope (handled by `runTool`). */
  resolveSharedArtifact: () => Promise<TArtifact | undefined>;
  /** Summary metadata derived from the resolved shared artifact. */
  artifactSummary?: (artifact: TArtifact) => {
    sharedArtifactId?: string;
    sharedArtifactProvenance?: Record<string, unknown>;
    sharedArtifactWarnings?: string[];
  };
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
  const artifactSummary =
    sharedArtifact !== undefined && opts.artifactSummary
      ? opts.artifactSummary(sharedArtifact)
      : {};

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
