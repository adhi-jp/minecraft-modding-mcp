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
  /**
   * Set to `true` when the caller supplied a `params` object but it failed
   * schema validation (so no `suggestedCall` was emitted). Construction sites
   * spread this output into their AppError `details`; the central extractor
   * in `mapErrorToProblem` reads the marker to decide whether to append the
   * "suggested call payload failed schema validation" hint to `error.hints`.
   * Never appears in published envelopes — `mapErrorToProblem` strips it.
   */
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
    // Unknown-tool fail-open: when the registry has no schema for this tool
    // name, the gate cannot judge the payload and passes it through. Common
    // when tests exercise services without booting `src/index.ts`'s schema
    // registrations (the registry is a process-wide singleton populated at
    // startup). Production loads index.ts and every tool is known.
    if (!getToolSchema(spec.tool)) {
      return { suggestedCall: { tool: spec.tool, params: primaryParams } };
    }
    const primary = validateToolParams(spec.tool, primaryParams);
    if (primary.valid) {
      return { suggestedCall: { tool: spec.tool, params: primaryParams } };
    }
  }

  // Caller supplied a primary but it failed validation (or is malformed).
  // Track the drop so downstream emitters can surface the fallback hint.
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
