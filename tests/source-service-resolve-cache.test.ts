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
import {
  type CacheAccountingRepo,
  type CacheFixtureArtifact,
  type CacheFixtureArtifactInput,
  type SourceServiceFixture,
  computeSourceEntriesBytes,
  createCacheAccountingFixture,
  defaultBinaryEntriesFor,
  instrumentCacheAccountingRepo
} from "./helpers/source-service-fixtures.ts";

test("SourceService resolves/searches/reads class source through artifactId flow", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-main-"));
  const binaryJarPath = join(root, "server-1.0.0.jar");
  const sourcesJarPath = join(root, "server-1.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/world/World.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "import net.minecraft.world.World;",
      "public class Main {",
      "  void tickServer() {",
      "    World.update();",
      "  }",
      "}"
    ].join("\n"),
    "net/minecraft/world/World.java": [
      "package net.minecraft.world;",
      "public class World {",
      "  static void update() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  assert.equal(resolved.isDecompiled, false);
  assert.equal(resolved.origin, "local-jar");
  assert.equal(resolved.requestedMapping, "obfuscated");
  assert.equal(resolved.mappingApplied, "obfuscated");
  assert.equal(resolved.provenance.target.kind, "jar");
  assert.equal(resolved.provenance.target.value, binaryJarPath);
  // The resolver picks the sibling sources jar as canonical when present, so
  // the readable token reflects the resolver-canonical path (server-1.0.0-sources)
  // rather than the caller's request value (server-1.0.0.jar). This is the
  // canonical-alias contract: alias derives from the artifact
  // row, not from the user's request spelling.
  assert.match(
    resolved.artifactAlias,
    /^jar-server-1-0-0-sources-[0-9a-f]{12}$/,
    "artifactAlias must be canonical (no mapping/scope tokens) and 1:1 with artifactId"
  );
  assert.equal(resolved.artifactAlias.endsWith(resolved.artifactId.slice(0, 12)), true);

  // The repo lookup must accept the alias just like the artifactId.
  const lookedUpByAlias = await service.searchClassSource({
    artifactId: resolved.artifactAlias,
    query: "tickServer",
    intent: "symbol",
    match: "exact",
    limit: 5
  });
  assert.ok(lookedUpByAlias.hits.length >= 1);

  const searched = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "tickServer",
    intent: "symbol",
    match: "exact",
    limit: 5
  });
  assert.ok(searched.hits.length >= 1);
  assert.equal(searched.hits[0]?.symbol?.symbolName, "tickServer");
  assert.equal("snippet" in (searched.hits[0] ?? {}), false);
  assert.equal("startLine" in (searched.hits[0] ?? {}), false);
  assert.equal("endLine" in (searched.hits[0] ?? {}), false);
  assert.equal("relations" in searched, false);
  assert.equal("totalApprox" in searched, false);
  assert.equal(searched.mappingApplied, "obfuscated");

  const textRegexSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "tick[A-Za-z]+",
    intent: "text",
    match: "regex",
    limit: 5
  });
  assert.ok(textRegexSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/Main.java"));
  assert.equal(textRegexSearch.mappingApplied, "obfuscated");

  const file = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "net/minecraft/server/Main.java"
  });
  assert.match(file.content, /class Main/);
  assert.equal(file.mappingApplied, "obfuscated");

  const classSource = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main"
  });
  assert.equal(classSource.mode, "metadata");
  assert.equal(classSource.mappingApplied, "obfuscated");
  assert.match(classSource.sourceText, /tickServer/);
  assert.equal(classSource.provenance.target.kind, "jar");
});

test("SourceService getArtifactFile truncation preserves UTF-8 boundaries", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-get-file-utf8-"));
  const binaryJarPath = join(root, "utf8.jar");
  const sourcesJarPath = join(root, "utf8-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/Utf8.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "com/example/Utf8.java": "public class Utf8 { String s = \"é漢😀\"; }"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const full = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "com/example/Utf8.java"
  });
  const cleanBoundaryBytes = Buffer.byteLength("public class Utf8 { String s = \"é漢", "utf8");
  const targetBytes = cleanBoundaryBytes + 2;
  assert.ok(targetBytes < full.contentBytes);

  const truncated = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "com/example/Utf8.java",
    maxBytes: targetBytes
  });

  assert.equal(truncated.truncated, true);
  assert.equal(Buffer.byteLength(truncated.content, "utf8"), cleanBoundaryBytes);
  assert.ok(Buffer.byteLength(truncated.content, "utf8") < targetBytes);
  assert.doesNotMatch(truncated.content, /�/);
  assert.equal(Buffer.from(truncated.content, "utf8").toString("utf8"), truncated.content);
});

