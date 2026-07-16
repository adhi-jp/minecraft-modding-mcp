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

test("SourceService getClassMembers mapping fallback keeps original name and emits warning", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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

test("SourceService getClassMembers uses the artifact-namespace lookup name when building decompiledFallback", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
