import { ERROR_CODES, isAppError, type ErrorCode } from "./errors.js";
import { log } from "./logger.js";

export type ProblemFieldError = {
  path: string;
  message: string;
  code?: string;
};

export type SuggestedCall = {
  tool: string;
  params: Record<string, unknown>;
};

export type ExampleCall = {
  tool: string;
  params: Record<string, unknown>;
  reason: string;
};

/**
 * Whether retrying the same call can help, and why if not:
 * - `transient`: a temporary failure (network, rate limit, timeout); retrying
 *   the same call later may succeed.
 * - `permanent`: the requested thing does not exist or cannot be produced;
 *   retrying the same call will keep failing.
 * - `server`: a non-recoverable internal server fault (programming bug, DB
 *   corruption); retrying the identical call cannot help. Distinct from
 *   `permanent`, which is about an absent/unproducible target rather than a
 *   server defect. Treat like `permanent` for retry posture (do not retry).
 * - `environment`: the server lacks a capability (Java, decompiler, remapper);
 *   retrying will not help until the environment is fixed.
 * - `input`: the caller's input is wrong; fix the input, then retry.
 */
export type RetryClass = "transient" | "permanent" | "server" | "environment" | "input";

/**
 * Where the failure originates, so an agent knows whether to fix its own
 * request or stop retrying this tool:
 * - `code_issue`: the caller's input is wrong or names something that does not
 *   exist; fix the request.
 * - `tool_issue`: the tool could not produce a result for valid input (mapping
 *   gap, upstream fetch, internal limit).
 * - `environment`: a server capability is missing (Java, decompiler, remapper).
 */
export type IssueOrigin = "code_issue" | "tool_issue" | "environment";

export type DidYouMeanCandidate = {
  className: string;
  matchReason: string;
};

export type ProblemDetails = {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: string;
  instance: string;
  retryClass: RetryClass;
  issueOrigin: IssueOrigin;
  fieldErrors?: ProblemFieldError[];
  hints?: string[];
  suggestedCall?: SuggestedCall;
  exampleCalls?: ExampleCall[];
  /** Ranked near-miss candidates for a class/symbol that was not found. */
  didYouMean?: DidYouMeanCandidate[];
  /**
   * Nested-jar inventory of the shell jar the lookup ran against, as jar-entry
   * names (e.g. "META-INF/jars/api.jar"). A shell jar holds no classes of its
   * own, so a class-not-found error on one is only actionable with the list of
   * inner jars the caller can target next. Like `didYouMean`, it travels as a
   * dedicated typed field: `context` is primitive-only and can never carry it.
   */
  nestedJars?: string[];
  /**
   * True when `nestedJars` is a SHORTENED view of the shell's inventory —
   * entries were dropped by the count cap, the per-entry length cap, or the
   * total-bytes cap. Without it a caller cannot tell a complete inventory from
   * a trimmed one and may conclude a class is bundled nowhere. Additive and
   * omitted entirely when the published list is complete, matching the
   * `candidatesTruncated` precedent.
   */
  nestedJarsTruncated?: boolean;
  failedStage?: string;
  context?: Record<string, string | number | boolean>;
};

const MAX_DID_YOU_MEAN_ENTRIES = 16;

/**
 * Validates and extracts a `didYouMean` array from error details. Like
 * `suggestedCall`, it travels as a dedicated typed field — the primitive-only
 * context allowlist is not loosened for it. Malformed payloads are dropped
 * whole rather than partially published.
 */
export function extractDidYouMean(details: unknown): DidYouMeanCandidate[] | undefined {
  const raw = (details as { didYouMean?: unknown } | undefined)?.didYouMean;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const cleaned: DidYouMeanCandidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      return undefined;
    }
    const { className, matchReason, artifactId } = entry as {
      className?: unknown;
      matchReason?: unknown;
      artifactId?: unknown;
    };
    if (typeof className !== "string" || typeof matchReason !== "string") {
      return undefined;
    }
    // `artifactId` marks a candidate found in an artifact the caller did not name
    // (the internal binary fallback or nested-jar redirect). It is optional and
    // dropped when malformed, so a bad value cannot suppress the whole array.
    cleaned.push({
      className,
      matchReason,
      ...(typeof artifactId === "string" && artifactId ? { artifactId } : {})
    });
  }
  return cleaned.slice(0, MAX_DID_YOU_MEAN_ENTRIES);
}