test("SourceService getClassMembers uses sibling binary jar when artifact is resolved from a source jar input", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-source-input-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {}"
    ].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  assert.equal(resolved.binaryJarPath, binaryJarPath);

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { jarPath: string; fqn: string }) {
      assert.equal(input.jarPath, binaryJarPath);
      assert.equal(input.fqn, "net.minecraft.world.item.Item");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.world.item.Item",
            name: "use",
            javaSignature: "public void use()",
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

  const result = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated"
  });

  assert.equal(result.members.methods[0]?.name, "use");
});

test("SourceService getClassMembers paginates with a stable nextCursor and rejects foreign cursors", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-page-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": ["package net.minecraft.world.item;", "public class Item {}"].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  const makeMethod = (i: number) => ({
    ownerFqn: "net.minecraft.world.item.Item",
    name: `method${i}`,
    javaSignature: `public void method${i}()`,
    jvmDescriptor: "()V",
    accessFlags: 0x0001,
    isSynthetic: false
  });
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [0, 1, 2, 3, 4].map(makeMethod),
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const names = (page: { members: { methods: Array<{ name: string }> } }) => page.members.methods.map((m) => m.name);

  const page1 = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated",
    maxMembers: 2
  });
  assert.equal(page1.counts.total, 5);
  assert.deepEqual(names(page1), ["method0", "method1"]);
  assert.equal(page1.truncated, true);
  assert.ok(page1.nextCursor, "page 1 must carry a continuation cursor");

  const page2 = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated",
    maxMembers: 2,
    cursor: page1.nextCursor
  });
  assert.deepEqual(names(page2), ["method2", "method3"]);
  assert.equal(page2.cursorIgnored, undefined);
  assert.ok(page2.nextCursor);

  const page3 = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated",
    maxMembers: 2,
    cursor: page2.nextCursor
  });
  assert.deepEqual(names(page3), ["method4"]);
  assert.equal(page3.truncated, false);
  assert.equal(page3.nextCursor, undefined);

  // A cursor minted for a different class must be ignored and restart at page one.
  const foreign = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.OtherItem",
    mapping: "obfuscated",
    maxMembers: 2,
    cursor: page1.nextCursor
  });
  assert.equal(foreign.cursorIgnored, true);
  assert.deepEqual(names(foreign), ["method0", "method1"]);
});

test("SourceService getClassMembers caps the default first page at 150 members and advertises a continuation cursor", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-default-cap-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": ["package net.minecraft.world.item;", "public class Item {}"].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  const makeMethod = (i: number) => ({
    ownerFqn: "net.minecraft.world.item.Item",
    name: `method${i}`,
    javaSignature: `public void method${i}()`,
    jvmDescriptor: "()V",
    accessFlags: 0x0001,
    isSynthetic: false
  });
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: Array.from({ length: 200 }, (_, i) => makeMethod(i)),
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const page = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated"
  });
  assert.equal(page.counts.total, 200);
  assert.equal(page.members.methods.length, 150);
  assert.equal(page.truncated, true);
  assert.ok(page.nextCursor, "default first page must carry a continuation cursor");
});

