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
import {
  type CacheAccountingRepo,
  type CacheFixtureArtifact,
  type CacheFixtureArtifactInput,
  type SourceServiceFixture,
  computeSourceEntriesBytes,
  createCacheAccountingFixture,
  defaultBinaryEntriesFor,
  instrumentCacheAccountingRepo
} from "../helpers/source-service-fixtures.ts";

test("SourceService getClassMembers uses sibling binary jar when artifact is resolved from a source jar input", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