// A shell jar bundles a handful of inner jars, not hundreds; the cap only
// bounds a pathological inventory, it is not an expected truncation point.
const MAX_NESTED_JAR_ENTRIES = 64;

// Per-entry length ceiling, in UTF-8 bytes. Real entries are jar-relative paths
// like "META-INF/jars/fabric-screen-handler-api-v1-2.0.5.jar" (~52 bytes); the
// zip format itself allows a 65535-byte name, so an entry name is attacker-sized
// unless bounded here. 256 bytes is ~5x the longest realistic entry and still
// leaves any genuine name intact.
const MAX_NESTED_JAR_ENTRY_BYTES = 256;

// Total ceiling for the published list, in UTF-8 bytes. A full fabric-api-style
// inventory (64 entries at ~52 bytes) is ~3.3 KiB, so 8 KiB carries every real
// inventory whole while bounding the worst case this field can add to an error
// payload — which matters because nothing else in this project bounds an
// outbound response (MCP_MAX_FRAME_BYTES governs inbound decoding only).
const MAX_NESTED_JARS_TOTAL_BYTES = 8 * 1024;

/**
 * The `nestedJars` pair as published: the inventory plus the additive flag that
 * says whether it is complete. Both keys are omitted when there is nothing to
 * publish, so the object spreads directly into a ProblemDetails.
 */
export type NestedJarsField = {
  nestedJars?: string[];
  nestedJarsTruncated?: boolean;
};

/**
 * Validates and extracts a `nestedJars` inventory from error details.
 * `buildClassSourceNotFoundError` records it whenever the lookup ran against a
 * shell jar, but `context` is primitive-only, so without this the inventory
 * never left the process.
 *
 * Two distinct dispositions, deliberately not conflated:
 *  - MALFORMED (a non-string or empty-string element, anywhere in the array):
 *    the whole array is dropped, matching {@link extractDidYouMean}. The scan
 *    deliberately continues past the caps so a malformed element beyond them is
 *    still found — the upstream array is a real jar's own entry list, bounded by
 *    the archive, so the full scan is not an exposure.
 *  - OVERSIZED (an entry longer than {@link MAX_NESTED_JAR_ENTRY_BYTES}, an
 *    entry past the count cap, or one that would push the list past the total
 *    byte budget): that ENTRY alone is excluded and `nestedJarsTruncated` is
 *    set. An implausible name is not evidence that the rest of the inventory is
 *    untrustworthy, so it must not drop the array.
 *
 * An empty inventory is dropped as before: the producing site omits the key
 * entirely in that case, so an empty array carries no information a caller could
 * act on. If the caps leave nothing publishable, both keys are omitted rather
 * than publishing a truncation flag with no list beside it.
 */
export function extractNestedJarsField(details: unknown): NestedJarsField {
  const raw = (details as { nestedJars?: unknown } | undefined)?.nestedJars;
  if (!Array.isArray(raw) || raw.length === 0) {
    return {};
  }
  const cleaned: string[] = [];
  let truncated = false;
  let totalBytes = 0;
  let budgetExhausted = false;
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry) {
      return {};
    }
    if (budgetExhausted || cleaned.length >= MAX_NESTED_JAR_ENTRIES) {
      truncated = true;
      continue;
    }
    const entryBytes = Buffer.byteLength(entry, "utf8");
    if (entryBytes > MAX_NESTED_JAR_ENTRY_BYTES) {
      truncated = true;
      continue;
    }
    if (totalBytes + entryBytes > MAX_NESTED_JARS_TOTAL_BYTES) {
      // Keep the published list a prefix of the surviving entries: once the
      // budget is spent, stop admitting rather than cherry-picking short names
      // from the tail.
      truncated = true;
      budgetExhausted = true;
      continue;
    }
    totalBytes += entryBytes;
    cleaned.push(entry);
  }
  if (cleaned.length === 0) {
    return {};
  }
  return { nestedJars: cleaned, ...(truncated ? { nestedJarsTruncated: true } : {}) };
}

/**
 * Inventory-only view of {@link extractNestedJarsField}.
 *
 * NOT for an emission site. All three - the tool envelope, the batch entry, the
 * error resource - publish the field pair, because dropping the flag makes a
 * shortened inventory indistinguishable from a complete one. This remains for
 * callers that want the list alone (tests pinning the validation and capping
 * rules), and a new publisher should reach for the field-returning form.
 */
