import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { withGradleUserHome } from "./helpers/env.ts";
import { seedIndexedArtifact } from "./helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "./helpers/source-service-metrics.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

test("SourceService getClassMembers with mojang mapping remaps className and member names", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService diffClassSignatures with non-obfuscated mapping remaps member deltas", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-remap-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
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
    async getSignature(input: { fqn: string; jarPath: string }) {
      // Should receive obfuscated name
      assert.equal(input.fqn, "net.minecraft.server.Main");
      const version = input.jarPath.includes("1.0.0") ? "1.0.0" : "1.0.1";
      if (version === "1.0.0") {
        return {
          constructors: [],
          fields: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "f_old",
              javaSignature: "public int f_old",
              jvmDescriptor: "I",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          methods: [],
          warnings: []
        };
      }
      return {
        constructors: [],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "f_new",
            javaSignature: "public int f_new",
            jvmDescriptor: "I",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [],
        warnings: []
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      if (input.kind === "class" && input.name === "net.minecraft.server.IntermediaryMain" && input.targetMapping === "obfuscated") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" }, warnings: [] };
      }
      if (input.kind === "class" && input.name === "net.minecraft.server.Main" && input.targetMapping === "intermediary") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.IntermediaryMain" }, warnings: [] };
      }
      if (input.kind === "field" && input.name === "f_old" && input.targetMapping === "intermediary") {
        return { resolved: true, resolvedSymbol: { name: "field_1234" }, warnings: [] };
      }
      if (input.kind === "field" && input.name === "f_new" && input.targetMapping === "intermediary") {
        return { resolved: true, resolvedSymbol: { name: "field_5678" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    diffClassSignatures: (input: {
      className: string;
      fromVersion: string;
      toVersion: string;
      mapping: "intermediary";
    }) => Promise<{
      query: { className: string; mapping: string };
      fields: {
        added: Array<{ name: string; ownerFqn: string }>;
        removed: Array<{ name: string; ownerFqn: string }>;
      };
    }>;
  }).diffClassSignatures({
    className: "net.minecraft.server.IntermediaryMain",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    mapping: "intermediary"
  });

  // Query should echo user's input
  assert.equal(result.query.className, "net.minecraft.server.IntermediaryMain");
  assert.equal(result.query.mapping, "intermediary");
  // Added members should be remapped
  assert.equal(result.fields.added.length, 1);
  assert.equal(result.fields.added[0].name, "field_5678");
  assert.equal(result.fields.added[0].ownerFqn, "net.minecraft.server.IntermediaryMain");
  // Removed members should be remapped
  assert.equal(result.fields.removed.length, 1);
  assert.equal(result.fields.removed[0].name, "field_1234");
  assert.equal(result.fields.removed[0].ownerFqn, "net.minecraft.server.IntermediaryMain");
});

test("SourceService diffClassSignatures remaps non-obfuscated class per endpoint version", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-versioned-map-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));
  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
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
    async getSignature(input: { fqn: string; jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }
      if (version === "1.0.0") {
        if (input.fqn !== "net.minecraft.server.OldMain") {
          throw Object.assign(new Error("class not found"), { code: ERROR_CODES.CLASS_NOT_FOUND });
        }
      } else if (input.fqn !== "net.minecraft.server.NewMain") {
        throw Object.assign(new Error("class not found"), { code: ERROR_CODES.CLASS_NOT_FOUND });
      }
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: []
      };
    }
  };

  const mappingCalls: Array<{ version: string; sourceMapping: string; targetMapping: string; name: string }> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { version: string; sourceMapping: string; targetMapping: string; name: string }) {
      mappingCalls.push({
        version: input.version,
        sourceMapping: input.sourceMapping,
        targetMapping: input.targetMapping,
        name: input.name
      });
      if (
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "obfuscated" &&
        input.name === "net.minecraft.server.InterMain" &&
        input.version === "1.0.0"
      ) {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OldMain" }, warnings: [] };
      }
      if (
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "obfuscated" &&
        input.name === "net.minecraft.server.InterMain" &&
        input.version === "1.0.1"
      ) {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.NewMain" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    diffClassSignatures: (input: {
      className: string;
      fromVersion: string;
      toVersion: string;
      mapping: "intermediary";
    }) => Promise<{
      classChange: string;
      summary: { total: { added: number; removed: number; modified: number } };
    }>;
  }).diffClassSignatures({
    className: "net.minecraft.server.InterMain",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    mapping: "intermediary"
  });

  assert.equal(result.classChange, "present_in_both");
  assert.deepEqual(result.summary.total, { added: 0, removed: 0, modified: 0 });
  assert.ok(
    mappingCalls.some(
      (call) =>
        call.version === "1.0.0" &&
        call.sourceMapping === "intermediary" &&
        call.targetMapping === "obfuscated" &&
        call.name === "net.minecraft.server.InterMain"
    )
  );
  assert.ok(
    mappingCalls.some(
      (call) =>
        call.version === "1.0.1" &&
        call.sourceMapping === "intermediary" &&
        call.targetMapping === "obfuscated" &&
        call.name === "net.minecraft.server.InterMain"
    )
  );
});

