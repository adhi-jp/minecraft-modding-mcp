import assert from "node:assert/strict";
import test from "node:test";

import { applyMappingPipeline } from "../src/mapping-pipeline-service.ts";
import type { SourceMapping } from "../src/types.ts";

test("applyMappingPipeline keeps mojang for unobfuscated decompiled runtime artifacts", () => {
  const result = applyMappingPipeline({
    requestedMapping: "mojang",
    runtimeNamesUnobfuscated: true,
    target: { kind: "version", value: "26.1" },
    resolved: {
      artifactId: "artifact-unobf-decompiled",
      artifactSignature: "sig",
      origin: "decompiled",
      binaryJarPath: "/tmp/client-26.1.jar",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: [],
      isDecompiled: true,
      resolvedAt: new Date().toISOString()
    }
  });

  assert.deepEqual(result, {
    mappingApplied: "mojang",
    qualityFlags: ["decompiled"],
    transformChain: ["mapping:mojang-runtime-unobfuscated"]
  });
});

test("applyMappingPipeline keeps mojang for unobfuscated source-backed runtime artifacts", () => {
  const result = applyMappingPipeline({
    requestedMapping: "mojang",
    runtimeNamesUnobfuscated: true,
    target: { kind: "version", value: "26.1" },
    resolved: {
      artifactId: "artifact-unobf-source",
      artifactSignature: "sig",
      origin: "local-jar",
      binaryJarPath: "/tmp/client-26.1.jar",
      sourceJarPath: "/tmp/client-26.1-sources.jar",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: [],
      isDecompiled: false,
      resolvedAt: new Date().toISOString()
    }
  });

  assert.deepEqual(result, {
    mappingApplied: "mojang",
    qualityFlags: ["source-backed"],
    transformChain: ["mapping:mojang-runtime-unobfuscated"]
  });
});

test("applyMappingPipeline authorizes binary-remap when mojang lands on binary-only artifact and gate is open", () => {
  const result = applyMappingPipeline({
    requestedMapping: "mojang",
    target: { kind: "version", value: "1.21.10" },
    allowBinaryRemap: true,
    resolved: {
      artifactId: "artifact-binary-only",
      artifactSignature: "sig",
      origin: "decompiled",
      binaryJarPath: "/tmp/client-1.21.10.jar",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: [],
      isDecompiled: true,
      resolvedAt: new Date().toISOString()
    }
  });

  assert.deepEqual(result, {
    mappingApplied: "mojang",
    qualityFlags: ["binary-remapped", "decompiled"],
    transformChain: ["binary-remap:obf->mojang", "decompile:vineflower"]
  });
});

test("applyMappingPipeline still throws MAPPING_NOT_APPLIED when binary-only artifact is missing the gate", () => {
  assert.throws(
    () =>
      applyMappingPipeline({
        requestedMapping: "mojang",
        target: { kind: "version", value: "1.21.10" },
        allowBinaryRemap: false,
        resolved: {
          artifactId: "artifact-binary-only",
          artifactSignature: "sig",
          origin: "decompiled",
          binaryJarPath: "/tmp/client-1.21.10.jar",
          requestedMapping: "mojang",
          mappingApplied: "mojang",
          qualityFlags: [],
          isDecompiled: true,
          resolvedAt: new Date().toISOString()
        }
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ERR_MAPPING_NOT_APPLIED"
      );
    }
  );
});

test("applyMappingPipeline throws MAPPING_UNAVAILABLE for an unsupported mapping kind", () => {
  assert.throws(
    () =>
      applyMappingPipeline({
        // "tsrg" is not a supported SourceMapping. It survives the obfuscated and
        // mojang-runtime pass-throughs, so the pipeline must reject it outright
        // rather than treating it as a source-backed mapping.
        requestedMapping: "tsrg" as unknown as SourceMapping,
        target: { kind: "version", value: "1.21.10" },
        resolved: {
          artifactId: "artifact-unsupported-mapping",
          artifactSignature: "sig",
          origin: "local-jar",
          binaryJarPath: "/tmp/client-1.21.10.jar",
          sourceJarPath: "/tmp/client-1.21.10-sources.jar",
          requestedMapping: "mojang",
          mappingApplied: "mojang",
          qualityFlags: [],
          isDecompiled: false,
          resolvedAt: new Date().toISOString()
        }
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ERR_MAPPING_UNAVAILABLE"
      );
    }
  );
});

test("applyMappingPipeline ignores allowBinaryRemap when binary jar path is also missing", () => {
  assert.throws(
    () =>
      applyMappingPipeline({
        requestedMapping: "mojang",
        target: { kind: "version", value: "1.21.10" },
        allowBinaryRemap: true,
        resolved: {
          artifactId: "artifact-no-binary",
          artifactSignature: "sig",
          origin: "decompiled",
          requestedMapping: "mojang",
          mappingApplied: "mojang",
          qualityFlags: [],
          isDecompiled: true,
          resolvedAt: new Date().toISOString()
        }
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ERR_MAPPING_NOT_APPLIED"
      );
    }
  );
});
