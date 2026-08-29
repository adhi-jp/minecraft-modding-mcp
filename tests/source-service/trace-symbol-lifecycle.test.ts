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

test("SourceService traces symbol lifecycle across versions and reports gaps", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.3", "1.0.2", "1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));

  const versionServiceStub = {
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

  const signatureStub = {
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }
      const descriptorByVersion: Record<string, string[] | undefined> = {
        "1.0.0": ["()V"],
        "1.0.1": [],
        "1.0.2": ["(I)V"],
        "1.0.3": ["()V", "(I)V"]
      };
      const descriptors = descriptorByVersion[version] ?? [];
      return {
        constructors: [],
        fields: [],
        methods: descriptors.map((descriptor) => ({
          ownerFqn: "net.minecraft.server.Main",
          name: "tickServer",
          javaSignature: "void tickServer()",
          jvmDescriptor: descriptor,
          accessFlags: 0x0001,
          isSynthetic: false
        })),
        context: {
          minecraftVersion: version,
          mappingType: "obfuscated",
          mappingNamespace: "obfuscated",
          jarSignature: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  (service as unknown as { versionService: unknown }).versionService = versionServiceStub;
  (service as unknown as { explorerService: unknown }).explorerService = signatureStub;

  const result = await (
    service as unknown as {
      traceSymbolLifecycle: (input: {
        symbol: string;
        descriptor?: string;
        fromVersion?: string;
        toVersion?: string;
        includeTimeline?: boolean;
      }) => Promise<{
        presence: {
          firstSeen?: string;
          lastSeen?: string;
          missingBetween: string[];
          existsNow: boolean;
        };
        timeline?: Array<{ version: string; exists: boolean }>;
      }>;
    }
  ).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer",
    descriptor: "()V",
    fromVersion: "1.0.0",
    toVersion: "1.0.3",
    includeTimeline: true
  });

  assert.equal(result.presence.firstSeen, "1.0.0");
  assert.equal(result.presence.lastSeen, "1.0.3");
  assert.equal(result.presence.existsNow, true);
  assert.deepEqual(result.presence.missingBetween, ["1.0.1", "1.0.2"]);
  assert.deepEqual(
    result.timeline?.map((entry) => ({ version: entry.version, exists: entry.exists })),
    [
      { version: "1.0.0", exists: true },
      { version: "1.0.1", exists: false },
      { version: "1.0.2", exists: false },
      { version: "1.0.3", exists: true }
    ]
  );
});

test("SourceService traceSymbolLifecycle with non-obfuscated mapping resolves symbol to obfuscated", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-map-"));
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
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer()",
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

  const mappingCalls: Array<{ name: string; sourceMapping: string; targetMapping: string }> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      mappingCalls.push({ name: input.name, sourceMapping: input.sourceMapping, targetMapping: input.targetMapping });
      // Simulate mapping: yarn name -> obfuscated name
      if (input.kind === "class" && input.name === "net.minecraft.server.YarnMain") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "yarnTick") {
        return { resolved: true, resolvedSymbol: { name: "tickServer" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "yarn";
    }) => Promise<{
      query: { className: string; methodName: string; mapping: string };
      presence: { existsNow: boolean };
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.YarnMain.yarnTick",
    mapping: "yarn"
  });

  // Query should echo user's (yarn) names
  assert.equal(result.query.className, "net.minecraft.server.YarnMain");
  assert.equal(result.query.methodName, "yarnTick");
  assert.equal(result.query.mapping, "yarn");
  // Method should be found because it was resolved to obfuscated name
  assert.equal(result.presence.existsNow, true);
  // Verify mapping was called for both class and method
  assert.ok(mappingCalls.some((c) => c.name === "net.minecraft.server.YarnMain" && c.targetMapping === "obfuscated"));
  assert.ok(mappingCalls.some((c) => c.name === "yarnTick" && c.targetMapping === "obfuscated"));
});