test("SourceService getClassMembers with obfuscated mapping is unchanged (regression)", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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
  const { SourceService } = await import("../src/source-service.ts");
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
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService listArtifactFiles explains that indexed artifacts do not include resources", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-list-files-diagnostics-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "source-only-artifact",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed"],
    files: [
      {
        filePath: "net/minecraft/world/item/Item.java",
        content: "package net.minecraft.world.item;\npublic class Item {}"
      }
    ],
    symbols: [
      {
        filePath: "net/minecraft/world/item/Item.java",
        symbolKind: "class",
        symbolName: "Item",
        qualifiedName: "net.minecraft.world.item.Item",
        line: 2
      }
    ],
    sourceJarPath: join(root, "minecraft-sources.jar"),
    binaryJarPath: join(root, "minecraft.jar"),
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: {
        origin: "local-jar",
        sourceJarPath: join(root, "minecraft-sources.jar"),
        binaryJarPath: join(root, "minecraft.jar"),
        version: "1.21.10"
      },
      transformChain: ["mapping:mojang-source-backed"]
    }
  });

  const result = await service.listArtifactFiles({
    artifactId: "source-only-artifact",
    prefix: "assets/minecraft/"
  });

  assert.deepEqual(result.items, []);
  assert.equal(result.mappingApplied, "mojang");
  assert.equal(result.artifactContents.resourcesIncluded, false);
  assert.equal(result.artifactContents.sourceKind, "source-jar");
  assert.equal(result.artifactContents.sourceCoverage, "full");
  assert.ok(result.artifactContents.indexedContentKinds.includes("java-source"));
  assert.ok(result.warnings.some((warning) => warning.includes("resources") && warning.includes("not indexed")));
});

test("SourceService getClassMembers mapping fallback keeps original name and emits warning", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-fallback-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Unknown",
            name: "unknownMethod",
            javaSignature: "public void unknownMethod()",
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
    async findMapping() {
      // Always fail to resolve
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "test-fallback",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: join(root, "1.21.4.jar"),
    version: "1.21.4",
    requestedMapping: "yarn" as const,
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
      mapping: "yarn";
    }) => Promise<{
      className: string;
      members: { methods: Array<{ name: string }> };
      warnings: string[];
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.Unknown",
    target: { kind: "version", value: "1.21.4" },
    mapping: "yarn"
  });

  // Original name should be used as fallback
  assert.equal(result.members.methods[0].name, "unknownMethod");
  // Warnings should indicate mapping failures
  assert.ok(result.warnings.some((w) => w.includes("Could not remap")));
});

test("SourceService getClassMembers populates decompiledFallback when bytecode enumeration returns zero but decompiled source is indexed", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-fallback",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "net/minecraft/world/entity/player/Player.java",
        content: [
          "package net.minecraft.world.entity.player;",
          "public class Player {",
          "  int experienceLevel = 0;",
          "  public Player() {}",
          "  public void addAdditionalSaveData() {}",
          "  public int getHealth() { return 20; }",
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
    artifactId: "artifact-decompiled-fallback",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang"
  });

  assert.equal(result.counts.total, 0);
  assert.ok(result.decompiledFallback, "decompiledFallback should be populated");
  assert.equal(result.decompiledFallback?.origin, "source-extracted");
  assert.ok(
    result.decompiledFallback!.constructors.some((m) => m.name === "<init>"),
    "constructors should include <init> entry"
  );
  assert.ok(
    result.decompiledFallback!.methods.some((m) => m.name === "addAdditionalSaveData"),
    "methods should include addAdditionalSaveData"
  );
  assert.ok(
    result.decompiledFallback!.fields.some((m) => m.name === "experienceLevel"),
    "fields should include experienceLevel"
  );
  assert.ok(result.qualityFlags.includes("members-from-decompiled-source"));
  assert.ok(result.decompiledMemberCounts, "decompiledMemberCounts should be populated");
  assert.ok(result.decompiledMemberCounts!.total > 0);
  assert.ok(
    result.warnings.some((warning) => warning.includes("decompiledFallback")),
    "should include a warning about decompiledFallback"
  );
});

