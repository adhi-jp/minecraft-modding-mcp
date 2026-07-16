import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withGradleUserHome } from "../helpers/env.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "../helpers/source-service-metrics.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

test("SourceService getClassMembers with mojang mapping remaps className and member names", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-mojang-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      // Should receive obfuscated name after mapping
      assert.equal(input.fqn, "net.minecraft.server.Main");
      return {
        constructors: [],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "f_1234",
            javaSignature: "public int f_1234",
            jvmDescriptor: "I",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "m_5678",
            javaSignature: "public void m_5678()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      // Class mapping: mojang -> obfuscated
      if (input.kind === "class" && input.name === "net.minecraft.server.MojangMain" && input.targetMapping === "obfuscated") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" }, warnings: [] };
      }
      // Field mapping: obfuscated -> mojang
      if (input.kind === "field" && input.name === "f_1234" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "serverPort" }, warnings: [] };
      }
      // Method mapping: obfuscated -> mojang
      if (input.kind === "method" && input.name === "m_5678" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "tickServer" }, warnings: [] };
      }
      // Owner class mapping: obfuscated -> mojang
      if (input.kind === "class" && input.name === "net.minecraft.server.Main" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.MojangMain" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  // Stub resolveArtifact to return a versioned artifact
  const originalResolveArtifact = (service as unknown as {
    resolveArtifact: (input: unknown) => Promise<unknown>;
  }).resolveArtifact.bind(service);

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async (input: unknown) => {
    return {
      artifactId: "test-artifact-id",
      origin: "local-jar" as const,
      isDecompiled: false,
      binaryJarPath: join(root, "1.21.4.jar"),
      version: "1.21.4",
      requestedMapping: "mojang" as const,
      mappingApplied: "obfuscated" as const,
      provenance: {
        target: { kind: "version" as const, value: "1.21.4" },
        resolvedAt: new Date().toISOString(),
        resolvedFrom: { origin: "local-jar" as const },
        transformChain: []
      },
      qualityFlags: [],
      warnings: []
    };
  };

  const result = await (service as unknown as {
    getClassMembers: (input: {
      className: string;
      target: { kind: "version"; value: string };
      mapping: "mojang";
    }) => Promise<{
      className: string;
      mappingApplied: string;
      members: {
        ownerFqn?: string;
        fields: Array<{ name: string; ownerFqn?: string }>;
        methods: Array<{ name: string; ownerFqn?: string }>;
      };
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.MojangMain",
    target: { kind: "version", value: "1.21.4" },
    mapping: "mojang"
  });

  // className should echo user's original input
  assert.equal(result.className, "net.minecraft.server.MojangMain");
  assert.equal(result.mappingApplied, "obfuscated");
  // Member names should be remapped to mojang
  assert.equal(result.members.fields[0].name, "serverPort");
  assert.equal(result.members.methods[0].name, "tickServer");
  // All members share one owner (non-inherited), so ownerFqn is hoisted to the
  // block level (in the requested mojang namespace) and dropped per member.
  assert.equal(result.members.ownerFqn, "net.minecraft.server.MojangMain");
  assert.equal(result.members.fields[0].ownerFqn, undefined);
  assert.equal(result.members.methods[0].ownerFqn, undefined);
});

test("SourceService getClassMembers with non-obfuscated mapping applies memberPattern post-remap", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-pattern-remap-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { memberPattern?: string }) {
      // memberPattern should NOT be passed for non-obfuscated mapping
      assert.equal(input.memberPattern, undefined);
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "m_1111",
            javaSignature: "public void m_1111()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "m_2222",
            javaSignature: "public void m_2222()",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; targetMapping: string }) {
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { name: input.name }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "m_1111" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "tickServer" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "m_2222" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "saveWorld" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "test-pattern",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: join(root, "1.21.4.jar"),
    version: "1.21.4",
    requestedMapping: "mojang" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "version" as const, value: "1.21.4" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar" as const },
      transformChain: []
    },
    qualityFlags: [],
    warnings: []
  });

  const result = await (service as unknown as {
    getClassMembers: (input: {
      className: string;
      target: { kind: "version"; value: string };
      mapping: "mojang";
      memberPattern: string;
    }) => Promise<{
      members: { methods: Array<{ name: string }> };
      counts: { methods: number; total: number };
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.Main",
    target: { kind: "version", value: "1.21.4" },
    mapping: "mojang",
    memberPattern: "tick"
  });

  // Only "tickServer" should match "tick" pattern; "saveWorld" should be filtered out
  assert.equal(result.members.methods.length, 1);
  assert.equal(result.members.methods[0].name, "tickServer");
  assert.equal(result.counts.methods, 1);
  assert.equal(result.counts.total, 1);
});

