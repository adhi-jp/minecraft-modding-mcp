import { validateToolParams } from "./tool-schema-registry.js";

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
    const primary = validateToolParams(spec.tool, primaryParams);
    if (primary.valid) {
      return { suggestedCall: { tool: spec.tool, params: primaryParams } };
    }
  }

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
      return { exampleCalls: validated };
    }
  }

  return {};
}
