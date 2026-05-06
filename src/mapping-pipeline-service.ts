import { buildSuggestedCall } from "./build-suggested-call.js";
import { createError, ERROR_CODES } from "./errors.js";
import type { ResolvedSourceArtifact, SourceMapping, SourceTargetInput } from "./types.js";

export interface MappingPipelineInput {
  requestedMapping: SourceMapping;
  target: SourceTargetInput;
  resolved: ResolvedSourceArtifact;
  runtimeNamesUnobfuscated?: boolean;
  /**
   * When true and the mojang request lands on a binary-only artifact, the pipeline
   * authorizes a downstream tiny-remap (obfuscated -> mojang) followed by decompile
   * instead of throwing MAPPING_NOT_APPLIED. The caller is responsible for
   * pre-resolving tiny-remapper jar, mojang tiny mappings, and verifying mapping
   * health before setting this flag.
   */
  allowBinaryRemap?: boolean;
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
 * - mojang: requires source-backed artifacts on legacy obfuscated versions,
 *   but unobfuscated runtime jars can pass through directly,
 *   or binary-only artifacts may be remapped + decompiled when allowBinaryRemap=true
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

  if (input.requestedMapping === "mojang" && input.runtimeNamesUnobfuscated) {
    transformChain.push("mapping:mojang-runtime-unobfuscated");
    if (input.resolved.isDecompiled) {
      qualityFlags.push("decompiled");
    } else {
      qualityFlags.push("source-backed");
    }
    return {
      mappingApplied: "mojang",
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
    if (
      input.requestedMapping === "mojang" &&
      input.allowBinaryRemap === true &&
      Boolean(input.resolved.binaryJarPath)
    ) {
      transformChain.push("binary-remap:obf->mojang", "decompile:vineflower");
      qualityFlags.push("binary-remapped", "decompiled");
      return {
        mappingApplied: "mojang",
        qualityFlags,
        transformChain
      };
    }
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
        ...buildSuggestedCall({
          tool: "resolve-artifact",
          params: {
            target: input.target,
            mapping: "obfuscated"
          }
        })
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