test("SourceService getClassMembers with obfuscated mapping is unchanged (regression)", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-obfuscated-regression-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; memberPattern?: string }) {
      // For obfuscated mapping, memberPattern should be passed through
      assert.equal(input.memberPattern, "tick");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tick",
            javaSignature: "public void tick()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "test-obfuscated",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: join(root, "1.21.4.jar"),
    version: "1.21.4",
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "version" as const, value: "1.21.4" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar" as const },
      transformChain: []
    },
    qualityFlags: [],
    warnings: []
  });

  const result = await (service as unknown as {
    getClassMembers: (input: {
      className: string;
      target: { kind: "version"; value: string };
      memberPattern: string;
    }) => Promise<{
      className: string;
      mappingApplied: string;
      members: { methods: Array<{ name: string }> };
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.Main",
    target: { kind: "version", value: "1.21.4" },
    memberPattern: "tick"
  });

  assert.equal(result.className, "net.minecraft.server.Main");
  assert.equal(result.mappingApplied, "obfuscated");
  assert.equal(result.members.methods.length, 1);
  assert.equal(result.members.methods[0].name, "tick");
});

test("SourceService getClassMembers looks up bytecode using the resolved artifact namespace", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-lookup-namespace-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "merged-mojang",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath,
    version: "1.21.10",
    requestedMapping: "mojang" as const,
    mappingApplied: "mojang" as const,
    provenance: {
      target: { kind: "version" as const, value: "1.21.10" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar" as const, binaryJarPath, version: "1.21.10" },
      transformChain: ["mapping:mojang-source-backed"]
    },
    qualityFlags: ["source-backed"],
    warnings: []
  });

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { sourceMapping: string; targetMapping: string; name: string }) {
      if (
        input.sourceMapping === "mojang" &&
        input.targetMapping === "obfuscated" &&
        input.name === "net.minecraft.world.item.Item"
      ) {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { name: "dhl" },
          candidates: [],
          warnings: []
        };
      }
      return { resolved: false, status: "not_found", candidates: [], warnings: [] };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      assert.equal(input.jarPath, binaryJarPath);
      assert.equal(input.fqn, "net.minecraft.world.item.Item");
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: {
          minecraftVersion: "1.21.10",
          mappingType: "mojang",
          mappingNamespace: "mojang",
          jarHash: "hash",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await service.getClassMembers({
    className: "net.minecraft.world.item.Item",
    target: { kind: "version", value: "1.21.10" },
    mapping: "mojang"
  });

  assert.equal(result.mappingApplied, "mojang");
  assert.equal(result.className, "net.minecraft.world.item.Item");
});

test("SourceService getClassMembers infers missing artifact version from projectPath when preferred", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-project-version-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-without-version",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    files: [],
    symbols: []
  });

  let detectedProjectPath: string | undefined;
  (service as unknown as { workspaceMappingService: unknown }).workspaceMappingService = {
    async detectProjectMinecraftVersion(projectPath: string) {
      detectedProjectPath = projectPath;
      return "1.21.10";
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { sourceMapping: string; targetMapping: string; name: string; version: string }) {
      assert.equal(input.version, "1.21.10");
      assert.equal(input.sourceMapping, "mojang");
      assert.equal(input.targetMapping, "obfuscated");
      assert.equal(input.name, "net.minecraft.world.item.Item");
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: { name: "dhl" },
        candidates: [],
        warnings: []
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      assert.equal(input.fqn, "dhl");
      assert.equal(input.jarPath, binaryJarPath);
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: {
          minecraftVersion: "1.21.10",
          mappingType: "obfuscated",
          mappingNamespace: "obfuscated",
          jarHash: "hash",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: "artifact-without-version",
    className: "net.minecraft.world.item.Item",
    mapping: "mojang",
    projectPath: root,
    preferProjectVersion: true
  });

  assert.equal(detectedProjectPath, root);
  assert.equal(result.counts.total, 0);
  assert.equal(result.requestedMapping, "mojang");
});

test("SourceService getClassMembers keeps outer members declared after a nested type", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-after-inner-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-after-inner",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "com/example/Outer.java",
        content: [
          "package com.example;",
          "public class Outer {",
          "  int before = 0;",
          "  public static class Inner {",
          "    int innerField = 1;",
          "    public void innerMethod() {}",
          "  }",
          "  int after = 2;",
          "  public void afterInner() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: "artifact-after-inner",
    className: "com.example.Outer",
    mapping: "mojang"
  });

  assert.ok(result.decompiledFallback);
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  const fieldNames = result.decompiledFallback!.fields.map((m) => m.name);
  assert.ok(methodNames.includes("afterInner"), `afterInner should be kept; got methods=${JSON.stringify(methodNames)}`);
  assert.equal(methodNames.includes("innerMethod"), false, "innerMethod must not leak");
  assert.ok(fieldNames.includes("before"), "before field should be kept");
  assert.ok(fieldNames.includes("after"), `after field should be kept; got fields=${JSON.stringify(fieldNames)}`);
  assert.equal(fieldNames.includes("innerField"), false, "innerField must not leak");
});