test("SourceService getClassMembers applies memberPattern to decompiledFallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-pattern-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-fallback-pattern",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "net/minecraft/world/entity/player/Player.java",
        content: [
          "package net.minecraft.world.entity.player;",
          "public class Player {",
          "    public void addAdditionalSaveData() {}",
          "    public void readAdditionalSaveData() {}",
          "    public void tick() {}",
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
    artifactId: "artifact-decompiled-fallback-pattern",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang",
    memberPattern: "SaveData"
  });

  assert.ok(result.decompiledFallback, "decompiledFallback should be populated");
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  assert.deepEqual(
    methodNames.sort(),
    ["addAdditionalSaveData", "readAdditionalSaveData"].sort()
  );
  assert.equal(
    result.decompiledFallback!.methods.some((m) => m.name === "tick"),
    false,
    "pattern-mismatched methods should be filtered out"
  );
});

test("SourceService getClassMembers scopes decompiledFallback to the requested class body, excluding nested types", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-inner-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-inner",
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
          "  int outerField = 0;",
          "  public void outerMethod() {}",
          "  public static class Inner {",
          "    int innerField = 1;",
          "    public void innerMethod() {}",
          "  }",
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
    artifactId: "artifact-decompiled-inner",
    className: "com.example.Outer",
    mapping: "mojang"
  });

  assert.ok(result.decompiledFallback, "decompiledFallback should be populated for outer class");
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  const fieldNames = result.decompiledFallback!.fields.map((m) => m.name);
  assert.ok(methodNames.includes("outerMethod"), "should include outerMethod");
  assert.equal(
    methodNames.includes("innerMethod"),
    false,
    `innerMethod must not leak into outer class's fallback; got methods=${JSON.stringify(methodNames)}`
  );
  assert.ok(fieldNames.includes("outerField"), "should include outerField");
  assert.equal(
    fieldNames.includes("innerField"),
    false,
    `innerField must not leak into outer class's fallback; got fields=${JSON.stringify(fieldNames)}`
  );
});

test("SourceService getClassMembers keeps outer members declared after a nested type", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService getClassMembers uses the artifact-namespace lookup name when building decompiledFallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-ns-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  // Artifact is indexed in obfuscated namespace (file path uses obf name).
  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-ns",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "czl/czl.java",
        content: [
          "package czl;",
          "public class czl {",
          "  int f = 0;",
          "  public void m() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  // Mapping service translates mojang FQCN → obf for the lookup.
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(request: { name: string; sourceMapping: string; targetMapping: string }) {
      if (request.sourceMapping === "mojang" && request.targetMapping === "obfuscated") {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { kind: "class", name: "czl.czl", symbol: "czl.czl" },
          candidates: [],
          warnings: []
        };
      }
      return {
        resolved: false,
        status: "not_found",
        candidates: [],
        warnings: []
      };
    }
  };

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
    artifactId: "artifact-decompiled-ns",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang"
  });

  assert.ok(
    result.decompiledFallback,
    `decompiledFallback should be populated when filesRepo is indexed under artifact namespace; mappingApplied=${result.mappingApplied}`
  );
  assert.ok(
    result.decompiledFallback!.methods.some((m) => m.name === "m"),
    "artifact-namespace method name should surface in fallback"
  );
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("obfuscated") && warning.includes("mojang")
    ),
    `fallback warning should disclose the namespace mismatch, got: ${JSON.stringify(result.warnings)}`
  );
});

test("SourceService getClassMembers excludes method calls and local variables from decompiledFallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-body-depth-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-body-depth",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "com/example/Demo.java",
        content: [
          "package com.example;",
          "public class Demo {",
          "  int realField = 0;",
          "  public void realMethod() {",
          "    int localVar = 0;",
          "    this.helperCall();",
          "  }",
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
    artifactId: "artifact-body-depth",
    className: "com.example.Demo",
    mapping: "mojang"
  });

  assert.ok(result.decompiledFallback);
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  const fieldNames = result.decompiledFallback!.fields.map((m) => m.name);
  assert.ok(methodNames.includes("realMethod"), "realMethod should be present");
  assert.equal(
    methodNames.some((name) => name === "helperCall"),
    false,
    `method-body call should not be reported as a member; got methods=${JSON.stringify(methodNames)}`
  );
  assert.ok(fieldNames.includes("realField"), "realField should be present");
  assert.equal(
    fieldNames.includes("localVar"),
    false,
    `local variables must not be reported as fields; got fields=${JSON.stringify(fieldNames)}`
  );
});

