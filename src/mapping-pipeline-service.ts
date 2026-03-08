import { createError, ERROR_CODES } from "./errors.js";
import type { ResolvedSourceArtifact, SourceMapping, SourceTargetInput } from "./types.js";

export interface MappingPipelineInput {
  requestedMapping: SourceMapping;
  target: SourceTargetInput;
  resolved: ResolvedSourceArtifact;
}

export interface MappingPipelineResult {
  mappingApplied: SourceMapping;
  qualityFlags: string[];
  transformChain: string[];
}

/**
 * Mapping pipeline for v0.3.
 * Current implementation enforces explicit guarantees:
 * - obfuscated: always pass-through
 * - mojang: requires source-backed artifact; decompile-only artifacts are rejected
 */
export function applyMappingPipeline(input: MappingPipelineInput): MappingPipelineResult {
  const transformChain: string[] = [];
  const qualityFlags: string[] = [];

  if (input.requestedMapping === "obfuscated") {
    transformChain.push("mapping:obfuscated-pass-through");
    if (input.resolved.isDecompiled) {
      qualityFlags.push("decompiled");
    } else {
      qualityFlags.push("source-backed");
    }
    return {
      mappingApplied: "obfuscated",
      qualityFlags,
      transformChain
    };
  }

  if (
    input.requestedMapping !== "mojang" &&
    input.requestedMapping !== "intermediary" &&
    input.requestedMapping !== "yarn"
  ) {
    throw createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: `Unsupported mapping "${input.requestedMapping}".`,
      details: {
        requestedMapping: input.requestedMapping,
        target: input.target
      }
    });
  }

  const hasSource = Boolean(input.resolved.sourceJarPath);
  if (!hasSource) {
    throw createError({
      code: ERROR_CODES.MAPPING_NOT_APPLIED,
      message:
        `Requested ${input.requestedMapping} mapping cannot be guaranteed for this artifact because only decompile path is available.`,
      details: {
        requestedMapping: input.requestedMapping,
        target: input.target,
        origin: input.resolved.origin,
        artifactOrigin: input.resolved.origin,
        binaryJarPath: input.resolved.binaryJarPath,
        sourceJarPath: input.resolved.sourceJarPath,
        nextAction: "Provide a source-backed artifact (source jar) or use mapping=obfuscated.",
        suggestedCall: {
          tool: "resolve-artifact",
          params: {
            target: input.target,
            mapping: "obfuscated"
          }
        }
      }
    });
  }

  transformChain.push(`mapping:${input.requestedMapping}-source-backed`);
  qualityFlags.push("source-backed");
  return {
    mappingApplied: input.requestedMapping,
    qualityFlags,
    transformChain
  };
}