export function extractNestedJars(details: unknown): string[] | undefined {
  return extractNestedJarsField(details).nestedJars;
}

const ISSUE_ORIGIN_VALUES = new Set<string>([
  "code_issue",
  "tool_issue",
  "environment"
]);

/**
 * Per-throw-site {@link IssueOrigin} override carried on an AppError's
 * `details.issueOrigin`.
 *
 * The default classification is keyed purely on the error CODE, which is right
 * for codes whose every throw site shares one origin. A few codes do not:
 * `ERR_CONTEXT_UNRESOLVED` covers both a caller naming a version no artifact
 * carries (genuinely `code_issue`) and the tool resolving an artifact with no
 * binary jar behind the caller's back (`tool_issue`). Publishing the latter as
 * caller-fixable sends an agent into a retry loop over input it cannot repair.
 *
 * This override is deliberately opt-in and per-error: `issueOriginForErrorCode`
 * and its default sets stay untouched, so the exhaustive classification map in
 * tests/runtime/error-mapping.test.ts keeps forcing a conscious decision for
 * every new code. The key is not in `CONTEXT_ALLOWLIST`, so it cannot leak into
 * the public `context` blob.
 */
export function extractIssueOriginOverride(details: unknown): IssueOrigin | undefined {
  const raw = (details as { issueOrigin?: unknown } | undefined)?.issueOrigin;
  return typeof raw === "string" && ISSUE_ORIGIN_VALUES.has(raw)
    ? (raw as IssueOrigin)
    : undefined;
}

export function statusForErrorCode(code: string): number {
  if (code === ERROR_CODES.BATCH_ABORTED) {
    return 412;
  }

  if (code === ERROR_CODES.STAGE_BUDGET_PRE_PARSE) {
    // 408 (Request Timeout): caller-recoverable stage-budget exhaustion,
    // not an internal server failure.
    return 408;
  }

  if (code === ERROR_CODES.TOOL_TIMEOUT) {
    return 408;
  }

  if (
    code === ERROR_CODES.INVALID_INPUT ||
    code === ERROR_CODES.COORDINATE_PARSE_FAILED ||
    code === ERROR_CODES.INVALID_LINE_RANGE ||
    code === ERROR_CODES.NBT_PARSE_FAILED ||
    code === ERROR_CODES.NBT_INVALID_TYPED_JSON ||
    code === ERROR_CODES.JSON_PATCH_INVALID ||
    code === ERROR_CODES.NBT_ENCODE_FAILED ||
    code === ERROR_CODES.NBT_UNSUPPORTED_FEATURE
  ) {
    return 400;
  }

  if (code === ERROR_CODES.JSON_PATCH_CONFLICT || code === ERROR_CODES.CONTEXT_UNRESOLVED) {
    return 409;
  }

  if (
    code === ERROR_CODES.SOURCE_NOT_FOUND ||
    code === ERROR_CODES.FILE_NOT_FOUND ||
    code === ERROR_CODES.JAR_NOT_FOUND ||
    code === ERROR_CODES.VERSION_NOT_FOUND ||
    code === ERROR_CODES.CLASS_NOT_FOUND
  ) {
    return 404;
  }

  if (
    code === ERROR_CODES.MAPPING_NOT_APPLIED ||
    code === ERROR_CODES.MAPPING_UNAVAILABLE ||
    code === ERROR_CODES.NAMESPACE_MISMATCH ||
    code === ERROR_CODES.DECOMPILE_DISABLED ||
    code === ERROR_CODES.REMAP_FAILED ||
    code === ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED ||
    code === ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED ||
    code === ERROR_CODES.NESTED_JAR_AMBIGUOUS
  ) {
    return 422;
  }

  if (
    code === ERROR_CODES.REMAPPER_UNAVAILABLE ||
    code === ERROR_CODES.JAVA_PROCESS_FAILED
  ) {
    return 503;
  }

  if (code === ERROR_CODES.LIMIT_EXCEEDED) {
    return 413;
  }

  if (code === ERROR_CODES.REPO_FETCH_FAILED) {
    return 502;
  }

  if (
    code === ERROR_CODES.DECOMPILER_UNAVAILABLE ||
    code === ERROR_CODES.DECOMPILER_FAILED ||
    code === ERROR_CODES.JAVA_UNAVAILABLE ||
    code === ERROR_CODES.REGISTRY_GENERATION_FAILED
  ) {
    return 503;
  }

  return 500;
}