test("SourceService getClassMembers skips memberPattern on fallback when namespaces mismatch and warns", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-pattern-ns-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-pattern-ns",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "czl/czl.java",
        content: [
          "package czl;",
          "public class czl {",
          "  public void a() {}",
          "  public void b() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(request: { name: string; sourceMapping: string; targetMapping: string }) {
      if (request.sourceMapping === "mojang" && request.targetMapping === "obfuscated") {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { kind: "class", name: "czl.czl", symbol: "czl.czl" },
          candidates: [],
          warnings: []
        };
      }
      return { resolved: false, status: "not_found", candidates: [], warnings: [] };
    }
  };

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
    artifactId: "artifact-pattern-ns",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang",
    memberPattern: "SaveData"
  });

  assert.ok(
    result.decompiledFallback,
    `decompiledFallback should populate even when requested-namespace memberPattern would have filtered obf names; ${JSON.stringify(result.warnings)}`
  );
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  assert.ok(methodNames.includes("a") && methodNames.includes("b"), `artifact-namespace members must be present, got=${JSON.stringify(methodNames)}`);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("memberPattern=\"SaveData\"") && warning.includes("not applied")
    ),
    `should warn about pattern skip, got: ${JSON.stringify(result.warnings)}`
  );
});

test("SourceService getClassMembers does not populate decompiledFallback when bytecode enumeration already has entries", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-no-fallback-needed-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-no-fallback",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    files: [
      {
        filePath: "net/minecraft/server/Main.java",
        content: [
          "package net.minecraft.server;",
          "public class Main {",
          "    public void extraMethod() {}",
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
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "main",
            javaSignature: "public static void main(String[])",
            jvmDescriptor: "([Ljava/lang/String;)V",
            accessFlags: 0x0009,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: "artifact-no-fallback",
    className: "net.minecraft.server.Main",
    mapping: "obfuscated"
  });

  assert.equal(result.counts.total, 1);
  assert.equal(result.decompiledFallback, undefined);
  assert.equal(result.qualityFlags.includes("members-from-decompiled-source"), false);
});

test("SourceService getClassMembers projects decompiledFallback members per projection", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-projection-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-projection",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "net/minecraft/world/entity/player/Player.java",
        content: [
          "package net.minecraft.world.entity.player;",
          "public class Player {",
          "    public void addAdditionalSaveData() {}",
          "    public void tick() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return { constructors: [], fields: [], methods: [], warnings: [], context: { classExistedInJar: true } };
    }
  };

  // projection="names": decompiledFallback members carry only `name` (no line/kind).
  const names = await service.getClassMembers({
    artifactId: "artifact-decompiled-projection",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang",
    projection: "names"
  });
  assert.ok(names.decompiledFallback, "decompiledFallback should be populated");
  assert.ok(names.decompiledFallback!.methods.length > 0);
  for (const member of names.decompiledFallback!.methods) {
    assert.deepEqual(Object.keys(member).sort(), ["name"], `names projection must drop line/kind: ${JSON.stringify(member)}`);
  }

  // projection="full" (default): decompiledFallback keeps the full member shape.
  const full = await service.getClassMembers({
    artifactId: "artifact-decompiled-projection",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang",
    projection: "full"
  });
  const fullMember = full.decompiledFallback!.methods[0];
  assert.ok("line" in fullMember && "kind" in fullMember, "full projection keeps line and kind");
});

test("SourceService getClassMembers applies '|'-OR memberPattern to decompiledFallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-or-pattern-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-or",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "net/minecraft/world/level/block/Block.java",
        content: [
          "package net.minecraft.world.level.block;",
          "public class Block {",
          "    public void getStateForPlacement() {}",
          "    public void canSurvive() {}",
          "    public void unrelated() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return { constructors: [], fields: [], methods: [], warnings: [], context: { classExistedInJar: true } };
    }
  };

  const result = await service.getClassMembers({
    artifactId: "artifact-decompiled-or",
    className: "net.minecraft.world.level.block.Block",
    mapping: "mojang",
    memberPattern: "getStateForPlacement|canSurvive"
  });
  assert.ok(result.decompiledFallback, "decompiledFallback should be populated");
  assert.deepEqual(
    result.decompiledFallback!.methods.map((m) => m.name).sort(),
    ["canSurvive", "getStateForPlacement"]
  );
});