test("SourceService traceSymbolLifecycle ignores inline signature suffix when parsing symbol", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-inline-signature-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.0"];
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

  let requestedClassName: string | undefined;
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      requestedClassName = input.fqn;
      assert.equal(input.fqn, "net.minecraft.server.Main");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer(java.lang.String)",
            jvmDescriptor: "(Ljava/lang/String;)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
    }) => Promise<{
      query: { className: string; methodName: string };
      presence: { existsNow: boolean };
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer(java.lang.String)"
  });

  assert.equal(requestedClassName, "net.minecraft.server.Main");
  assert.equal(result.query.className, "net.minecraft.server.Main");
  assert.equal(result.query.methodName, "tickServer");
  assert.equal(result.presence.existsNow, true);
});

test("SourceService traceSymbolLifecycle remaps non-obfuscated symbol per scanned version", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-versioned-map-"));
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
        return {
          constructors: [],
          fields: [],
          methods: [
            {
              ownerFqn: "net.minecraft.server.OldMain",
              name: "oldTick",
              javaSignature: "public void oldTick()",
              jvmDescriptor: "()V",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          warnings: [],
          context: { classExistedInJar: true }
        };
      }
      if (input.fqn !== "net.minecraft.server.NewMain") {
        throw Object.assign(new Error("class not found"), { code: ERROR_CODES.CLASS_NOT_FOUND });
      }
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.NewMain",
            name: "newTick",
            javaSignature: "public void newTick()",
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

  const mappingCalls: Array<{ version: string; kind: string; name: string }> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { version: string; kind: string; name: string }) {
      mappingCalls.push({ version: input.version, kind: input.kind, name: input.name });
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain" && input.version === "1.0.0") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OldMain" }, warnings: [] };
      }
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain" && input.version === "1.0.1") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.NewMain" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "tickInter" && input.version === "1.0.0") {
        return { resolved: true, resolvedSymbol: { name: "oldTick" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "tickInter" && input.version === "1.0.1") {
        return { resolved: true, resolvedSymbol: { name: "newTick" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      fromVersion: string;
      toVersion: string;
      mapping: "intermediary";
      includeTimeline: boolean;
    }) => Promise<{
      presence: { firstSeen?: string; lastSeen?: string; existsNow: boolean };
      timeline?: Array<{ version: string; exists: boolean }>;
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    mapping: "intermediary",
    includeTimeline: true
  });

  assert.equal(result.presence.firstSeen, "1.0.0");
  assert.equal(result.presence.lastSeen, "1.0.1");
  assert.equal(result.presence.existsNow, true);
  assert.deepEqual(result.timeline, [
    { version: "1.0.0", exists: true, reason: undefined },
    { version: "1.0.1", exists: true, reason: undefined }
  ]);
  assert.ok(
    mappingCalls.some((call) => call.version === "1.0.0" && call.kind === "class" && call.name === "net.minecraft.server.InterMain")
  );
  assert.ok(
    mappingCalls.some((call) => call.version === "1.0.1" && call.kind === "class" && call.name === "net.minecraft.server.InterMain")
  );
});

test("SourceService traceSymbolLifecycle with non-obfuscated mapping remaps descriptor before matching", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-descriptor-remap-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.0"];
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
    async getSignature(input: { fqn: string }) {
      assert.equal(input.fqn, "net.minecraft.server.OffMain");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.OffMain",
            name: "tickOfficial",
            javaSignature: "public void tickOfficial(net.minecraft.server.OffArg)",
            jvmDescriptor: "(Lnet/minecraft/server/OffArg;)V",
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
    async findMapping(input: { kind: string; name: string; descriptor?: string }) {
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OffMain" }, warnings: [] };
      }
      if (
        input.kind === "method" &&
        input.name === "tickInter" &&
        input.descriptor === "(Lnet/minecraft/server/InterArg;)V"
      ) {
        return {
          resolved: true,
          resolvedSymbol: { name: "tickOfficial", descriptor: "(Lnet/minecraft/server/OffArg;)V" },
          warnings: []
        };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "intermediary";
      descriptor: string;
      fromVersion: string;
      toVersion: string;
    }) => Promise<{ presence: { existsNow: boolean } }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    mapping: "intermediary",
    descriptor: "(Lnet/minecraft/server/InterArg;)V",
    fromVersion: "1.0.0",
    toVersion: "1.0.0"
  });

  assert.equal(result.presence.existsNow, true);
});

