import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTestConfig } from "./helpers/test-config.ts";

type ArtifactSeed = {
  artifactId: string;
  origin: "local-jar" | "local-m2" | "remote-repo" | "decompiled";
  requestedMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
  mappingApplied: "obfuscated" | "mojang" | "intermediary" | "yarn";
  qualityFlags: string[];
  files: Array<{ filePath: string; content: string }>;
  symbols: Array<{ filePath: string; symbolKind: string; symbolName: string; qualifiedName?: string; line: number }>;
  version?: string;
  sourceJarPath?: string;
  binaryJarPath?: string;
  isDecompiled?: boolean;
};

function seedIndexedArtifact(service: unknown, input: ArtifactSeed): void {
  const repos = service as {
    artifactsRepo: { upsertArtifact: (value: Record<string, unknown>) => void };
    filesRepo: {
      insertFilesForArtifact: (
        artifactId: string,
        files: Array<{ filePath: string; content: string; contentBytes: number; contentHash: string }>
      ) => void;
    };
    symbolsRepo: {
      insertSymbolsForArtifact: (artifactId: string, symbols: ArtifactSeed["symbols"]) => void;
    };
  };
  const timestamp = new Date().toISOString();
  repos.artifactsRepo.upsertArtifact({
    artifactId: input.artifactId,
    origin: input.origin,
    version: input.version,
    sourceJarPath: input.sourceJarPath,
    binaryJarPath: input.binaryJarPath,
    requestedMapping: input.requestedMapping,
    mappingApplied: input.mappingApplied,
    qualityFlags: input.qualityFlags,
    artifactSignature: `${input.artifactId}-sig`,
    isDecompiled: input.isDecompiled ?? false,
    timestamp
  });
  repos.filesRepo.insertFilesForArtifact(
    input.artifactId,
    input.files.map((file) => ({
      filePath: file.filePath,
      content: file.content,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      contentHash: `${input.artifactId}:${file.filePath}`
    }))
  );
  repos.symbolsRepo.insertSymbolsForArtifact(input.artifactId, input.symbols);
}

function stubExplorer(
  service: unknown,
  result: {
    constructors?: unknown[];
    fields?: unknown[];
    methods?: unknown[];
    throwError?: Error;
  }
): void {
  (service as { explorerService: unknown }).explorerService = {
    async getSignature() {
      if (result.throwError) {
        throw result.throwError;
      }
      return {
        constructors: result.constructors ?? [],
        fields: result.fields ?? [],
        methods: result.methods ?? [],
        warnings: [],
        context: {
          minecraftVersion: "1.21.10",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarHash: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };
}

test("get-class-members status=ok when total > 0", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-status-b1-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft.jar");
  seedIndexedArtifact(service, {
    artifactId: "artifact-b1",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [],
    symbols: []
  });
  stubExplorer(service, {
    methods: [
      {
        ownerFqn: "net.minecraft.world.entity.LivingEntity",
        name: "tick",
        javaSignature: "public void tick()",
        jvmDescriptor: "()V",
        accessFlags: 0x0001,
        isSynthetic: false
      }
    ]
  });
  const result = await service.getClassMembers({
    artifactId: "artifact-b1",
    className: "net.minecraft.world.entity.LivingEntity",
    mapping: "obfuscated"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.counts.total, 1);
  assert.equal(result.unavailableReason, undefined);
  assert.equal(result.suggestedCall, undefined);
});

test("status=ok when binary returns 0 members and decompiled fallback also yields 0", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-status-b2-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft.jar");
  seedIndexedArtifact(service, {
    artifactId: "artifact-b2",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [],
    symbols: []
  });
  stubExplorer(service, {});
  const result = await service.getClassMembers({
    artifactId: "artifact-b2",
    className: "net.minecraft.example.MarkerInterface",
    mapping: "mojang"
  });
  assert.equal(result.counts.total, 0);
  assert.equal(result.decompiledFallback, undefined);
  assert.equal(result.status, "ok");
});

test("status=partial when decompiled fallback rescues the call", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-status-b3-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft.jar");
  seedIndexedArtifact(service, {
    artifactId: "artifact-b3",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["partial-source-no-net-minecraft"],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "net/minecraft/world/entity/player/Player.java",
        content: [
          "package net.minecraft.world.entity.player;",
          "public class Player {",
          "  int experienceLevel = 0;",
          "  public void tick() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });
  stubExplorer(service, {});
  const result = await service.getClassMembers({
    artifactId: "artifact-b3",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang"
  });
  assert.equal(result.status, "partial");
  assert.ok(result.decompiledFallback, "decompiledFallback expected");
  assert.ok(result.qualityFlags.includes("members-from-decompiled-source"));
});

test("status=members_unavailable with suggestedCall when binary fails and no fallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-status-b4-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft.jar");
  seedIndexedArtifact(service, {
    artifactId: "artifact-b4",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["partial-source-no-net-minecraft"],
    binaryJarPath,
    version: "1.21.10",
    files: [],
    symbols: []
  });
  stubExplorer(service, { throwError: new Error("synthetic binary parse failure") });
  const result = await service.getClassMembers({
    artifactId: "artifact-b4",
    className: "net.minecraft.world.entity.LivingEntity",
    mapping: "mojang"
  });
  assert.equal(result.status, "members_unavailable");
  assert.match(result.unavailableReason ?? "", /synthetic binary parse failure/);
  assert.equal(result.suggestedCall?.tool, "get-class-source");
  assert.equal(
    (result.suggestedCall?.params as { className?: string }).className,
    "net.minecraft.world.entity.LivingEntity"
  );
  assert.equal(
    (result.suggestedCall?.params as { mode?: string }).mode,
    "snippet"
  );
});

test("getSignature throw is captured into status, not propagated", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-status-b5-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft.jar");
  seedIndexedArtifact(service, {
    artifactId: "artifact-b5",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [],
    symbols: []
  });
  stubExplorer(service, { throwError: new Error("EBADF: bad file descriptor") });
  const result = await service.getClassMembers({
    artifactId: "artifact-b5",
    className: "net.minecraft.SomeClass",
    mapping: "obfuscated"
  });
  assert.equal(result.status, "members_unavailable");
  assert.match(result.unavailableReason ?? "", /EBADF/);
});

test("LivingEntity-style regression — never status=ok with counts.total === 0 when binary fails", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-status-b6-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft.jar");
  seedIndexedArtifact(service, {
    artifactId: "artifact-b6",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["partial-source-no-net-minecraft"],
    binaryJarPath,
    version: "1.21.10",
    files: [],
    symbols: []
  });
  stubExplorer(service, { throwError: new Error("partial source jar — class not present") });
  const result = await service.getClassMembers({
    artifactId: "artifact-b6",
    className: "net.minecraft.world.entity.LivingEntity",
    mapping: "mojang",
    memberPattern: "AirSupply|getAir|setAir"
  });
  assert.equal(result.counts.total, 0);
  assert.notEqual(result.status, "ok", "status must NOT be ok when total=0 and binary failed");
});

