import { getToolSchema, validateToolParams } from "./tool-schema-registry.js";

export const SUGGESTED_CALL_VALIDATE_OFF =
  process.env.SUGGESTED_CALL_VALIDATE_OFF === "1";

export type SuggestedCallExample = {
  params: unknown;
  reason: string;
};

export type SuggestedCallSpec = {
  tool: string;
  params: unknown;
  examples?: SuggestedCallExample[];
};

export type ValidatedSuggestedCall = {
  tool: string;
  params: Record<string, unknown>;
};

export type ValidatedExampleCall = {
  tool: string;
  params: Record<string, unknown>;
  reason: string;
  valid: true;
};

export type SuggestedCallOutput = {
  suggestedCall?: ValidatedSuggestedCall;
  exampleCalls?: ValidatedExampleCall[];
  /** Set to `true` when the caller supplied `params` but the gate dropped it.
   * Spread into AppError `details`; `mapErrorToProblem` reads the marker to
   * append the fallback hint to `error.hints` and strips it before emission. */
  _suggestedCallPrimaryDropped?: true;
};

function asParamsRecord(params: unknown): Record<string, unknown> | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  return params as Record<string, unknown>;
}

// Placeholder sentinels are `<...>` tokens that a caller must substitute before
// the call is executable (e.g. "<version>", "<fully-qualified-class-name>").
// The two JVM pseudo-method-names `<init>` / `<clinit>` are real, valid values
// and are explicitly excluded so constructor lookups are not misclassified.
const PLACEHOLDER_SENTINEL_RE = /<(?!init>)(?!clinit>)[^<>]+>/;

function containsPlaceholderSentinel(value: unknown): boolean {
  if (typeof value === "string") {
    return PLACEHOLDER_SENTINEL_RE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsPlaceholderSentinel);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsPlaceholderSentinel);
  }
  return false;
}

export function buildSuggestedCall(spec: SuggestedCallSpec): SuggestedCallOutput {
  const primaryParams = asParamsRecord(spec.params);

  // A `suggestedCall` must be directly executable. Reject any primary payload
  // that still carries a placeholder sentinel (e.g. "<version>") even when it
  // is schema-valid: those belong in `exampleCalls` as templates, not as a
  // call the caller can replay verbatim.
  if (primaryParams && !containsPlaceholderSentinel(primaryParams)) {
    if (SUGGESTED_CALL_VALIDATE_OFF) {
      return { suggestedCall: { tool: spec.tool, params: primaryParams } };
    }
    // Unknown-tool fail-open: the registry is populated at index.ts startup;
    // service-level tests that do not boot index.ts run with an empty
    // registry and rely on this pass-through. Callers that synthesize a tool
    // name from runtime data (e.g. `?? "unknown"`) MUST skip this helper, or
    // a non-callable payload escapes via this branch.
    if (!getToolSchema(spec.tool)) {
      return { suggestedCall: { tool: spec.tool, params: primaryParams } };
    }
    const primary = validateToolParams(spec.tool, primaryParams);
    if (primary.valid) {
      return { suggestedCall: { tool: spec.tool, params: primaryParams } };
    }
  }

  const droppedMarker: { _suggestedCallPrimaryDropped: true } | Record<never, never> =
    spec.params !== undefined ? { _suggestedCallPrimaryDropped: true as const } : {};

  if (spec.examples && spec.examples.length > 0) {
    // Example calls are templates (placeholders allowed) and only their
    // schema-shape is checked. Mirror the primary path's unknown-tool
    // fail-open so service-level tests with an unpopulated registry still
    // surface templates instead of silently dropping them.
    const exampleSchemaUnavailable = SUGGESTED_CALL_VALIDATE_OFF || !getToolSchema(spec.tool);
    const validated = spec.examples
      .map((example): ValidatedExampleCall | null => {
        const exampleParams = asParamsRecord(example.params);
        if (!exampleParams) {
          return null;
        }
        if (!exampleSchemaUnavailable && !validateToolParams(spec.tool, exampleParams).valid) {
          return null;
        }
        return {
          tool: spec.tool,
          params: exampleParams,
          reason: example.reason,
          valid: true
        };
      })
      .filter((entry): entry is ValidatedExampleCall => entry !== null);

    if (validated.length > 0) {
      return { exampleCalls: validated, ...droppedMarker };
    }
  }

  return droppedMarker;
}
