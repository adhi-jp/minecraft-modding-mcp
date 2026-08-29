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
import { type SourceServiceFixture } from "../helpers/source-service-fixtures.ts";

test("SourceService resolveWorkspaceSymbol handles representative compile-visible symbol flows", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  type WorkspaceSymbolFixture = {
    root: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createWorkspaceSymbolFixture(rootPrefix: string): Promise<WorkspaceSymbolFixture> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    return {
      root,
      service: new SourceService(buildTestConfig(root))
    };
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<WorkspaceSymbolFixture>;
    run: (fixture: WorkspaceSymbolFixture) => Promise<void>;
  }> = [
    {
      name: "rejects owner for class input",
      createFixture: () =>
        createWorkspaceSymbolFixture("service-workspace-symbol-class-invalid-owner-"),
      run: async ({ root, service }) => {
        await assert.rejects(
          () =>
            (
              service as unknown as {
                resolveWorkspaceSymbol: (input: {
                  projectPath: string;
                  version: string;
                  kind: "class" | "field" | "method";
                  owner?: string;
                  name: string;
                  sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
                }) => Promise<unknown>;
              }
            ).resolveWorkspaceSymbol({
              projectPath: root,
              version: "1.21.10",
              kind: "class",
              owner: "a.b",
              name: "a.b.C",
              sourceMapping: "obfuscated"
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
        );
      }
    },
    {
      name: "applies workspace mapping and returns compile-visible method symbol",
      createFixture: () => createWorkspaceSymbolFixture("service-workspace-symbol-"),
      run: async ({ root, service }) => {
        (service as unknown as { workspaceMappingService: unknown }).workspaceMappingService = {
          async detectCompileMapping() {
            return {
              resolved: true,
              mappingApplied: "mojang",
              warnings: [],
              evidence: [
                {
                  filePath: join(root, "build.gradle"),
                  mapping: "mojang",
                  reason: "officialMojangMappings()"
                }
              ]
            };
          }
        };

        (service as unknown as { mappingService: unknown }).mappingService = {
          async resolveMethodMappingExact(input: {
            targetMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
          }) {
            assert.equal(input.targetMapping, "mojang");
            return {
              querySymbol: {
                kind: "method",
                owner: "a.b.C",
                name: "f",
                descriptor: "(Ljava/lang/String;)V",
                symbol: "a.b.C.f(Ljava/lang/String;)V"
              },
              mappingContext: {
                version: "1.21.10",
                sourceMapping: "obfuscated",
                targetMapping: "mojang",
                sourcePriorityApplied: "loom-first"
              },
              resolved: true,
              status: "resolved",
              resolvedSymbol: {
                kind: "method",
                owner: "com.example.ValueOutput",
                name: "remove",
                descriptor: "(Ljava/lang/String;)V",
                symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V"
              },
              candidates: [
                {
                  kind: "method",
                  owner: "com.example.ValueOutput",
                  name: "remove",
                  descriptor: "(Ljava/lang/String;)V",
                  symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V",
                  matchKind: "exact",
                  confidence: 1
                }
              ],
              warnings: []
            };
          }
        };

        const result = await (
          service as unknown as {
            resolveWorkspaceSymbol: (input: {
              projectPath: string;
              version: string;
              kind: "class" | "field" | "method";
              owner: string;
              name: string;
              descriptor?: string;
              sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
            }) => Promise<{
              resolved: boolean;
              mappingContext: { targetMapping?: string };
              resolvedSymbol?: { name: string; owner?: string; descriptor?: string };
            }>;
          }
        ).resolveWorkspaceSymbol({
          projectPath: root,
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "f",
          descriptor: "(Ljava/lang/String;)V",
          sourceMapping: "obfuscated"
        });

        assert.equal(result.resolved, true);
        assert.equal(result.mappingContext.targetMapping, "mojang");
        assert.equal(result.resolvedSymbol?.name, "remove");
        assert.equal(result.resolvedSymbol?.owner, "com.example.ValueOutput");
        assert.equal(result.resolvedSymbol?.descriptor, "(Ljava/lang/String;)V");
      }
    },
    {
      name: "resolves class via class identity mapping",
      createFixture: () => createWorkspaceSymbolFixture("service-workspace-symbol-class-"),
      run: async ({ root, service }) => {
        (service as unknown as { workspaceMappingService: unknown }).workspaceMappingService = {
          async detectCompileMapping() {
            return {
              resolved: true,
              mappingApplied: "mojang",
              warnings: ["workspace warning"],
              evidence: [
                {
                  filePath: join(root, "build.gradle"),
                  mapping: "mojang",
                  reason: "officialMojangMappings()"
                }
              ]
            };
          }
        };

        (service as unknown as { mappingService: unknown }).mappingService = {
          async getClassApiMatrix(input: {
            className: string;
            classNameMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
            sourcePriority?: "loom-first" | "maven-first";
          }) {
            assert.equal(input.className, "a.b.c");
            assert.equal(input.classNameMapping, "obfuscated");
            assert.equal(input.sourcePriority, "loom-first");
            return {
              classIdentity: {
                obfuscated: "a.b.c",
                mojang: "com.example.valueoutput"
              },
              rows: [],
              warnings: ["matrix warning"]
            };
          },
          async findMapping() {
            throw new Error("findMapping should not be used for kind=class");
          }
        };

        const result = await (
          service as unknown as {
            resolveWorkspaceSymbol: (input: {
              projectPath: string;
              version: string;
              kind: "class" | "field" | "method";
              owner?: string;
              name: string;
              descriptor?: string;
              sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
              sourcePriority?: "loom-first" | "maven-first";
            }) => Promise<{
              resolved: boolean;
              status: string;
              mappingContext: { targetMapping?: string };
              resolvedSymbol?: { name: string };
              warnings: string[];
            }>;
          }
        ).resolveWorkspaceSymbol({
          projectPath: root,
          version: "1.21.10",
          kind: "class",
          name: "a.b.c",
          sourceMapping: "obfuscated",
          sourcePriority: "loom-first"
        });

        assert.equal(result.resolved, true);
        assert.equal(result.status, "resolved");
        assert.equal(result.mappingContext.targetMapping, "mojang");
        assert.equal(result.resolvedSymbol?.name, "com.example.valueoutput");
        assert.deepEqual(result.warnings, ["workspace warning", "matrix warning"]);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await testCase.createFixture());
    });
  }
});