test("SourceService traceSymbolLifecycle uses name-only mapping when descriptor is omitted", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-name-only-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.0"];
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
    async getSignature(input: { fqn: string }) {
      assert.equal(input.fqn, "net.minecraft.server.OffMain");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.OffMain",
            name: "tickOfficial",
            javaSignature: "public void tickOfficial()",
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
    async findMapping(input: {
      kind: string;
      name: string;
      descriptor?: string;
      signatureMode?: "exact" | "name-only";
    }) {
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OffMain" }, warnings: [] };
      }
      if (
        input.kind === "method" &&
        input.name === "tickInter" &&
        input.signatureMode === "name-only" &&
        input.descriptor === undefined
      ) {
        return {
          resolved: true,
          resolvedSymbol: { name: "tickOfficial" },
          warnings: []
        };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "intermediary";
      fromVersion: string;
      toVersion: string;
    }) => Promise<{ presence: { existsNow: boolean } }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    mapping: "intermediary",
    fromVersion: "1.0.0",
    toVersion: "1.0.0"
  });

  assert.equal(result.presence.existsNow, true);
});

test("SourceService traceSymbolLifecycle surfaces invalid method mapping input details in warnings", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-invalid-warning-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.0"];
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

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string }) {
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OffMain" }, warnings: [] };
      }
      throw Object.assign(new Error("descriptor must be a valid JVM descriptor when kind=method."), {
        code: ERROR_CODES.INVALID_INPUT
      });
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "intermediary";
      descriptor: string;
      fromVersion: string;
      toVersion: string;
    }) => Promise<{ warnings: string[] }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    mapping: "intermediary",
    descriptor: "()broken",
    fromVersion: "1.0.0",
    toVersion: "1.0.0"
  });

  assert.ok(
    result.warnings.some((warning) => warning.includes("descriptor must be a valid JVM descriptor"))
  );
});

test("SourceService traceSymbolLifecycle rejects obvious class-like symbols before consulting mapping state or scanning jars", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-classlike-"));
  const service = new SourceService(buildTestConfig(root));

  let resolveVersionJarCalls = 0;
  let getSignatureCalls = 0;
  let checkSymbolExistsCalls = 0;

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.21.1", "1.21"];
    },
    async resolveVersionJar(version: string) {
      resolveVersionJarCalls += 1;
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      getSignatureCalls += 1;
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists(input: {
      kind: string;
      name: string;
      sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
      version: string;
    }) {
      checkSymbolExistsCalls += 1;
      assert.equal(input.kind, "class");
      assert.equal(input.name, "net.minecraft.world.item.Item");
      assert.equal(input.sourceMapping, "mojang");
      assert.equal(input.version, "1.21.1");
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.world.item.Item",
          symbol: "net.minecraft.world.item.Item"
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    async findMapping() {
      throw new Error("findMapping should not be reached for class-like input");
    }
  };

  await assert.rejects(
    () =>
      (service as unknown as {
        traceSymbolLifecycle: (input: {
          symbol: string;
          mapping: "mojang";
          maxVersions: number;
        }) => Promise<unknown>;
      }).traceSymbolLifecycle({
        symbol: "net.minecraft.world.item.Item",
        mapping: "mojang",
        maxVersions: 5
      }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.equal(error !== null && "code" in error ? (error as { code?: string }).code : undefined, ERROR_CODES.INVALID_INPUT);
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Class\.method/
      );
      return true;
    }
  );

  assert.equal(checkSymbolExistsCalls, 0);
  assert.equal(resolveVersionJarCalls, 0);
  assert.equal(getSignatureCalls, 0);
});