test("SourceService getClassMembers slims the wire member shape (hoist ownerFqn, drop accessFlags, keep jvmDescriptor)", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-wire-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": ["package net.minecraft.world.item;", "public class Item {}"].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [
          { ownerFqn: "net.minecraft.world.item.Item", name: "field", javaSignature: "public int field", jvmDescriptor: "I", accessFlags: 0x0001, isSynthetic: false }
        ],
        methods: [
          { ownerFqn: "net.minecraft.world.item.Item", name: "use", javaSignature: "public void use()", jvmDescriptor: "()V", accessFlags: 0x0001, isSynthetic: false }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated"
  }) as unknown as {
    members: {
      ownerFqn?: string;
      fields: Array<Record<string, unknown>>;
      methods: Array<Record<string, unknown>>;
    };
  };

  // ownerFqn hoisted to the block level, omitted per member (non-inherited, single owner).
  assert.equal(result.members.ownerFqn, "net.minecraft.world.item.Item");
  assert.equal(result.members.fields[0]!.ownerFqn, undefined);
  assert.equal(result.members.methods[0]!.ownerFqn, undefined);
  // accessFlags dropped from the wire (javaSignature already encodes modifiers).
  assert.equal(result.members.fields[0]!.accessFlags, undefined);
  assert.equal(result.members.methods[0]!.accessFlags, undefined);
  // isSynthetic:false is omitted.
  assert.equal("isSynthetic" in result.members.methods[0]!, false);
  // jvmDescriptor kept on methods for overload disambiguation, dropped from
  // fields by default (the type is already in javaSignature).
  assert.equal(result.members.methods[0]!.jvmDescriptor, "()V");
  assert.equal(result.members.fields[0]!.jvmDescriptor, undefined);
  // Readable signature preserved.
  assert.equal(result.members.methods[0]!.javaSignature, "public void use()");
});

test("SourceService getClassMembers restores FIELD jvmDescriptor with includeDescriptors:true", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-fielddesc-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": ["package net.minecraft.world.item;", "public class Item {}"].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [
          { ownerFqn: "net.minecraft.world.item.Item", name: "field", javaSignature: "public int field", jvmDescriptor: "I", accessFlags: 0x0001, isSynthetic: false }
        ],
        methods: [
          { ownerFqn: "net.minecraft.world.item.Item", name: "use", javaSignature: "public void use()", jvmDescriptor: "()V", accessFlags: 0x0001, isSynthetic: false }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated",
    includeDescriptors: true
  }) as unknown as { members: { fields: Array<Record<string, unknown>>; methods: Array<Record<string, unknown>> } };

  // Opt-in restores field descriptors; methods keep theirs.
  assert.equal(result.members.fields[0]!.jvmDescriptor, "I");
  assert.equal(result.members.methods[0]!.jvmDescriptor, "()V");
});

test("SourceService getClassMembers enriches a binary-path CLASS_NOT_FOUND with recovery guidance", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-notfound-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {}"
    ].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  // Force the bytecode extraction path to report the class as missing with the
  // sparse error shape that getSignature produces.
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      throw createError({
        code: ERROR_CODES.CLASS_NOT_FOUND,
        message: 'Class "net.minecraft.world.item.Missing" was not found in jar.',
        details: { fqn: "net.minecraft.world.item.Missing", jarPath: binaryJarPath, classEntryPath: "x.class" }
      });
    }
  };

  await assert.rejects(
    () => service.getClassMembers({
      artifactId: resolved.artifactId,
      className: "net.minecraft.world.item.Missing",
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; details?: Record<string, unknown> };
      assert.equal(appError.code, ERROR_CODES.CLASS_NOT_FOUND);
      assert.ok(appError.details?.nextAction, "expected enriched nextAction");
      assert.ok(appError.details?.suggestedCall, "expected enriched suggestedCall");
      return true;
    }
  );
});

test("SourceService getClassSource falls back to sibling binary artifact when source jar coverage is partial", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-fallback-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "dhl.java": [
      "public class dhl {}"
    ].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {",
      "  public void use() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "mojang"
  });

  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "mojang"
  });

  assert.match(source.sourceText, /class Item/);
  assert.ok(source.warnings.some((warning) => warning.includes("Falling back to binary artifact")));
});