test("MEMBERS_STATUS_LEGACY=1 strips the new fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "members-status-b7-"));
  const { spawnSync } = await import("node:child_process");
  const script = `
    import { mkdir } from "node:fs/promises";
    import { join as joinPath } from "node:path";
    import { SourceService } from "./src/source-service.ts";
    import { buildTestConfig } from "./tests/helpers/test-config.ts";
    const root = ${JSON.stringify(root)};
    await mkdir(root, { recursive: true });
    const service = new SourceService(buildTestConfig(root));
    const timestamp = new Date().toISOString();
    service.artifactsRepo.upsertArtifact({
      artifactId: "legacy-artifact",
      origin: "local-jar",
      version: "1.21.10",
      sourceJarPath: undefined,
      binaryJarPath: joinPath(root, "minecraft.jar"),
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      qualityFlags: [],
      artifactSignature: "legacy-sig",
      isDecompiled: false,
      timestamp
    });
    service.filesRepo.insertFilesForArtifact("legacy-artifact", []);
    service.symbolsRepo.insertSymbolsForArtifact("legacy-artifact", []);
    service.explorerService = {
      async getSignature() {
        return {
          constructors: [],
          fields: [],
          methods: [{
            ownerFqn: "X",
            name: "tick",
            javaSignature: "public void tick()",
            jvmDescriptor: "()V",
            accessFlags: 1,
            isSynthetic: false
          }],
          warnings: [],
          context: {
            minecraftVersion: "1.21.10",
            mappingType: "unknown",
            mappingNamespace: "obfuscated",
            jarHash: "fake",
            generatedAt: new Date().toISOString()
          }
        };
      }
    };
    const result = await service.getClassMembers({
      artifactId: "legacy-artifact",
      className: "X",
      mapping: "obfuscated"
    });
    console.log(JSON.stringify({
      hasStatus: "status" in result,
      hasUnavailable: "unavailableReason" in result,
      hasSuggested: "suggestedCall" in result,
      total: result.counts.total
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, MEMBERS_STATUS_LEGACY: "1" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.hasStatus, false, "status field must be omitted under MEMBERS_STATUS_LEGACY=1");
  assert.equal(out.hasUnavailable, false);
  assert.equal(out.hasSuggested, false);
  assert.equal(out.total, 1);
});

test("stripping status leaves byte-identical primary fields across normal/empty/partial-source cases", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const stripStatus = (obj: Record<string, unknown>): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...obj };
    delete copy.status;
    delete copy.unavailableReason;
    delete copy.suggestedCall;
    return copy;
  };

  // Case 1: normal class with members
  {
    const root = await mkdtemp(join(tmpdir(), "members-status-b8-normal-"));
    const service = new SourceService(buildTestConfig(root));
    const binaryJarPath = join(root, "minecraft.jar");
    seedIndexedArtifact(service, {
      artifactId: "b8-normal",
      origin: "local-jar",
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      qualityFlags: [],
      binaryJarPath,
      version: "1.21.10",
      files: [],
      symbols: []
    });
    stubExplorer(service, {
      methods: [
        {
          ownerFqn: "X",
          name: "tick",
          javaSignature: "public void tick()",
          jvmDescriptor: "()V",
          accessFlags: 1,
          isSynthetic: false
        }
      ]
    });
    const result = await service.getClassMembers({
      artifactId: "b8-normal",
      className: "X",
      mapping: "obfuscated"
    });
    const stripped = stripStatus(result as unknown as Record<string, unknown>);
    assert.deepEqual(Object.keys(stripped).sort(), [
      "artifactContents",
      "artifactId",
      "className",
      "context",
      "counts",
      "mappingApplied",
      "members",
      "origin",
      "provenance",
      "qualityFlags",
      "requestedMapping",
      "returnedNamespace",
      "truncated",
      "warnings"
    ]);
  }

  // Case 2: real empty interface (no fallback fires)
  {
    const root = await mkdtemp(join(tmpdir(), "members-status-b8-empty-"));
    const service = new SourceService(buildTestConfig(root));
    const binaryJarPath = join(root, "minecraft.jar");
    seedIndexedArtifact(service, {
      artifactId: "b8-empty",
      origin: "local-jar",
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      qualityFlags: [],
      binaryJarPath,
      version: "1.21.10",
      files: [],
      symbols: []
    });
    stubExplorer(service, {});
    const result = await service.getClassMembers({
      artifactId: "b8-empty",
      className: "EmptyInterface",
      mapping: "obfuscated"
    });
    assert.equal(result.counts.total, 0);
    assert.equal(result.decompiledFallback, undefined);
  }

  // Case 3: partial-source with successful fallback — qualityFlags must contain members-from-decompiled-source
  {
    const root = await mkdtemp(join(tmpdir(), "members-status-b8-partial-"));
    const service = new SourceService(buildTestConfig(root));
    const binaryJarPath = join(root, "minecraft.jar");
    seedIndexedArtifact(service, {
      artifactId: "b8-partial",
      origin: "local-jar",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: ["partial-source-no-net-minecraft"],
      binaryJarPath,
      version: "1.21.10",
      files: [
        {
          filePath: "net/minecraft/Foo.java",
          content: "package net.minecraft;\npublic class Foo {\n  int x = 0;\n}\n"
        }
      ],
      symbols: []
    });
    stubExplorer(service, {});
    const result = await service.getClassMembers({
      artifactId: "b8-partial",
      className: "net.minecraft.Foo",
      mapping: "mojang"
    });
    assert.ok(result.qualityFlags.includes("members-from-decompiled-source"));
    assert.ok(result.decompiledFallback);
    assert.equal(result.status, "partial");
  }
});

test("get-class-members keeps per-member ownerFqn and omits the block-level ownerFqn when includeInherited", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-wire-inherited-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "wire-inherited",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath: join(root, "minecraft.jar"),
    version: "1.21.10",
    files: [],
    symbols: []
  });
  stubExplorer(service, {
    methods: [
      { ownerFqn: "com.example.Child", name: "own", javaSignature: "public void own()", jvmDescriptor: "()V", accessFlags: 0x0001, isSynthetic: false },
      { ownerFqn: "com.example.Parent", name: "inherited", javaSignature: "public void inherited()", jvmDescriptor: "()V", accessFlags: 0x0001, isSynthetic: false }
    ]
  });
  const result = await service.getClassMembers({
    artifactId: "wire-inherited",
    className: "com.example.Child",
    mapping: "obfuscated",
    includeInherited: true
  });
  // Members span multiple owners: no hoisting, ownerFqn stays per member.
  assert.equal(result.members.ownerFqn, undefined);
  assert.ok(result.members.methods.some((m) => m.ownerFqn === "com.example.Parent"));
  assert.ok(result.members.methods.some((m) => m.ownerFqn === "com.example.Child"));
});

test("get-class-members emits isSynthetic only for synthetic members", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "members-wire-synthetic-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "wire-synthetic",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath: join(root, "minecraft.jar"),
    version: "1.21.10",
    files: [],
    symbols: []
  });
  stubExplorer(service, {
    methods: [
      { ownerFqn: "com.example.Widget", name: "real", javaSignature: "public void real()", jvmDescriptor: "()V", accessFlags: 0x0001, isSynthetic: false },
      { ownerFqn: "com.example.Widget", name: "bridge", javaSignature: "public void bridge()", jvmDescriptor: "()V", accessFlags: 0x1041, isSynthetic: true }
    ]
  });
  const result = await service.getClassMembers({
    artifactId: "wire-synthetic",
    className: "com.example.Widget",
    mapping: "obfuscated",
    includeSynthetic: true
  });
  const real = result.members.methods.find((m) => m.name === "real")!;
  const bridge = result.members.methods.find((m) => m.name === "bridge")!;
  assert.equal("isSynthetic" in real, false, "non-synthetic member omits isSynthetic");
  assert.equal(bridge.isSynthetic, true, "synthetic member carries isSynthetic:true");
});
