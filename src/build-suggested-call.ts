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

export function buildSuggestedCall(spec: SuggestedCallSpec): SuggestedCallOutput {
  if (SUGGESTED_CALL_VALIDATE_OFF) {
    const rawParams = asParamsRecord(spec.params);
    if (rawParams) {
      return { suggestedCall: { tool: spec.tool, params: rawParams } };
    }
    return {};
  }

  const primaryParams = asParamsRecord(spec.params);
  if (primaryParams) {
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
    const validated = spec.examples
      .map((example): ValidatedExampleCall | null => {
        const exampleParams = asParamsRecord(example.params);
        if (!exampleParams) {
          return null;
        }
        const result = validateToolParams(spec.tool, exampleParams);
        if (!result.valid) {
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