test("SourceService targetKind=jar handles representative sibling sources-jar adoption rules", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type JarSiblingFixture = {
    binaryJarPath: string;
    root: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createJarSiblingFixture(input: {
    rootPrefix: string;
    extraSourcesJars: Array<{ fileName: string; entries: Record<string, string> }>;
  }): Promise<JarSiblingFixture> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const binaryJarPath = join(root, "a.jar");
    await createJar(binaryJarPath, {
      "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });

    for (const sourceJar of input.extraSourcesJars) {
      await createJar(join(root, sourceJar.fileName), sourceJar.entries);
    }

    return {
      binaryJarPath,
      root,
      service: new SourceService(buildTestConfig(root))
    };
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<JarSiblingFixture>;
    run: (fixture: JarSiblingFixture) => Promise<void>;
  }> = [
    {
      name: "does not adopt unrelated *-sources.jar files",
      createFixture: () =>
        createJarSiblingFixture({
          rootPrefix: "service-jar-unrelated-sources-",
          extraSourcesJars: [
            {
              fileName: "b-sources.jar",
              entries: {
                "com/example/B.java": [
                  "package com.example;",
                  "public class B {}"
                ].join("\n")
              }
            }
          ]
        }),
      run: async ({ binaryJarPath, service }) => {
        await assert.rejects(
          () =>
            service.resolveArtifact({
              target: { kind: "jar", value: binaryJarPath },
              allowDecompile: false
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
        );
      }
    },
    {
      name: "only adopts <basename>-sources.jar",
      createFixture: () =>
        createJarSiblingFixture({
          rootPrefix: "service-jar-exact-sources-",
          extraSourcesJars: [
            {
              fileName: "a-sources.jar",
              entries: {
                "com/example/A.java": [
                  "package com.example;",
                  "public class A {}"
                ].join("\n")
              }
            },
            {
              fileName: "b-sources.jar",
              entries: {
                "com/example/B.java": [
                  "package com.example;",
                  "public class B {}"
                ].join("\n")
              }
            }
          ]
        }),
      run: async ({ binaryJarPath, root, service }) => {
        const resolved = await service.resolveArtifact({
          target: { kind: "jar", value: binaryJarPath }
        });

        assert.equal(resolved.origin, "local-jar");
        assert.equal(resolved.isDecompiled, false);
        assert.equal(resolved.resolvedSourceJarPath, join(root, "a-sources.jar"));
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await testCase.createFixture());
    });
  }
});

test("SourceService mod APIs align missing-jar existence errors with analyze-mod-jar", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const { analyzeModJar } = await import("../src/mod-analyzer.ts");
  const root = await mkdtemp(join(tmpdir(), "service-mod-path-alignment-"));
  const missingJarPath = join(root, "missing.jar");

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () => analyzeModJar(missingJarPath),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );

  await assert.rejects(
    () => service.decompileModJar({ jarPath: missingJarPath }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );

  await assert.rejects(
    () =>
      service.getModClassSource({
        jarPath: missingJarPath,
        className: "com.example.Missing"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );

  await assert.rejects(
    () =>
      service.searchModSource({
        jarPath: missingJarPath,
        query: "Missing"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );
});

test("SourceService accepts artifactAlias on findClass and getClassSource", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-alias-canonical-"));
  const binaryJarPath = join(root, "alias-canonical.jar");
  const sourcesJarPath = join(root, "alias-canonical-sources.jar");

  await createJar(binaryJarPath, {
    "pkg/Greeter.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "pkg/Greeter.java": [
      "package pkg;",
      "public class Greeter {",
      "  public String hello() { return \"hi\"; }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });
  const alias = resolved.artifactAlias;
  assert.notEqual(alias, resolved.artifactId);

  // findClass: symbolsRepo is keyed by canonical artifact_id only; alias must
  // be normalized in the entry method or the lookup silently returns nothing.
  const findResult = service.findClass({ artifactId: alias, className: "Greeter" });
  assert.equal(findResult.total, 1);
  assert.equal(findResult.matches[0]?.qualifiedName, "pkg.Greeter");

  // getClassSource: filesRepo is keyed by canonical id too. mode=full so we
  // exercise the source-fetch path, not the metadata short-circuit.
  const sourceResult = await service.getClassSource({
    artifactId: alias,
    className: "pkg.Greeter",
    mode: "full"
  });
  assert.match(sourceResult.sourceText, /class Greeter/);
  assert.equal(sourceResult.artifactId, resolved.artifactId);
});

test("SourceService produces identical alias when the same jar is resolved through a symlink", async () => {
  const { symlink } = await import("node:fs/promises");
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-alias-symlink-"));
  const realJarPath = join(root, "real.jar");
  const realSourcesJarPath = join(root, "real-sources.jar");
  const linkJarPath = join(root, "link-to-real.jar");

  await createJar(realJarPath, {
    "pkg/Marker.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(realSourcesJarPath, {
    "pkg/Marker.java": "package pkg;\npublic class Marker {}"
  });
  await symlink(realJarPath, linkJarPath);

  const service = new SourceService(buildTestConfig(root));
  const viaReal = await service.resolveArtifact({ target: { kind: "jar", value: realJarPath } });
  const viaLink = await service.resolveArtifact({ target: { kind: "jar", value: linkJarPath } });

  // Same canonical artifact row; alias must NOT rotate because it derives
  // from the resolver-canonical path, not the caller's raw input string.
  assert.equal(viaReal.artifactId, viaLink.artifactId);
  assert.equal(viaReal.artifactAlias, viaLink.artifactAlias);

  // The original alias must still resolve after the second call (no rotation).
  const file = await service.getArtifactFile({
    artifactId: viaReal.artifactAlias,
    filePath: "pkg/Marker.java"
  });
  assert.match(file.content, /class Marker/);
});

test("SourceService backfills alias on warm-cache resolveArtifact", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-alias-backfill-"));
  const binaryJarPath = join(root, "warm-cache.jar");
  const sourcesJarPath = join(root, "warm-cache-sources.jar");

  await createJar(binaryJarPath, {
    "pkg/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "pkg/Main.java": "package pkg;\npublic class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const first = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });

  // Simulate a schema-v4 migrated row whose alias was never written.
  const repo = (service as unknown as {
    artifactsRepo: {
      getArtifact: (id: string) => { alias?: string } | undefined;
      setAlias: (id: string, alias: string) => void;
    };
    db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
  });
  repo.db.prepare(`UPDATE artifacts SET alias = NULL WHERE artifact_id = ?`).run([first.artifactId]);
  assert.equal(repo.artifactsRepo.getArtifact(first.artifactId)?.alias, undefined);

  // The warm-cache resolveArtifact must rewrite the alias so the returned
  // artifactAlias resolves back via getArtifact(alias).
  const second = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.artifactAlias, first.artifactAlias);
  assert.equal(repo.artifactsRepo.getArtifact(first.artifactId)?.alias, second.artifactAlias);

  // Caller can use the alias for follow-up lookups even after a migration.
  const file = await service.getArtifactFile({
    artifactId: second.artifactAlias,
    filePath: "pkg/Main.java"
  });
  assert.match(file.content, /class Main/);
});

test("SourceService changes artifactId when source jar signature changes", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-signature-"));
  const binaryJarPath = join(root, "server-2.0.0.jar");
  const sourcesJarPath = join(root, "server-2.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const first = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java":
      "package net.minecraft.server;\npublic class Main { void afterUpdate() {} }"
  });

  const second = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });
  assert.notEqual(first.artifactId, second.artifactId);
});

