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

test("SourceService diffClassSignatures returns member added/removed/modified deltas", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-signatures-"));
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
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }

      if (version === "1.0.0") {
        return {
          constructors: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "<init>",
              javaSignature: "public Main()",
              jvmDescriptor: "()V",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          fields: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "MUTATED_FIELD",
              javaSignature: "public int MUTATED_FIELD",
              jvmDescriptor: "I",
              accessFlags: 0x0001,
              isSynthetic: false
            },
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "REMOVED_FIELD",
              javaSignature: "public int REMOVED_FIELD",
              jvmDescriptor: "I",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          methods: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "changedAccess",
              javaSignature: "public void changedAccess(int)",
              jvmDescriptor: "(I)V",
              accessFlags: 0x0001,
              isSynthetic: false
            },
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "removedMethod",
              javaSignature: "public void removedMethod()",
              jvmDescriptor: "()V",
              accessFlags: 0x0001,
              isSynthetic: false
            },
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "changedDescriptor",
              javaSignature: "public void changedDescriptor()",
              jvmDescriptor: "()V",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          warnings: [],
          context: {
            minecraftVersion: "1.0.0",
            mappingType: "unknown",
            mappingNamespace: "obfuscated",
            jarHash: "fake",
            generatedAt: new Date().toISOString()
          }
        };
      }

      return {
        constructors: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "<init>",
            javaSignature: "public Main()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "<init>",
            javaSignature: "public Main(int)",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "MUTATED_FIELD",
            javaSignature: "public long MUTATED_FIELD",
            jvmDescriptor: "J",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "NEW_FIELD",
            javaSignature: "public int NEW_FIELD",
            jvmDescriptor: "I",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "changedAccess",
            javaSignature: "private void changedAccess(int)",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0002,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "newMethod",
            javaSignature: "public void newMethod()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "changedDescriptor",
            javaSignature: "public void changedDescriptor(int)",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: {
          minecraftVersion: "1.0.1",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarHash: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await (
    service as unknown as {
      diffClassSignatures: (input: {
        className: string;
        fromVersion: string;
        toVersion: string;
      }) => Promise<{
        classChange: string;
        constructors: { added: Array<{ jvmDescriptor: string }> };
        methods: {
          added: Array<{ name: string; jvmDescriptor: string }>;
          removed: Array<{ name: string; jvmDescriptor: string }>;
          modified: Array<{ key: string }>;
        };
        fields: {
          added: Array<{ name: string }>;
          removed: Array<{ name: string }>;
          modified: Array<{ key: string }>;
        };
        summary: {
          constructors: { added: number; removed: number; modified: number };
          methods: { added: number; removed: number; modified: number };
          fields: { added: number; removed: number; modified: number };
          total: { added: number; removed: number; modified: number };
        };
      }>;
    }
  ).diffClassSignatures({
    className: "net.minecraft.server.Main",
    fromVersion: "1.0.0",
    toVersion: "1.0.1"
  });

  assert.equal(result.classChange, "present_in_both");
  assert.deepEqual(
    result.constructors.added.map((entry) => entry.jvmDescriptor),
    ["(I)V"]
  );
  assert.deepEqual(
    result.methods.added.map((entry) => `${entry.name}${entry.jvmDescriptor}`),
    ["changedDescriptor(I)V", "newMethod()V"]
  );
  assert.deepEqual(
    result.methods.removed.map((entry) => `${entry.name}${entry.jvmDescriptor}`),
    ["changedDescriptor()V", "removedMethod()V"]
  );
  assert.deepEqual(
    result.methods.modified.map((entry) => entry.key),
    ["changedAccess#(I)V"]
  );
  assert.deepEqual(
    result.fields.added.map((entry) => entry.name),
    ["NEW_FIELD"]
  );
  assert.deepEqual(
    result.fields.removed.map((entry) => entry.name),
    ["REMOVED_FIELD"]
  );
  assert.deepEqual(
    result.fields.modified.map((entry) => entry.key),
    ["MUTATED_FIELD"]
  );
  assert.deepEqual(result.summary, {
    constructors: { added: 1, removed: 0, modified: 0 },
    methods: { added: 2, removed: 2, modified: 1 },
    fields: { added: 1, removed: 1, modified: 1 },
    total: { added: 4, removed: 3, modified: 2 }
  });
});