test("SourceService traceSymbolLifecycle keeps mapping pressure bounded across versions when cache release is available", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-pressure-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.2", "1.0.1", "1.0.0"];
  const activeGraphVersions = new Set<string>();
  const releasedVersions: string[] = [];

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
    async getSignature() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer()",
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

  const acquireGraph = (version: string) => {
    activeGraphVersions.add(version);
    if (activeGraphVersions.size > 3) {
      throw new Error(`simulated mapping graph pressure on ${version}`);
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: {
      version: string;
      kind: "class" | "method";
      name: string;
      owner?: string;
      descriptor?: string;
    }) {
      acquireGraph(input.version);
      if (input.kind === "class") {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: {
            kind: "class",
            name: input.name,
            symbol: input.name
          },
          candidates: [],
          candidateCount: 1,
          warnings: []
        };
      }
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "method",
          owner: input.owner,
          name: input.name,
          descriptor: input.descriptor,
          symbol: `${input.owner}.${input.name}${input.descriptor ?? ""}`
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    async resolveMethodMappingExact(input: {
      version: string;
      owner: string;
      name: string;
      descriptor: string;
    }) {
      acquireGraph(input.version);
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "method",
          owner: input.owner,
          name: input.name,
          descriptor: input.descriptor,
          symbol: `${input.owner}.${input.name}${input.descriptor}`
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    releaseGraphCacheEntry(version: string) {
      activeGraphVersions.delete(version);
      releasedVersions.push(version);
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "mojang";
      descriptor: string;
      fromVersion: string;
      toVersion: string;
      includeTimeline: boolean;
    }) => Promise<{
      timeline?: Array<{ version: string; exists: boolean; reason?: string }>;
      warnings: string[];
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer",
    mapping: "mojang",
    descriptor: "()V",
    fromVersion: "1.0.0",
    toVersion: "1.0.2",
    includeTimeline: true
  });

  assert.deepEqual(
    result.timeline?.map((entry) => ({ version: entry.version, exists: entry.exists, reason: entry.reason })),
    [
      { version: "1.0.0", exists: true, reason: undefined },
      { version: "1.0.1", exists: true, reason: undefined },
      { version: "1.0.2", exists: true, reason: undefined }
    ]
  );
  assert.deepEqual(releasedVersions.sort(), ["1.0.0", "1.0.1", "1.0.2"]);
  assert.deepEqual(activeGraphVersions.size, 0);
  assert.ok(
    result.warnings.every((warning) => !warning.includes("simulated mapping graph pressure")),
    "expected mapping graph pressure to stay bounded"
  );
});

test("SourceService traceSymbolLifecycle evaluates versions with bounded parallelism while preserving timeline order", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-parallel-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.7", "1.0.6", "1.0.5", "1.0.4", "1.0.3", "1.0.2", "1.0.1", "1.0.0"];
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

  let activeCalls = 0;
  let maxActiveCalls = 0;
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeCalls -= 1;
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer()",
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

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      descriptor: string;
      fromVersion: string;
      toVersion: string;
      includeTimeline: boolean;
    }) => Promise<{
      timeline?: Array<{ version: string; exists: boolean }>;
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer",
    descriptor: "()V",
    fromVersion: "1.0.0",
    toVersion: "1.0.7",
    includeTimeline: true
  });

  assert.ok(maxActiveCalls > 1);
  assert.ok(maxActiveCalls <= 4);
  assert.deepEqual(
    result.timeline?.map((entry) => ({ version: entry.version, exists: entry.exists })),
    [
      { version: "1.0.0", exists: true },
      { version: "1.0.1", exists: true },
      { version: "1.0.2", exists: true },
      { version: "1.0.3", exists: true },
      { version: "1.0.4", exists: true },
      { version: "1.0.5", exists: true },
      { version: "1.0.6", exists: true },
      { version: "1.0.7", exists: true }
    ]
  );
});