test("SourceService evicts oldest artifacts when maxArtifacts is exceeded", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-evict-"));
  const config = buildTestConfig(root, { maxArtifacts: 1, maxCacheBytes: 2_147_483_648 });
  const service = new SourceService(config);

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");

  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const first = await service.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await service.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: first.artifactId,
        className: "a.A"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
      );
    }
  );
});

test("SourceService LRU eviction unlinks the artifact's `<cacheDir>/remapped/<id>.jar`", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "service-evict-remapped-"));
  const config = buildTestConfig(root, { maxArtifacts: 1, maxCacheBytes: 2_147_483_648 });
  const service = new SourceService(config);

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const first = await service.resolveArtifact({ target: { kind: "jar", value: jar1 } });

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const orphanedRemapped = join(remappedDir, `${first.artifactId}.jar`);
  await writeFile(orphanedRemapped, "remapped-bytes");
  assert.equal(existsSync(orphanedRemapped), true);

  await service.resolveArtifact({ target: { kind: "jar", value: jar2 } });

  assert.equal(
    existsSync(orphanedRemapped),
    false,
    "expected LRU eviction to unlink the remapped jar paired with the evicted artifact"
  );
});

test("SourceService init scans `<cacheDir>/remapped/` and includes only live-artifact bytes in `cache_total_content_bytes`", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-remapped-init-"));

  const config = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });

  const bootstrapService = new SourceService(config);
  const live = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const liveRemappedSize = 64 * 1024;
  const orphanedRemappedSize = 16 * 1024;
  await writeFile(join(remappedDir, `${live.artifactId}.jar`), Buffer.alloc(liveRemappedSize));
  await writeFile(join(remappedDir, "orphan-with-no-artifact.jar"), Buffer.alloc(orphanedRemappedSize));

  const service = new SourceService(config);

  const metrics = readCacheAccountingMetrics(service);
  assert.ok(
    metrics.totalContentBytes >= liveRemappedSize,
    `expected the live artifact's remapped jar bytes to be counted (got ${metrics.totalContentBytes})`
  );
  assert.ok(
    metrics.totalContentBytes < liveRemappedSize + orphanedRemappedSize,
    `expected orphaned remapped jar bytes (${orphanedRemappedSize}) to be excluded from accounting (got ${metrics.totalContentBytes})`
  );
});