const RETRY_CLASS_INPUT = new Set<string>([
  ERROR_CODES.INVALID_INPUT,
  ERROR_CODES.COORDINATE_PARSE_FAILED,
  ERROR_CODES.INVALID_LINE_RANGE,
  ERROR_CODES.NBT_PARSE_FAILED,
  ERROR_CODES.NBT_INVALID_TYPED_JSON,
  ERROR_CODES.JSON_PATCH_INVALID,
  ERROR_CODES.JSON_PATCH_CONFLICT,
  ERROR_CODES.NBT_ENCODE_FAILED,
  ERROR_CODES.NBT_UNSUPPORTED_FEATURE,
  ERROR_CODES.NAMESPACE_MISMATCH,
  ERROR_CODES.CONTEXT_UNRESOLVED,
  ERROR_CODES.MIXIN_PARSE_FAILED
]);

const RETRY_CLASS_PERMANENT = new Set<string>([
  ERROR_CODES.SOURCE_NOT_FOUND,
  ERROR_CODES.FILE_NOT_FOUND,
  ERROR_CODES.JAR_NOT_FOUND,
  ERROR_CODES.VERSION_NOT_FOUND,
  ERROR_CODES.CLASS_NOT_FOUND,
  ERROR_CODES.MAPPING_NOT_APPLIED,
  ERROR_CODES.MAPPING_UNAVAILABLE,
  ERROR_CODES.DECOMPILE_DISABLED,
  ERROR_CODES.REMAP_FAILED,
  ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
  ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED,
  ERROR_CODES.NESTED_JAR_AMBIGUOUS,
  ERROR_CODES.PROVENANCE_INCOMPLETE,
  ERROR_CODES.BATCH_ABORTED
]);

const RETRY_CLASS_ENVIRONMENT = new Set<string>([
  ERROR_CODES.JAVA_UNAVAILABLE,
  ERROR_CODES.DECOMPILER_UNAVAILABLE,
  ERROR_CODES.DECOMPILER_FAILED,
  ERROR_CODES.REMAPPER_UNAVAILABLE,
  ERROR_CODES.REGISTRY_GENERATION_FAILED
]);

// Non-recoverable internal server faults: a deterministic defect where retrying
// the identical call cannot help. ERR_INTERNAL covers sanitized programming
// bugs / unexpected throws; ERR_DB_FAILURE covers SQLite integrity/migration
// failures (the open-failure path can be a transient file lock, but corruption
// and migration failures dominate, so it is classified server by default).
const RETRY_CLASS_SERVER = new Set<string>([
  ERROR_CODES.INTERNAL,
  ERROR_CODES.DB_FAILURE
]);

/**
 * Single source of truth mapping an error code to its {@link RetryClass}. Used
 * by every public problem builder so callers can branch on recovery strategy
 * without parsing prose. Non-recoverable server faults (`ERR_INTERNAL`,
 * `ERR_DB_FAILURE`) classify as `server`. Codes not explicitly classified
 * (genuinely-transient failures such as `ERR_REPO_FETCH_FAILED` and unknown
 * codes) default to `transient`: a temporary failure where one retry is
 * reasonable.
 */
export function retryClassForErrorCode(code: string): RetryClass {
  if (RETRY_CLASS_INPUT.has(code)) {
    return "input";
  }
  if (RETRY_CLASS_PERMANENT.has(code)) {
    return "permanent";
  }
  if (RETRY_CLASS_SERVER.has(code)) {
    return "server";
  }
  if (RETRY_CLASS_ENVIRONMENT.has(code)) {
    return "environment";
  }
  return "transient";
}

// "Your request is wrong or names something absent" — the caller can fix it.
const ISSUE_ORIGIN_CODE = new Set<string>([
  ERROR_CODES.INVALID_INPUT,
  ERROR_CODES.COORDINATE_PARSE_FAILED,
  ERROR_CODES.INVALID_LINE_RANGE,
  ERROR_CODES.NBT_PARSE_FAILED,
  ERROR_CODES.NBT_INVALID_TYPED_JSON,
  ERROR_CODES.JSON_PATCH_INVALID,
  ERROR_CODES.JSON_PATCH_CONFLICT,
  ERROR_CODES.NBT_ENCODE_FAILED,
  ERROR_CODES.NBT_UNSUPPORTED_FEATURE,
  ERROR_CODES.NAMESPACE_MISMATCH,
  ERROR_CODES.CONTEXT_UNRESOLVED,
  ERROR_CODES.MIXIN_PARSE_FAILED,
  ERROR_CODES.CLASS_NOT_FOUND,
  ERROR_CODES.SOURCE_NOT_FOUND,
  ERROR_CODES.FILE_NOT_FOUND,
  ERROR_CODES.JAR_NOT_FOUND,
  ERROR_CODES.VERSION_NOT_FOUND,
  ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
  ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED,
  ERROR_CODES.NESTED_JAR_AMBIGUOUS
]);