test("SourceService resolveArtifact handles unobfuscated version fallback warnings", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  async function createUnobfuscatedVersionService(rootPrefix: string): Promise<{
    service: SourceServiceFixture;
  }> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const binaryJarPath = join(root, "client-26.1.jar");
    const sourcesJarPath = join(root, "client-26.1-sources.jar");

    await createJar(binaryJarPath, {
      "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });
    await createJar(sourcesJarPath, {
      "net/minecraft/server/Main.java": [
        "package net.minecraft.server;",
        "public class Main {",
        "  void run() {}",
        "}"
      ].join("\n")
    });

    const service = new SourceService(buildTestConfig(root));
    (service as unknown as { versionService: unknown }).versionService = {
      async resolveVersionJar(version: string) {
        return {
          version,
          jarPath: binaryJarPath,
          source: "downloaded" as const,
          clientJarUrl: `https://example.test/${version}.jar`
        };
      }
    };

    return { service };
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    mapping: "obfuscated" | "yarn";
    verify: (result: { requestedMapping: string; mappingApplied: string; warnings: string[] }) => void;
  }> = [
    {
      name: "yarn falls back to obfuscated with warning",
      rootPrefix: "service-unobfuscated-yarn-",
      mapping: "yarn",
      verify: (result) => {
        assert.equal(result.requestedMapping, "obfuscated");
        assert.equal(result.mappingApplied, "obfuscated");
        assert.ok(result.warnings.some((w) => w.includes("unobfuscated") && w.includes("yarn")));
      }
    },
    {
      name: "obfuscated keeps mapping without fallback warning",
      rootPrefix: "service-unobfuscated-obfuscated-",
      mapping: "obfuscated",
      verify: (result) => {
        assert.equal(result.mappingApplied, "obfuscated");
        assert.ok(!result.warnings.some((w) => w.includes("unobfuscated")));
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { service } = await createUnobfuscatedVersionService(testCase.rootPrefix);
      const result = await service.resolveArtifact({
        target: { kind: "version", value: "26.1" },
        mapping: testCase.mapping
      });
      testCase.verify(result);
    });
  }
});