test("SourceService maxCacheBytes does not chase orphaned remapped jars by evicting unrelated live artifacts", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-orphan-no-overshoot-"));

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const bootstrapConfig = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const bootstrapService = new SourceService(bootstrapConfig);
  const live1 = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const live2 = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(live1.artifactId, live2.artifactId);

  const remappedDir = join(bootstrapConfig.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const orphanJar = Buffer.alloc(64 * 1024);
  await writeFile(join(remappedDir, "orphan-no-artifact-row.jar"), orphanJar);

  const tightConfig = buildTestConfig(root, {
    maxArtifacts: 10,
    maxCacheBytes: orphanJar.byteLength - 1
  });
  const tightService = new SourceService(tightConfig);

  // No new resolves: the ctor's enforceCacheLimits pass alone must not chase orphan bytes.
  const metrics = readCacheAccountingMetrics(tightService);
  const remainingIds = metrics.lru.map((entry) => entry.artifactId);
  assert.ok(
    remainingIds.includes(live1.artifactId),
    `expected live1 to remain after init (got [${remainingIds.join(", ")}])`
  );
  assert.ok(
    remainingIds.includes(live2.artifactId),
    `expected live2 to remain after init (got [${remainingIds.join(", ")}])`
  );
});

test("SourceService maxCacheBytes does not over-evict unrelated artifacts after a remapped-jar eviction", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "service-evict-no-overshoot-"));

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  const jar3 = join(root, "three.jar");
  const src3 = join(root, "three-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });
  await createJar(jar3, { "c/C.class": Buffer.from([7, 8, 9]) });
  await createJar(src3, { "c/C.java": "package c;\npublic class C {}" });

  const config = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const bootstrapService = new SourceService(config);
  const first = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const remappedFirst = join(remappedDir, `${first.artifactId}.jar`);
  const oversizedJar = Buffer.alloc(64 * 1024);
  await writeFile(remappedFirst, oversizedJar);

  const tightConfig = buildTestConfig(root, {
    maxArtifacts: 10,
    maxCacheBytes: oversizedJar.byteLength - 1
  });
  const tightService = new SourceService(tightConfig);

  await tightService.resolveArtifact({ target: { kind: "jar", value: jar3 } });

  assert.equal(
    existsSync(remappedFirst),
    false,
    "expected the oversized remapped jar paired with `first` to be evicted"
  );
  const metrics = readCacheAccountingMetrics(tightService);
  const remainingIds = metrics.lru.map((entry) => entry.artifactId);
  assert.ok(
    remainingIds.includes(second.artifactId),
    `expected the unrelated artifact \`second\` (${second.artifactId}) to remain cached after the remapped-jar eviction (got [${remainingIds.join(", ")}])`
  );
});