/**
 * Single source of truth mapping an error code to its {@link IssueOrigin}.
 * Environment failures reuse the retry classifier; the input-family above is
 * `code_issue`; everything else is a `tool_issue` (valid input the tool could
 * not satisfy).
 */
export function issueOriginForErrorCode(code: string): IssueOrigin {
  if (RETRY_CLASS_ENVIRONMENT.has(code)) {
    return "environment";
  }
  if (ISSUE_ORIGIN_CODE.has(code)) {
    return "code_issue";
  }
  return "tool_issue";
}

/**
 * The single source of truth for a ProblemDetails classification pair, and the
 * ONLY supported way to compute one for an error the server caught. Every site
 * that turns a caught error into a published envelope spreads this result — the
 * tool envelope (`mapErrorToProblem`), batch entries, the batch-aborted
 * sentinel, and the `mc://` resource read — so one failure always publishes the
 * same `{ retryClass, issueOrigin }` no matter which access path the caller
 * used.
 *
 * KNOWN EXCEPTION — the synthetic supervisor replies in `src/stdio-supervisor.ts`
 * (`buildSupervisorQueueLimitReply`, `buildValidateProjectTimeoutReply`) write
 * the pair as literals and never import this builder. They are not emission
 * sites for a caught error at all: the supervisor answers a request the worker
 * never got to run, so there is no source `AppError` whose `details` could carry
 * an override and nothing to pass as the required `details` argument. Their
 * literals are `transient` / `tool_issue`, which is exactly what this function
 * returns for `ERR_LIMIT_EXCEEDED` and `ERR_TOOL_TIMEOUT` today — but that is a
 * duplicated value held in agreement by hand, not a second call into this
 * classifier. Reclassifying either code here must be mirrored there.
 *
 * It exists because that pair used to be assembled by hand at each site. The
 * `issueOrigin` half has a per-throw-site override (see
 * {@link extractIssueOriginOverride}), and honouring it was copy-pasted into
 * some sites and forgotten in others — which is exactly how one identical
 * AppError came to publish `tool_issue` through a tool call and `code_issue`
 * through a resource read. Composing the pair here removes the opportunity:
 * emission modules import this function and no longer reach the component
 * classifiers at all.
 *
 * `details` is REQUIRED, deliberately without a default. A site that genuinely
 * has no AppError behind it (a ZodError, a sanitized non-AppError, the
 * batch-aborted sentinel) must pass `undefined` explicitly, so skipping the
 * override can only ever be a written-down decision rather than an omission.
 *
 * Only `issueOrigin` is overridable per throw site. `retryClass` stays purely
 * code-derived: it is a documented wire contract, and changing the value an
 * existing code publishes is a Breaking change, so a `retryClass` override seam
 * was deliberately deferred rather than added alongside this one.
 */
export function problemClassification(
  code: string,
  details: unknown
): Pick<ProblemDetails, "retryClass" | "issueOrigin"> {
  return {
    retryClass: retryClassForErrorCode(code),
    issueOrigin: extractIssueOriginOverride(details) ?? issueOriginForErrorCode(code)
  };
}

// Non-sensitive AppError.details fields that are safe to echo to callers as
// machine-readable repair context. Filesystem paths and free-form text are
// intentionally excluded.
const CONTEXT_ALLOWLIST = new Set<string>([
  "queryLength",
  "maxLength",
  "artifactId",
  "registry",
  "registryName",
  "stage",
  "version",
  "mapping",
  "namespace",
  "kind",
  "owner",
  "limit",
  "count",
  "maxMembers",
  "candidateCount",
  "candidatesSeen",
  "ambiguous",
  // Why a repository cascade gave up, as the failing leg's own error code (e.g.
  // "ERR_LIMIT_EXCEEDED"). The terminal ERR_REPO_FETCH_FAILED says only that
  // repositories were unstable, which is wrong for a configuration-driven
  // refusal; the underlying code is the machine-readable half of that
  // correction, beside the human-readable `nextAction` hint. A bare code string
  // - no url, no path, no message - which is why it can travel here at all.
  "repoFailureCode"
]);