test("SourceService supports mojang mapping on unobfuscated version targets without source jars", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  async function createFixture(rootPrefix: string): Promise<{
    binaryJarPath: string;
    gradleUserHome: string;
    root: string;
    service: SourceServiceFixture;
  }> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const binaryJarPath = join(root, "client-26.1.jar");
    const gradleUserHome = join(root, "gradle-home");

    await createJar(binaryJarPath, {
      "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });

    const service = new SourceService(buildTestConfig(root));
    (service as unknown as { versionService: unknown }).versionService = {
      async resolveVersionJar(version: string) {
        return {
          version,
          jarPath: binaryJarPath,
          source: "downloaded" as const,
          clientJarUrl: `https://example.test/${version}.jar`
        };
      }
    };
    (service as unknown as {
      ingestIfNeeded: (resolved: unknown) => Promise<void>;
    }).ingestIfNeeded = async () => {};

    return { binaryJarPath, gradleUserHome, root, service };
  }

  await t.test("resolveArtifact ignores mismatched Loom sources for unobfuscated versions", async () => {
    const { gradleUserHome, service } = await createFixture("service-unobfuscated-mojang-resolve-");
    const foreignSourceJar = join(
      gradleUserHome,
      "caches",
      "fabric-loom",
      "minecraftMaven",
      "net",
      "minecraft",
      "minecraft-merged",
      "1.21.10",
      "minecraft-merged-1.21.10-sources.jar"
    );

    await createJar(foreignSourceJar, {
      "net/minecraft/world/item/Item.java": [
        "package net.minecraft.world.item;",
        "public class Item {}"
      ].join("\n")
    });

    await withGradleUserHome(gradleUserHome, async () => {
      const result = await service.resolveArtifact({
        target: { kind: "version", value: "26.1" },
        mapping: "mojang"
      });

      assert.equal(result.requestedMapping, "mojang");
      assert.equal(result.mappingApplied, "mojang");
      assert.equal(result.origin, "decompiled");
      assert.equal(result.resolvedSourceJarPath, undefined);
      assert.ok(
        !result.warnings.some((warning) => warning.includes("Resolved source-backed artifact from Loom cache candidate")),
        "Expected unobfuscated 26.1 resolution to skip mismatched Loom source jars."
      );
    });
  });

  await t.test("getClassMembers reads unobfuscated runtime names without remap fallback", async () => {
    const { binaryJarPath, gradleUserHome, service } = await createFixture("service-unobfuscated-mojang-members-");

    (service as unknown as { explorerService: unknown }).explorerService = {
      async getSignature(input: { fqn: string; jarPath: string }) {
        assert.equal(input.fqn, "net.minecraft.world.item.Item");
        assert.equal(input.jarPath, binaryJarPath);
        return {
          constructors: [],
          fields: [
            {
              ownerFqn: "net.minecraft.world.item.Item",
              name: "MAX_STACK_SIZE",
              javaSignature: "public static final int MAX_STACK_SIZE",
              jvmDescriptor: "I",
              accessFlags: 0x0019,
              isSynthetic: false
            }
          ],
          methods: [
            {
              ownerFqn: "net.minecraft.world.item.Item",
              name: "use",
              javaSignature:
                "public net.minecraft.world.InteractionResult use(net.minecraft.world.item.ItemStack)",
              jvmDescriptor: "(Lnet/minecraft/world/item/ItemStack;)Lnet/minecraft/world/InteractionResult;",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          warnings: [],
          context: {
            minecraftVersion: "26.1",
            mappingType: "mojang",
            mappingNamespace: "mojang",
            jarSignature: "hash",
            generatedAt: new Date().toISOString()
          }
        };
      }
    };

    await withGradleUserHome(gradleUserHome, async () => {
      const result = await service.getClassMembers({
        className: "net.minecraft.world.item.Item",
        target: { kind: "version", value: "26.1" },
        mapping: "mojang"
      });

      assert.equal(result.mappingApplied, "mojang");
      assert.equal(result.className, "net.minecraft.world.item.Item");
      assert.equal(result.members.fields[0]?.name, "MAX_STACK_SIZE");
      assert.equal(result.members.methods[0]?.name, "use");
      assert.ok(
        !result.warnings.some((warning) => warning.includes("Could not map class")),
        "Expected unobfuscated 26.1 lookups to avoid remap fallback warnings."
      );
    });
  });
});

test("SourceService checkSymbolExists falls back to unobfuscated runtime bytecode for mojang class queries", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-check-symbol-exists-unobfuscated-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists() {
      return {
        querySymbol: {
          kind: "class",
          name: "net.minecraft.client.Minecraft",
          symbol: "net.minecraft.client.Minecraft"
        },
        mappingContext: {
          version: "26.1",
          sourceMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: ["Version 26.1 is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names."]
      };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, "client-26.1.jar"),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      assert.equal(input.fqn, "net.minecraft.client.Minecraft");
      return {
        constructors: [],
        methods: [],
        fields: [],
        warnings: [],
        context: {
          minecraftVersion: "26.1",
          mappingType: "mojang",
          mappingNamespace: "mojang",
          jarSignature: "hash",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await service.checkSymbolExists({
    version: "26.1",
    kind: "class",
    name: "net.minecraft.client.Minecraft",
    sourceMapping: "mojang"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedSymbol?.name, "net.minecraft.client.Minecraft");
  // Runtime validation surfaces as a structured flag, not a warning sentence.
  assert.equal(
    (result.mappingContext as { runtimeValidated?: boolean }).runtimeValidated,
    true
  );
});

test("SourceService checkSymbolExists keeps mapping_unavailable when unobfuscated runtime jar resolution fails", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-check-symbol-exists-jar-failure-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists() {
      return {
        querySymbol: {
          kind: "class",
          name: "net.minecraft.client.Minecraft",
          symbol: "net.minecraft.client.Minecraft"
        },
        mappingContext: {
          version: "26.1",
          sourceMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: ["Version 26.1 is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names."]
      };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      throw new Error("jar missing");
    }
  };

  const result = await service.checkSymbolExists({
    version: "26.1",
    kind: "class",
    name: "net.minecraft.client.Minecraft",
    sourceMapping: "mojang"
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, "mapping_unavailable");
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]?.includes("mapping graph is empty"));
});

test("SourceService checkSymbolExists reports short unobfuscated class names when nameMode is omitted", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-check-symbol-exists-short-name-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists() {
      return {
        querySymbol: {
          kind: "class",
          name: "Minecraft",
          symbol: "Minecraft"
        },
        mappingContext: {
          version: "26.1",
          sourceMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: ["Version 26.1 is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names."]
      };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      assert.fail("short class names should return a targeted warning before jar resolution");
    }
  };

  const result = await service.checkSymbolExists({
    version: "26.1",
    kind: "class",
    name: "Minecraft",
    sourceMapping: "mojang"
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, "mapping_unavailable");
  assert.ok(result.warnings.some((warning) => warning.includes("short class name")));
});