test("SourceService maxCacheBytes evicts when remapped jar bytes alone push over the limit", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "service-evict-remapped-bytes-"));

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const config = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const bootstrapService = new SourceService(config);
  const first = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const remappedFirst = join(remappedDir, `${first.artifactId}.jar`);
  const oversizedJar = Buffer.alloc(64 * 1024);
  await writeFile(remappedFirst, oversizedJar);

  const jar3 = join(root, "three.jar");
  const src3 = join(root, "three-sources.jar");
  await createJar(jar3, { "c/C.class": Buffer.from([7, 8, 9]) });
  await createJar(src3, { "c/C.java": "package c;\npublic class C {}" });

  const tightConfig = buildTestConfig(root, {
    maxArtifacts: 10,
    maxCacheBytes: oversizedJar.byteLength - 1
  });
  const tightService = new SourceService(tightConfig);

  const initMetrics = readCacheAccountingMetrics(tightService);
  assert.ok(
    initMetrics.totalContentBytes >= oversizedJar.byteLength,
    `expected refreshCacheMetrics to count the remapped jar bytes (got ${initMetrics.totalContentBytes})`
  );

  await tightService.resolveArtifact({ target: { kind: "jar", value: jar3 } });

  assert.equal(
    existsSync(remappedFirst),
    false,
    "expected the oversized remapped jar to push the byte total over `maxCacheBytes` and trigger eviction"
  );
});

test("SourceService reports representative cache byte-accounting states", async (t) => {
  const cacheOneSource = "package a;\npublic class CacheOne { String token = \"one\"; }\n";
  const cacheTwoSource = "package b;\npublic class CacheTwo { String token = \"two\"; }\n";
  const alphaSource = "package a;\npublic class A { String payload = \"alpha-alpha-alpha\"; }\n";
  const betaSource = "package b;\npublic class B { String payload = \"beta-beta-beta\"; }\n";

  const cases: Array<{
    name: string;
    rootPrefix: string;
    configOverrides?: Partial<Config>;
    artifacts: CacheFixtureArtifactInput[];
    verify: (input: {
      service: SourceServiceFixture;
      artifacts: CacheFixtureArtifact[];
    }) => Promise<void>;
  }> = [
    {
      name: "tracks byte accounting across multiple artifacts",
      rootPrefix: "service-cache-accounting-",
      configOverrides: { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 },
      artifacts: [
        {
          jarBaseName: "cache-one",
          sourceEntries: { "a/CacheOne.java": cacheOneSource }
        },
        {
          jarBaseName: "cache-two",
          sourceEntries: { "b/CacheTwo.java": cacheTwoSource },
          binaryEntries: { "b/CacheTwo.class": Buffer.from([4, 5, 6]) }
        }
      ],
      verify: async ({ service, artifacts }) => {
        const first = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[0]!.jarPath } });
        const second = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[1]!.jarPath } });
        assert.notEqual(first.artifactId, second.artifactId);

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 2);
        assert.equal(
          metrics.totalContentBytes,
          artifacts[0]!.expectedContentBytes + artifacts[1]!.expectedContentBytes
        );
        assert.equal(metrics.lru.length, 2);

        const firstRow = metrics.lru.find((entry) => entry.artifactId === first.artifactId);
        const secondRow = metrics.lru.find((entry) => entry.artifactId === second.artifactId);
        assert.equal(firstRow?.contentBytes, artifacts[0]!.expectedContentBytes);
        assert.equal(secondRow?.contentBytes, artifacts[1]!.expectedContentBytes);
      }
    },
    {
      name: "keeps byte accounting consistent after maxCacheBytes eviction",
      rootPrefix: "service-evict-bytes-",
      configOverrides: {
        maxArtifacts: 10,
        maxCacheBytes: Buffer.byteLength(alphaSource, "utf8") + 1
      },
      artifacts: [
        {
          jarBaseName: "bytes-one",
          sourceEntries: { "a/A.java": alphaSource },
          binaryEntries: { "a/A.class": Buffer.from([1, 2, 3]) }
        },
        {
          jarBaseName: "bytes-two",
          sourceEntries: { "b/B.java": betaSource },
          binaryEntries: { "b/B.class": Buffer.from([4, 5, 6]) }
        }
      ],
      verify: async ({ service, artifacts }) => {
        const first = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[0]!.jarPath } });
        const second = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[1]!.jarPath } });
        assert.notEqual(first.artifactId, second.artifactId);

        await assert.rejects(
          () =>
            service.getClassSource({
              artifactId: first.artifactId,
              className: "a.A"
            }),
          (error: unknown) => {
            return (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
            );
          }
        );

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 1);
        assert.equal(metrics.totalContentBytes, artifacts[1]!.expectedContentBytes);
        assert.equal(metrics.lru.length, 1);
        assert.equal(metrics.lru[0]?.artifactId, second.artifactId);
        assert.equal(metrics.lru[0]?.contentBytes, artifacts[1]!.expectedContentBytes);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await createCacheAccountingFixture({
        rootPrefix: testCase.rootPrefix,
        configOverrides: testCase.configOverrides,
        artifacts: testCase.artifacts
      });
      await testCase.verify(fixture);
    });
  }
});