/**
 * Pick the allowlisted, primitive-valued fields out of an AppError's `details`
 * so the public envelope can carry structured repair context without leaking
 * paths, parser internals, or other sensitive data.
 */
export function extractAllowlistedContext(
  details: unknown
): Record<string, string | number | boolean> | undefined {
  if (typeof details !== "object" || details == null) {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  for (const key of CONTEXT_ALLOWLIST) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractFieldErrors(details: unknown): ProblemFieldError[] | undefined {
  if (typeof details !== "object" || details == null) return undefined;
  const raw = (details as Record<string, unknown>).fieldErrors;
  if (!Array.isArray(raw)) return undefined;
  const out: ProblemFieldError[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry == null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.path !== "string" || typeof rec.message !== "string") continue;
    out.push({
      path: rec.path,
      message: rec.message,
      ...(typeof rec.code === "string" ? { code: rec.code } : {})
    });
  }
  return out.length > 0 ? out : undefined;
}

function extractHints(details: unknown): string[] | undefined {
  if (typeof details !== "object" || details == null) return undefined;
  const next = (details as Record<string, unknown>).nextAction;
  if (typeof next !== "string" || !next.trim()) return undefined;
  return [next.trim()];
}

/**
 * Per-entry subset of `mapErrorToProblem` for batch tools. ZodErrors are not
 * handled here (per-entry input has already cleared the batch tool's schema
 * gate); the optional `suggestedCall` is attached as-is for the caller's
 * synthesized retry payload.
 */
export function errorToBatchEntryProblem(
  caughtError: unknown,
  instance: string,
  options?: { suggestedCall?: SuggestedCall }
): ProblemDetails {
  if (isAppError(caughtError)) {
    const baseHints = extractHints(caughtError.details);
    const fieldErrors = extractFieldErrors(caughtError.details);
    const context = extractAllowlistedContext(caughtError.details);
    const didYouMean = extractDidYouMean(caughtError.details);
    const nestedJarsField = extractNestedJarsField(caughtError.details);
    return {
      type: `https://minecraft-modding-mcp.dev/problems/${caughtError.code.toLowerCase()}`,
      title: "Tool execution error",
      detail: caughtError.message,
      status: statusForErrorCode(caughtError.code),
      code: caughtError.code,
      instance,
      ...problemClassification(caughtError.code, caughtError.details),
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(baseHints ? { hints: baseHints } : {}),
      ...(options?.suggestedCall ? { suggestedCall: options.suggestedCall } : {}),
      ...(didYouMean ? { didYouMean } : {}),
      ...nestedJarsField,
      ...(context ? { context } : {})
    };
  }

  // Generic-error sanitization: fixed public detail, raw message logged
  // server-side keyed by `instance`. Mirrors `mapErrorToProblem` so the
  // public envelope cannot leak filesystem paths, parser internals, or
  // assertion text on a non-AppError path.
  const rawMessage =
    caughtError instanceof Error ? caughtError.message : String(caughtError);
  log("error", "batch.entry.unhandled", {
    instance,
    reason: rawMessage
  });
  return {
    type: "https://minecraft-modding-mcp.dev/problems/internal",
    title: "Internal server error",
    detail: "Unexpected server error.",
    status: 500,
    code: ERROR_CODES.INTERNAL,
    instance,
    // No AppError behind this envelope: the throw was sanitized away, so there
    // is no per-site override to honour.
    ...problemClassification(ERROR_CODES.INTERNAL, undefined),
    ...(options?.suggestedCall ? { suggestedCall: options.suggestedCall } : {})
  };
}

export function buildBatchAbortedProblem(instance: string): ProblemDetails {
  return {
    type: `https://minecraft-modding-mcp.dev/problems/${ERROR_CODES.BATCH_ABORTED.toLowerCase()}`,
    title: "Batch aborted",
    detail: "Earlier entry failed and failFast=true.",
    status: 412,
    code: ERROR_CODES.BATCH_ABORTED,
    instance,
    // Synthesized sentinel, not a caught AppError: no per-site override exists.
    ...problemClassification(ERROR_CODES.BATCH_ABORTED, undefined)
  };
}

export type { ErrorCode };
