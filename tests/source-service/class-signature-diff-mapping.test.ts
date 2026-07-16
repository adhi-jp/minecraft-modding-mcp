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

test("SourceService diffClassSignatures with non-obfuscated mapping remaps member deltas", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