test("SourceService diffClassSignatures omits from/to snapshots when includeFullDiff=false", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-compact-"));
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
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }

      if (version === "1.0.0") {
        return {
          constructors: [],
          fields: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "MUTATED_FIELD",
              javaSignature: "public int MUTATED_FIELD",
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
            name: "MUTATED_FIELD",
            javaSignature: "public long MUTATED_FIELD",
            jvmDescriptor: "J",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [],
        warnings: []
      };
    }
  };

  const result = await (service as unknown as {
    diffClassSignatures: (input: {
      className: string;
      fromVersion: string;
      toVersion: string;
      includeFullDiff: false;
    }) => Promise<{
      fields: {
        modified: Array<{
          key: string;
          changed: string[];
          from?: unknown;
          to?: unknown;
        }>;
      };
    }>;
  }).diffClassSignatures({
    className: "net.minecraft.server.Main",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    includeFullDiff: false
  });

  assert.deepEqual(result.fields.modified, [
    {
      key: "MUTATED_FIELD",
      changed: ["javaSignature", "jvmDescriptor"]
    }
  ]);
  assert.equal("from" in result.fields.modified[0]!, false);
  assert.equal("to" in result.fields.modified[0]!, false);
});

test("SourceService diffClassSignatures reports class added and absent_in_both states", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-states-"));
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
    async getSignature(input: { jarPath: string; fqn: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }

      if (input.fqn === "net.minecraft.server.AlwaysMissing") {
        throw createError({ code: ERROR_CODES.CLASS_NOT_FOUND, message: "missing" });
      }

      if (version === "1.0.0") {
        throw createError({ code: ERROR_CODES.CLASS_NOT_FOUND, message: "missing" });
      }

      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: input.fqn,
            name: "presentNow",
            javaSignature: "public void presentNow()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: {
          minecraftVersion: "1.0.1",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarHash: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const added = await (
    service as unknown as {
      diffClassSignatures: (input: {
        className: string;
        fromVersion: string;
        toVersion: string;
      }) => Promise<{
        classChange: string;
        methods: { added: Array<{ name: string }>; removed: unknown[] };
      }>;
    }
  ).diffClassSignatures({
    className: "net.minecraft.server.PresentNow",
    fromVersion: "1.0.0",
    toVersion: "1.0.1"
  });
  assert.equal(added.classChange, "added");
  assert.equal(added.methods.removed.length, 0);
  assert.deepEqual(
    added.methods.added.map((entry) => entry.name),
    ["presentNow"]
  );

  const absentInBoth = await (
    service as unknown as {
      diffClassSignatures: (input: {
        className: string;
        fromVersion: string;
        toVersion: string;
      }) => Promise<{
        classChange: string;
        warnings: string[];
      }>;
    }
  ).diffClassSignatures({
    className: "net.minecraft.server.AlwaysMissing",
    fromVersion: "1.0.0",
    toVersion: "1.0.1"
  });
  assert.equal(absentInBoth.classChange, "absent_in_both");
  assert.match(
    absentInBoth.warnings[0] ?? "",
    /Class "net\.minecraft\.server\.AlwaysMissing" was not found in both versions\./
  );
});

test("SourceService diffClassSignatures validates version range order", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-validate-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.2", "1.0.1", "1.0.0"];
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

  await assert.rejects(
    () =>
      (service as unknown as {
        diffClassSignatures: (input: {
          className: string;
          fromVersion: string;
          toVersion: string;
        }) => Promise<unknown>;
      }).diffClassSignatures({
        className: "net.minecraft.server.Main",
        fromVersion: "1.0.2",
        toVersion: "1.0.0"
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