test("SourceService updates cache accounting without rescanning repo tables", async (t) => {
  const cacheHitSource = 'package a;\npublic class CacheHit { String token = "hit"; }\n';
  const ingestSource = 'package a;\npublic class Ingest { String token = "ingest"; }\n';

  const cases: Array<{
    name: string;
    rootPrefix: string;
    artifact: CacheFixtureArtifactInput;
    verify: (input: {
      service: SourceServiceFixture;
      artifact: CacheFixtureArtifact;
    }) => Promise<void>;
  }> = [
    {
      name: "artifact cache hits avoid rescanning accounting tables",
      rootPrefix: "service-cache-hit-metrics-",
      artifact: {
        jarBaseName: "cache-hit",
        sourceEntries: { "a/CacheHit.java": cacheHitSource },
        binaryEntries: { "a/CacheHit.class": Buffer.from([1, 2, 3]) }
      },
      verify: async ({ service, artifact }) => {
        await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });
        const repoCounters = instrumentCacheAccountingRepo(service);

        await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });

        assert.deepEqual(repoCounters.counts(), {
          countCalls: 0,
          totalBytesCalls: 0,
          lruCalls: 0
        });
      }
    },
    {
      name: "artifact ingest updates accounting incrementally",
      rootPrefix: "service-ingest-metrics-",
      artifact: {
        jarBaseName: "ingest",
        sourceEntries: { "a/Ingest.java": ingestSource },
        binaryEntries: { "a/Ingest.class": Buffer.from([1, 2, 3]) }
      },
      verify: async ({ service, artifact }) => {
        const repoCounters = instrumentCacheAccountingRepo(service);
        const resolved = await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });

        assert.deepEqual(repoCounters.counts(), {
          countCalls: 0,
          totalBytesCalls: 0,
          lruCalls: 0
        });

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 1);
        assert.equal(metrics.totalContentBytes, artifact.expectedContentBytes);
        assert.equal(metrics.lru.length, 1);
        assert.equal(metrics.lru[0]?.artifactId, resolved.artifactId);
        assert.equal(metrics.lru[0]?.contentBytes, artifact.expectedContentBytes);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { service, artifacts } = await createCacheAccountingFixture({
        rootPrefix: testCase.rootPrefix,
        artifacts: [testCase.artifact]
      });
      await testCase.verify({ service, artifact: artifacts[0]! });
    });
  }
});

test("RuntimeMetrics snapshots copy artifact byte accounting rows on read", async () => {
  const { RuntimeMetrics } = await import("../src/observability.ts");
  const metrics = new RuntimeMetrics();
  const lru = [
    {
      artifactId: "artifact-one",
      totalContentBytes: 12,
      updatedAt: "2026-03-14T00:00:00.000Z"
    }
  ];

  metrics.setCacheArtifactByteAccountingRef(lru);

  const first = metrics.snapshot();
  assert.deepEqual(first.cache_artifact_bytes_lru, [
    {
      artifact_id: "artifact-one",
      content_bytes: 12,
      updated_at: "2026-03-14T00:00:00.000Z"
    }
  ]);

  first.cache_artifact_bytes_lru[0]!.artifact_id = "mutated";
  first.cache_artifact_bytes_lru[0]!.content_bytes = 99;
  lru[0]!.artifactId = "artifact-two";
  lru[0]!.totalContentBytes = 18;
  lru[0]!.updatedAt = "2026-03-14T00:00:01.000Z";

  const second = metrics.snapshot();
  assert.deepEqual(second.cache_artifact_bytes_lru, [
    {
      artifact_id: "artifact-two",
      content_bytes: 18,
      updated_at: "2026-03-14T00:00:01.000Z"
    }
  ]);
});
