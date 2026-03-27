import assert from "node:assert/strict";
import test from "node:test";

import { applyMappingPipeline } from "../src/mapping-pipeline-service.ts";

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
