/**
 * Source family (source-read, source-export, member-list) through the
 * in-process MCP session that serves the catalog and the 8.x tools side by
 * side.
 *
 * Fixtures, all local:
 *  - a library jar with an adjacent `-sources.jar` (source, member, export
 *    and paging parity against the 8.x single and batch tools);
 *  - a binary-only Fabric mod jar read through a `jar` target and through
 *    the 8.x mod tools. The decompiler is a stub (javaRunner is mocked) that
 *    writes fixed sources; both paths decompile through it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { buildSuggestedCall } from "../../src/build-suggested-call.ts";
import { createError, ERROR_CODES } from "../../src/errors.ts";
import { javaRunner, type JavaProcessOptions } from "../../src/java-process.ts";
import { SourceService } from "../../src/source-service.ts";
import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withEnv } from "../helpers/env.ts";
import { seedIndexedArtifact, stubExplorer } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { mockJavaRunner } from "../helpers/java-runner-mock.ts";
import { buildInnerJarBytes, createShellJar } from "../helpers/nested-jar.ts";
import { createJar } from "../helpers/zip.ts";
import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { exportPathFor, SOURCE_TOOL_SPECS } from "../../src/tools/families/source.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import { DETAIL_LEVELS } from "../../src/tools/schemas.ts";
import { translateServiceSuggestedCall } from "../../src/tools/translation.ts";
import type { CatalogRuntime, CatalogServices } from "../../src/tools/types.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-source-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";
// The decompiler jar only has to exist; javaRunner is mocked where it runs.
const vineflowerJarPath = join(root, "tools", "vineflower.jar");
mkdirSync(join(root, "tools"), { recursive: true });
writeFileSync(vineflowerJarPath, Buffer.from([0x50, 0x4b]));
process.env.MCP_VINEFLOWER_JAR_PATH = vineflowerJarPath;

const jarPath = join(root, "jars", "source-lib-1.0.0.jar");
const modJarPath = join(root, "mods", "demomod-1.0.0.jar");

const WIDGET_SOURCE = [
  "package com.example;",
  "",
  "public class Widget {",
  "  public int size;",
  "  private String label;",
  "",
  "  public Widget() {}",
  "",
  "  public int size() {",
  "    return size;",
  "  }",
  "",
  "  private void relabel(String next) {",
  "    label = next;",
  "  }",
  "",
  "  public static class Part {",
  "    public int weight() {",
  "      return 1;",
  "    }",
  "  }",
  "}",
  ""
].join("\n");
const GADGET_SOURCE = "package com.example;\n\npublic class Gadget {\n  public void run() {}\n}\n";
const MANY_SOURCE = "package com.example;\n\npublic class Many {}\n";
/** A class longer than the default snippet window of 200 lines. */
const LONG_SOURCE = [
  "package com.example;",
  "public class Long {",
  ...Array.from({ length: 446 }, (_, index) => `  int line${index + 3};`),
  "}",
  ""
].join("\n");
const GSON_TYPES_SOURCE = "package com.google.gson.internal;\n\npublic final class $Gson$Types {\n}\n";

function u2(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value & 0xffff, 0);
  return buffer;
}

const MOD_SOURCES: Readonly<Record<string, string>> = {
  "com/example/mod/DemoMod.java":
    "package com.example.mod;\n\npublic class DemoMod {\n   public static final String MOD_ID = \"demomod\";\n" +
    "   private int counter;\n\n   public void onInitialize() {\n      ++this.counter;\n   }\n}\n",
  "com/example/mod/Other.java": "package com.example.mod;\n\npublic interface Other {\n   void run(String var1);\n}\n"
};

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

type Item = Record<string, any> & { className: string; status: string };
type Envelope = {
  result?: Record<string, any> & { items?: Item[] };
  error?: Record<string, any> & { fieldErrors?: Array<Record<string, any>> };
  meta: Record<string, any> & {
    warnings?: Array<{ code: string; severity: string; message: string }>;
    nextActions?: Array<{ tool: string; params: Record<string, any>; reason?: string; template?: true }>;
    pagination?: { hasMore: boolean; nextCursor?: string };
    truncation?: Array<{ field: string; limitedBy: string }>;
  };
};

let session: CatalogSession;

before(async () => {
  mkdirSync(join(root, "jars"), { recursive: true });
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      fields: [
        { name: "size", descriptor: "I", accessFlags: 0x0001 },
        { name: "label", descriptor: "Ljava/lang/String;", accessFlags: 0x0002 }
      ],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "size", descriptor: "()I", accessFlags: 0x0001 },
        { name: "relabel", descriptor: "(Ljava/lang/String;)V", accessFlags: 0x0002 }
      ]
    }),
    "com/example/Widget$Part.class": buildClassFile({
      internalName: "com/example/Widget$Part",
      methods: [{ name: "weight", descriptor: "()I", accessFlags: 0x0001 }]
    }),
    "com/example/Gadget.class": buildClassFile({
      internalName: "com/example/Gadget",
      fields: [
        {
          name: "legacy",
          descriptor: "I",
          accessFlags: 0x0001,
          attributes: [
            {
              name: "RuntimeVisibleAnnotations",
              info: (pool) => Buffer.concat([u2(1), u2(pool.addUtf8("Ljava/lang/Deprecated;")), u2(0)])
            }
          ]
        }
      ],
      methods: [{ name: "run", descriptor: "()V", accessFlags: 0x0001 }]
    }),
    "com/example/Long.class": buildClassFile({ internalName: "com/example/Long" }),
    "com/google/gson/internal/$Gson$Types.class": buildClassFile({ internalName: "com/google/gson/internal/$Gson$Types" }),
    "com/example/Many.class": buildClassFile({
      internalName: "com/example/Many",
      methods: ["alpha", "bravo", "charlie", "delta", "echo"].map((name) => ({
        name,
        descriptor: "()V",
        accessFlags: 0x0001
      }))
    })
  });
  await createJar(join(root, "jars", "source-lib-1.0.0-sources.jar"), {
    "com/example/Widget.java": WIDGET_SOURCE,
    "com/example/Gadget.java": GADGET_SOURCE,
    "com/example/Many.java": MANY_SOURCE,
    "com/example/Long.java": LONG_SOURCE,
    "com/google/gson/internal/$Gson$Types.java": GSON_TYPES_SOURCE,
    // Sorts ahead of $Gson$Types.java and differs only in case, so a lookup that
    // ignores case must still find the exact file.
    "com/google/gson/internal/$GSON$Types.java": GSON_TYPES_SOURCE.replace("$Gson$Types", "$GSON$Types")
  });

  mkdirSync(join(root, "mods"), { recursive: true });
  await createJar(modJarPath, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "demomod", version: "1.0.0" }),
    "com/example/mod/DemoMod.class": buildClassFile({
      internalName: "com/example/mod/DemoMod",
      fields: [
        { name: "MOD_ID", descriptor: "Ljava/lang/String;", accessFlags: 0x0019 },
        { name: "counter", descriptor: "I", accessFlags: 0x0002 }
      ],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "onInitialize", descriptor: "()V", accessFlags: 0x0001 },
        { name: "helper", descriptor: "(IJ)I", accessFlags: 0x000a }
      ]
    }),
    "com/example/mod/Other.class": buildClassFile({
      internalName: "com/example/mod/Other",
      accessFlags: 0x0601,
      methods: [{ name: "run", descriptor: "(Ljava/lang/String;)V", accessFlags: 0x0401 }]
    })
  });

  session = await startCatalogSession(CATALOG_TOOL_SPECS);
});

after(async () => {
  await session.close();
});

function envelopeOf(frame: SessionFrame): { envelope: Envelope; isError: boolean; text: string } {
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const result = frame.result as { content: Array<{ text: string }>; structuredContent: Envelope; isError?: boolean };
  return { envelope: result.structuredContent, isError: result.isError === true, text: result.content[0]!.text };
}

function specOf(name: string) {
  const spec = SOURCE_TOOL_SPECS.find((entry) => entry.name === name);
  assert.ok(spec, `${name} is a source spec`);
  return spec;
}

/**
 * Calls a catalog tool. Every reply names the catalog tool (positive control)
 * and no 8.x tool, carries no internal fallback sentence, reports only
 * declared statuses, and publishes only executable next actions for catalog
 * tools or flagged templates.
 */
async function catalog(name: string, args: unknown) {
  const reply = envelopeOf(await session.callTool(name, args));
  assert.equal(reply.envelope.meta.tool, name);
  assert.ok(reply.text.includes(`"${name}"`), "positive control: the catalog tool name is in the reply");
  assert.doesNotMatch(reply.text, ALIAS_NAME_PATTERN, `no 8.x tool name in the ${name} reply: ${reply.text}`);
  assert.equal(reply.text.includes(FALLBACK_SENTENCE), false);
  for (const item of reply.envelope.result?.items ?? []) {
    assert.ok(specOf(name).statuses.includes(item.status as never), `${name} item status ${item.status} is declared`);
  }
  for (const action of reply.envelope.meta.nextActions ?? []) {
    assert.ok(CATALOG_TOOL_SPECS.some((spec) => spec.name === action.tool), `${action.tool} is a catalog tool`);
    if (action.template !== true) {
      assert.deepEqual(finalizeNextActions([action]), [action], `next action ${JSON.stringify(action)} validates`);
    }
  }
  return reply;
}

async function eightX(name: string, args: unknown) {
  return envelopeOf(await session.callTool(name, args));
}

function injectedRuntime(services: CatalogServices): CatalogRuntime {
  return {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services
  };
}

async function injected(name: string, args: unknown, services: CatalogServices): Promise<Envelope> {
  return (await runCatalogTool(specOf(name), args, injectedRuntime(services))).structuredContent as Envelope;
}

/** Services whose shared target resolves to one stub artifact; `overrides` supply the class reads. */
function stubServices(overrides: Partial<Record<keyof CatalogServices, unknown>>): CatalogServices {
  return {
    resolveArtifact: async (input: any) => ({
      artifactId: "artifact-stub",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      version: "1.0.0",
      provenance: { target: input.target, resolvedAt: "", resolvedFrom: { origin: "local-jar" }, transformChain: [] },
      qualityFlags: [],
      artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "full" },
      warnings: []
    }),
    ...overrides
  } as unknown as CatalogServices;
}

function sourceOutput(className: string) {
  return {
    className,
    mode: "full",
    sourceText: `class ${className} {}`,
    totalLines: 1,
    returnedRange: { start: 1, end: 1 },
    truncated: false,
    origin: "local-jar",
    artifactId: "artifact-stub",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    returnedNamespace: "obfuscated",
    provenance: {},
    qualityFlags: [],
    artifactContents: {},
    warnings: []
  };
}

const jarTarget = () => ({ kind: "jar", jarPath });
const legacyJarTarget = () => ({ kind: "jar", value: jarPath });

test("source tools default to the served artifact namespace, with explicit mappings and continuations preserved", async () => {
  for (const [mappingApplied, requestedMapping] of [["obfuscated", "mojang"], ["mojang", "obfuscated"]] as const) {
    const fixtureRoot = mkdtempSync(join(root, "namespace-"));
    const service = new SourceService(buildTestConfig(fixtureRoot));
    const className = "net.minecraft.server.Main";
    const translatedName = "other.Main";
    const nativeText = "package net.minecraft.server;\npublic class Main {\n  public int nativeMarker;\n}\n";
    const translatedText = "package other;\npublic class Main {\n  public int translatedMarker;\n}\n";
    seedIndexedArtifact(service, {
      artifactId: "namespace-artifact", origin: "local-jar", requestedMapping, mappingApplied,
      qualityFlags: [], version: "1.21.10", binaryJarPath: join(fixtureRoot, "runtime.jar"),
      files: [
        { filePath: "net/minecraft/server/Main.java", content: nativeText },
        { filePath: "other/Main.java", content: translatedText }
      ],
      symbols: [],
      provenance: {
        target: { kind: "version", value: "1.21.10" }, resolvedAt: "2026-11-04",
        resolvedFrom: { origin: "local-jar", version: "1.21.10" }, transformChain: []
      }
    });
    (service as unknown as { mappingService: unknown }).mappingService = {
      async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
        assert.notEqual(input.sourceMapping, input.targetMapping);
        assert.deepEqual([input.sourceMapping, input.targetMapping].sort(), ["mojang", "obfuscated"]);
        if (input.kind === "field") {
          assert.equal(input.sourceMapping, mappingApplied);
          assert.equal(input.targetMapping, requestedMapping);
        }
        const name = input.kind === "class" ? translatedName : "serverPort";
        return { resolved: true, status: "resolved", resolvedSymbol: { kind: input.kind, name }, candidates: [], warnings: [] };
      }
    };
    stubExplorer(service, {
      fields: ["a", "b"].map((name) => ({
        ownerFqn: className, name, javaSignature: `public int ${name}`, jvmDescriptor: "I", accessFlags: 1, isSynthetic: false
      }))
    });
    const target = { kind: "artifact", artifactId: "namespace-artifact" };
    const read = await injected("source-read", { target, classes: [className], mode: "snippet", maxLines: 2 }, service);
    assert.equal(read.result!.items![0]!.sourceText, nativeText.split("\n").slice(0, 2).join("\n"));
    assert.equal(read.result!.artifact.mappingApplied, mappingApplied);
    const sourceNext = read.meta.nextActions!.find((action) => action.tool === "source-read")!;
    assert.equal(sourceNext.params.mapping, mappingApplied);
    const continued = await injected("source-read", sourceNext.params, service);
    assert.match(continued.result!.items![0]!.sourceText, /nativeMarker/);

    const outputDir = join(fixtureRoot, "export");
    const exported = await injected("source-export", { target, classes: [className], outputDir }, service);
    assert.equal(exported.result!.items![0]!.path, join(outputDir, "net/minecraft/server/Main.java"));
    assert.match(readFileSync(exported.result!.items![0]!.path, "utf8"), /nativeMarker/);
    const explicit = await injected("source-read", { target, classes: [className], mapping: requestedMapping, mode: "full" }, service);
    assert.match(explicit.result!.items![0]!.sourceText, /translatedMarker/);
    const explicitExport = await injected("source-export", { target, classes: [className], outputDir, mapping: requestedMapping }, service);
    assert.equal(explicitExport.result!.items![0]!.path, join(outputDir, "other/Main.java"));
    assert.match(readFileSync(explicitExport.result!.items![0]!.path, "utf8"), /translatedMarker/);
    assert.equal(readFileSync(exported.result!.items![0]!.path, "utf8"), nativeText.replace(/\n$/, ""), "the mapped export preserves the earlier native export");

    const members = await injected("member-list", { target, classes: [className], limit: 1 }, service);
    assert.equal(members.result!.items![0]!.members.fields[0].name, "a");
    assert.equal(members.result!.items![0]!.mappingApplied, undefined);
    const memberNext = members.meta.nextActions!.find((action) => action.tool === "member-list")!;
    assert.equal(memberNext.params.mapping, mappingApplied);
    const nextMembers = await injected("member-list", memberNext.params, service);
    assert.equal(nextMembers.result!.items![0]!.members.fields[0].name, "b");
    const explicitMembers = await injected("member-list", { target, classes: [className], mapping: requestedMapping }, service);
    assert.equal(explicitMembers.result!.items![0]!.members.fields[0].name, "serverPort");
    assert.equal(explicitMembers.result!.items![0]!.mappingApplied, requestedMapping);
  }
});

test("source-export follows the translated class's source filename while default reads keep their output shape", async () => {
  const fixtureRoot = mkdtempSync(join(root, "export-mapped-name-"));
  const service = new SourceService(buildTestConfig(fixtureRoot));
  const source = "package a.b;\npublic class C { public int mappedMarker; }\n";
  seedIndexedArtifact(service, {
    artifactId: "mapped-export", origin: "local-jar", requestedMapping: "mojang", mappingApplied: "obfuscated",
    qualityFlags: [], version: "1.21.10",
    files: [{ filePath: "a/b/C.java", content: source }],
    symbols: [{ filePath: "a/b/C.java", symbolKind: "class", symbolName: "C", qualifiedName: "a.b.C", line: 2 }]
  });
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      assert.equal(input.kind, "class");
      assert.equal(input.name, "com.mojang.NamedClass");
      assert.equal(input.sourceMapping, "mojang");
      assert.equal(input.targetMapping, "obfuscated");
      return { resolved: true, status: "resolved", resolvedSymbol: { kind: "class", name: "a.b.C" }, candidates: [], warnings: [] };
    }
  };
  const defaultRead = await service.getClassSource({ artifactId: "mapped-export", className: "com.mojang.NamedClass", mapping: "mojang", mode: "full" });
  assert.equal(defaultRead.sourceText, source.replace(/\n$/, ""));
  assert.equal(Object.hasOwn(defaultRead, "sourceFilePath"), false, "internal export metadata is absent from ordinary service reads");
  const exportRead = await service.getClassSource(
    { artifactId: "mapped-export", className: "com.mojang.NamedClass", mapping: "mojang", mode: "full" },
    { includeSourceFilePath: true }
  );
  assert.equal(exportRead.sourceFilePath, "a/b/C.java");
  const outputDir = join(fixtureRoot, "export");
  const reply = await injected("source-export", {
    target: { kind: "artifact", artifactId: "mapped-export" }, classes: ["com.mojang.NamedClass"], mapping: "mojang", outputDir
  }, service);
  const item = reply.result!.items![0]!;
  assert.equal(item.status, "ok", JSON.stringify(reply));
  assert.equal(item.path, join(outputDir, "a/b/C.java"));
  assert.equal(readFileSync(item.path, "utf8"), source.replace(/\n$/, ""));
  assert.equal(existsSync(join(outputDir, "com/mojang/NamedClass.java")), false);
});

test("source-read and source-export honor per-call decompilation policy for partial sources and initial resolution", async (t) => {
  const runs = { calls: [] as JavaProcessOptions[] };
  t.mock.method(javaRunner, "assertAvailable", async () => {});
  t.mock.method(javaRunner, "run", async (options: JavaProcessOptions) => {
    runs.calls.push(options);
    const outputDir = options.args.at(-1)!;
    mkdirSync(join(outputDir, "com/example"), { recursive: true });
    writeFileSync(join(outputDir, "com/example/Main.java"), "package com.example;\npublic class Main {\n  public int fallbackMarker;\n}\n");
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });
  for (const name of ["source-read", "source-export"] as const) {
    for (const allowDecompile of [false, undefined, true]) {
      const fixtureRoot = mkdtempSync(join(root, "decompile-policy-"));
      const binary = join(fixtureRoot, "library.jar");
      await createJar(binary, { "com/example/Main.class": buildClassFile({ internalName: "com/example/Main" }) });
      await createJar(join(fixtureRoot, "library-sources.jar"), { "com/example/Other.java": "package com.example; public class Other {}" });
      const service = new SourceService(buildTestConfig(fixtureRoot, { vineflowerJarPath }));
      const resolved = await service.resolveArtifact({ target: { kind: "jar", value: binary }, allowDecompile: false });
      const beforeRuns = runs.calls.length;
      const args = {
        target: { kind: "artifact", artifactId: resolved.artifactId }, classes: ["com.example.Main"], mode: "full",
        ...(allowDecompile !== undefined ? { allowDecompile } : {}),
        ...(name === "source-export" ? { outputDir: join(fixtureRoot, "export") } : {})
      };
      const reply = await injected(name, args, service);
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      const item = reply.result!.items![0]!;
      if (allowDecompile === false) {
        assert.equal(item.status, "not_found", JSON.stringify(reply));
        assert.equal(item.error.code, "ERR_CLASS_NOT_FOUND");
        assert.equal(runs.calls.length, beforeRuns, "a partial source jar must not start Vineflower when false");
        assert.equal(existsSync(join(fixtureRoot, "export/com/example/Main.java")), false);
      } else {
        assert.equal(item.status, "ok", JSON.stringify(reply));
        const text = name === "source-read" ? item.sourceText : readFileSync(item.path, "utf8");
        assert.match(text, /fallbackMarker/);
        assert.equal(runs.calls.length, beforeRuns + 1, "absent and true retain binary fallback");
        const fallbackRead = await service.getClassSource(
          { artifactId: resolved.artifactId, className: "com.example.Main", mode: "full" },
          { includeSourceFilePath: true }
        );
        assert.equal(fallbackRead.sourceFilePath, "com/example/Main.java", "the path comes from the binary fallback artifact");
      }

      const binaryOnly = join(fixtureRoot, "binary-only.jar");
      await createJar(binaryOnly, { "com/example/Main.class": buildClassFile({ internalName: "com/example/Main" }) });
      const initialRuns = runs.calls.length;
      const initial = await injected(name, { ...args, target: { kind: "jar", jarPath: binaryOnly } }, service);
      if (allowDecompile === false) {
        assert.equal(initial.error?.code, "ERR_SOURCE_NOT_FOUND", JSON.stringify(initial));
        assert.equal(runs.calls.length, initialRuns, "false also governs initial target resolution");
      } else {
        assert.equal(initial.result!.items![0]!.status, "ok", JSON.stringify(initial));
        assert.equal(runs.calls.length, initialRuns + 1);
      }
    }
  }
});

test("a source continuation preserves false while reading an already indexed source", async () => {
  const first = await catalog("source-read", {
    target: jarTarget(), classes: ["com.example.Widget"], mode: "snippet", maxLines: 2, allowDecompile: false
  });
  assert.equal(first.envelope.error, undefined, JSON.stringify(first.envelope));
  const next = first.envelope.meta.nextActions!.find((action) => action.tool === "source-read")!;
  assert.equal(next.params.allowDecompile, false);
  const second = await catalog("source-read", next.params);
  assert.equal(second.envelope.result!.items![0]!.status, "ok");
  assert.deepEqual(second.envelope.result!.items![0]!.returnedRange, { start: 3, end: 4 });
});

test("served Mojang names on a proven unobfuscated runtime remain the source and member default", async () => {
  const fixtureRoot = mkdtempSync(join(root, "unobfuscated-"));
  const service = new SourceService(buildTestConfig(fixtureRoot));
  const className = "net.minecraft.server.Main";
  seedIndexedArtifact(service, {
    artifactId: "unobfuscated-artifact", origin: "local-jar", requestedMapping: "yarn", mappingApplied: "obfuscated",
    qualityFlags: [], version: "26.2", binaryJarPath: join(fixtureRoot, "runtime.jar"),
    files: [{ filePath: "net/minecraft/server/Main.java", content: "package net.minecraft.server;\npublic class Main {\n  public int serverPort;\n}\n" }],
    symbols: [],
    provenance: {
      target: { kind: "version", value: "26.2" }, resolvedAt: "2026-11-04", unobfuscatedRuntime: true,
      resolvedFrom: { origin: "local-jar", version: "26.2" }, transformChain: []
    }
  });
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping() { return { resolved: false, status: "not_found", candidates: [], warnings: [] }; }
  };
  stubExplorer(service, { fields: [{ ownerFqn: className, name: "serverPort", javaSignature: "public int serverPort", jvmDescriptor: "I", accessFlags: 1, isSynthetic: false }] });
  const target = { kind: "artifact", artifactId: "unobfuscated-artifact" };
  for (const name of ["source-read", "source-export", "member-list"]) {
    const reply = await injected(name, {
      target, classes: [className], ...(name === "source-export" ? { outputDir: join(fixtureRoot, "export") } : {})
    }, service);
    assert.equal(reply.result!.items![0]!.status, "ok", JSON.stringify(reply));
    assert.equal(reply.result!.artifact.mappingApplied, "mojang");
    assert.equal(reply.meta.warnings, undefined, JSON.stringify(reply.meta.warnings));
  }
});

test("false survives recovery actions from initial resolution and ambiguous nested source reads", async () => {
  const fixtureRoot = mkdtempSync(join(root, "source-recovery-"));
  const binary = buildClassFile({ internalName: "com/example/Shared" });
  const inner = await buildInnerJarBytes({ "com/example/Shared.class": binary, "com/example/Shared.java": "package com.example; public class Shared {}" });
  const shell = join(fixtureRoot, "shell.jar");
  await createShellJar(shell, { "META-INF/jars/a.jar": inner, "META-INF/jars/b.jar": inner });
  const service = new SourceService(buildTestConfig(fixtureRoot));
  const shellArtifact = await service.resolveArtifact({ target: { kind: "jar", value: shell } });
  for (const name of ["source-read", "source-export"] as const) {
    const reply = await injected(name, {
      target: { kind: "artifact", artifactId: shellArtifact.artifactId }, classes: ["com.example.Shared"], allowDecompile: false,
      ...(name === "source-export" ? { outputDir: join(fixtureRoot, "export") } : {})
    }, service);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(reply.result!.items![0]!.status, "ambiguous", JSON.stringify(reply));
    const actions = reply.meta.nextActions!.filter((action) => action.tool === "artifact-resolve");
    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.equal(action.params.allowDecompile, false);
      assert.deepEqual(finalizeNextActions([action]), [action]);
    }

    const mappingFailure = await injected(name, {
      target: { kind: "jar", jarPath }, classes: ["com.example.Widget"], mapping: "yarn", allowDecompile: false,
      ...(name === "source-export" ? { outputDir: join(fixtureRoot, "export") } : {})
    }, service);
    assert.equal(mappingFailure.error?.code, "ERR_MAPPING_NOT_APPLIED", JSON.stringify(mappingFailure));
    const recovery = mappingFailure.meta.nextActions!.find((action) => action.tool === "artifact-resolve")!;
    assert.equal(recovery.params.allowDecompile, false);
  }
  const uniqueShell = join(fixtureRoot, "unique-shell.jar");
  await createShellJar(uniqueShell, { "META-INF/jars/a.jar": inner });
  const uniqueArtifact = await service.resolveArtifact({ target: { kind: "jar", value: uniqueShell } });
  const redirectedRead = await service.getClassSource(
    { artifactId: uniqueArtifact.artifactId, className: "com.example.Shared", mode: "full", allowDecompile: false },
    { includeSourceFilePath: true }
  );
  assert.notEqual(redirectedRead.artifactId, uniqueArtifact.artifactId);
  assert.equal(redirectedRead.sourceFilePath, "com/example/Shared.java", "the path comes from the redirected nested artifact");
});

test("source recovery keeps false on source calls without changing the service's shared suggestion objects", async () => {
  const suggestions = [
    { tool: "get-class-source", params: { target: { kind: "artifact", artifactId: "artifact-stub" }, className: "a.B" } },
    { tool: "source-export", params: { target: { kind: "artifact", artifactId: "artifact-stub" }, classes: ["a.B"], outputDir: "/tmp/recovered-source" } }
  ];
  const original = structuredClone(suggestions);
  for (const name of ["source-read", "source-export"] as const) {
    for (const phase of ["resolve", "class"] as const) {
      for (const suggestedCall of suggestions) {
        const failure = createError({ code: ERROR_CODES.MAPPING_NOT_APPLIED, message: "Use another source.", details: { suggestedCall } });
        const services = stubServices(phase === "resolve"
          ? { resolveArtifact: async () => { throw failure; } }
          : { getClassSource: async () => { throw failure; } });
        const reply = await injected(name, {
          target: { kind: "jar", jarPath: "/source.jar" }, classes: ["a.B"], allowDecompile: false,
          ...(name === "source-export" ? { outputDir: join(root, "recovery-export") } : {})
        }, services);
        const action = reply.meta.nextActions![0]!;
        assert.equal(action.tool, suggestedCall.tool === "get-class-source" ? "source-read" : "source-export");
        assert.equal(action.params.allowDecompile, false);
        assert.deepEqual(finalizeNextActions([action]), [action]);
        assert.equal(phase === "resolve" ? reply.error?.code : reply.result!.items![0]!.error.code, "ERR_MAPPING_NOT_APPLIED");
      }
    }
  }
  assert.deepEqual(suggestions, original);
});

test("source-read matches get-class-source for one class and batch-class-source for several", async () => {
  const one = await catalog("source-read", { target: jarTarget(), classes: ["com.example.Widget"], mode: "snippet", maxLines: 50 });
  const legacy = (await eightX("get-class-source", {
    target: legacyJarTarget(),
    className: "com.example.Widget",
    mode: "snippet",
    maxLines: 50
  })).envelope.result!;
  assert.equal(Object.hasOwn(legacy, "sourceFilePath"), false, "the legacy reply keeps internal export metadata out");
  const item = one.envelope.result!.items![0]!;
  assert.equal(item.status, "ok");
  assert.equal(item.sourceText, legacy.sourceText);
  assert.equal(item.totalLines, legacy.totalLines);
  assert.deepEqual(item.returnedRange, legacy.returnedRange);
  assert.equal(one.envelope.result!.artifact.artifactId, legacy.artifactId);
  assert.deepEqual(one.envelope.result!.counts, { total: 1, ok: 1, failed: 0 });
  assert.equal("truncated" in item, false, "no truncation flag inside an item");

  const outline = await catalog("source-read", { target: jarTarget(), classes: ["com.example.Gadget"] });
  const legacyOutline = (await eightX("get-class-source", { target: legacyJarTarget(), className: "com.example.Gadget" }))
    .envelope.result!;
  assert.equal(outline.envelope.result!.items![0]!.sourceText, legacyOutline.sourceText, "metadata is the default mode");
  assert.equal("returnedRange" in outline.envelope.result!.items![0]!, false);

  const classes = ["com.example.Widget", "com.example.Gadget"];
  const several = await catalog("source-read", { target: jarTarget(), classes, mode: "full" });
  const batch = (await eightX("batch-class-source", {
    target: legacyJarTarget(),
    entries: classes.map((className) => ({ className, mode: "full" }))
  })).envelope.result!;
  assert.deepEqual(
    several.envelope.result!.items!.map((entry) => entry.sourceText),
    batch.results.map((entry: { result: { sourceText: string } }) => entry.result.sourceText)
  );
  assert.deepEqual(several.envelope.result!.items!.map((entry) => entry.className), classes, "items keep request order");
  assert.equal(several.envelope.result!.artifact.artifactId, batch.summary.sharedArtifactId);
});

test("a class that fails stays inside its item while the other classes are read", async () => {
  const reply = await catalog("source-read", {
    target: jarTarget(),
    classes: ["com.example.Widget", "com.example.NoSuchWidget"],
    mode: "full"
  });
  const legacy = (await eightX("get-class-source", {
    target: legacyJarTarget(),
    className: "com.example.NoSuchWidget",
    mode: "full"
  })).envelope.error!;
  assert.equal(reply.isError, false);
  const [found, missing] = reply.envelope.result!.items!;
  assert.equal(found!.status, "ok");
  assert.equal(missing!.status, "not_found");
  for (const key of ["code", "retryClass", "issueOrigin"]) {
    assert.equal(missing!.error[key], legacy[key], key);
  }
  assert.equal(typeof missing!.error.detail, "string");
  assert.deepEqual(reply.envelope.result!.counts, { total: 2, ok: 1, failed: 1 });
  const lookup = reply.envelope.meta.nextActions?.find((action) => action.tool === "class-find");
  assert.equal(legacy.suggestedCall?.tool, "find-class", "positive control: the service suggests a class lookup");
  assert.deepEqual(lookup?.params, {
    target: { kind: "artifact", artifactId: reply.envelope.result!.artifact.artifactId },
    className: "NoSuchWidget"
  });

  assert.ok(
    missing!.error.hints?.some((hint: string) => hint.includes("class-find")),
    "the service's recovery hint stays on the item, with the catalog name"
  );

  const nearMiss = await catalog("source-read", { target: jarTarget(), classes: ["com.example.Widgit"] });
  const legacyNearMiss = (await eightX("get-class-source", { target: legacyJarTarget(), className: "com.example.Widgit" }))
    .envelope.error!;
  assert.ok(legacyNearMiss.didYouMean?.length > 0, "positive control: the service names near-miss classes");
  assert.deepEqual(nearMiss.envelope.result!.items![0]!.error.didYouMean, legacyNearMiss.didYouMean);

  const members = await catalog("member-list", { target: jarTarget(), classes: ["com.example.NoSuchWidget", "com.example.Gadget"] });
  assert.equal(members.isError, false);
  assert.deepEqual(members.envelope.result!.items!.map((item) => item.status), ["not_found", "ok"]);
  assert.equal(members.envelope.result!.items![0]!.error.code, "ERR_CLASS_NOT_FOUND");
});

test("the source family fails the whole call like the 8.x tools when the shared target fails", async () => {
  const request = { target: { kind: "artifact", artifactId: "no-such-artifact" }, classes: ["com.example.Widget"] };
  const legacy = (await eightX("get-class-source", {
    target: { kind: "artifact", artifactId: "no-such-artifact" },
    className: "com.example.Widget"
  })).envelope.error!;
  for (const name of ["source-read", "member-list"]) {
    const { envelope, isError } = await catalog(name, request);
    assert.equal(isError, true, name);
    for (const key of ["code", "retryClass", "issueOrigin"]) {
      assert.equal(envelope.error?.[key], legacy[key], `${name} ${key}`);
    }
  }
  const exportDir = mkdtempSync(join(tmpdir(), "catalog-source-export-fail-"));
  const exported = await catalog("source-export", { ...request, outputDir: exportDir });
  assert.equal(exported.isError, true);
  assert.equal(exported.envelope.error?.code, legacy.code);
});

test("source-read reports a line or character cut in meta.truncation and its continuation reads on", async () => {
  const first = await catalog("source-read", {
    target: jarTarget(),
    classes: ["com.example.Widget"],
    mode: "snippet",
    maxLines: 5
  });
  assert.deepEqual(first.envelope.meta.truncation, [{ field: "items[0].sourceText", limitedBy: "maxLines" }]);
  const next = first.envelope.meta.nextActions?.find((action) => action.tool === "source-read");
  assert.ok(next, "a continuation is offered");
  assert.equal(next.params.startLine, 6);
  assert.deepEqual(next.params.classes, ["com.example.Widget"]);

  const second = await catalog("source-read", next.params);
  const legacySecond = (await eightX("get-class-source", {
    target: legacyJarTarget(),
    className: "com.example.Widget",
    mode: "snippet",
    startLine: 6,
    maxLines: 5
  })).envelope.result!;
  assert.equal(second.envelope.result!.items![0]!.sourceText, legacySecond.sourceText);
  assert.deepEqual(second.envelope.result!.items![0]!.returnedRange, { start: 6, end: 10 });

  const chars = await catalog("source-read", {
    target: jarTarget(),
    classes: ["com.example.Gadget", "com.example.Widget"],
    mode: "full",
    maxChars: 40
  });
  assert.deepEqual(chars.envelope.meta.truncation, [
    { field: "items[0].sourceText", limitedBy: "maxChars" },
    { field: "items[1].sourceText", limitedBy: "maxChars" }
  ]);
  for (const item of chars.envelope.result!.items!) {
    assert.ok(item.sourceText.length <= 40);
    assert.equal("charsTruncated" in item, false);
  }

  const whole = await catalog("source-read", { target: jarTarget(), classes: ["com.example.Gadget"], mode: "full" });
  assert.equal(whole.envelope.meta.truncation, undefined, "nothing was cut");
  assert.equal(whole.envelope.meta.nextActions, undefined);
});

test("a source-read continuation keeps the window the read applied", async () => {
  const first = await catalog("source-read", { target: jarTarget(), classes: ["com.example.Long"], mode: "snippet" });
  const item = first.envelope.result!.items![0]!;
  assert.deepEqual(item.returnedRange, { start: 1, end: 200 }, "snippet mode reads 200 lines by default");
  assert.deepEqual(first.envelope.meta.truncation, [{ field: "items[0].sourceText", limitedBy: "maxLines" }]);
  const next = first.envelope.meta.nextActions?.find((action) => action.tool === "source-read");
  assert.equal(next?.params.startLine, 201);
  assert.equal(next?.params.maxLines, 200, "the default window travels with the continuation");
  const second = await catalog("source-read", next!.params);
  assert.deepEqual(second.envelope.result!.items![0]!.returnedRange, { start: 201, end: 400 });

  const bounded = await catalog("source-read", {
    target: jarTarget(),
    classes: ["com.example.Long"],
    mode: "snippet",
    endLine: 30,
    maxLines: 10
  });
  const boundedNext = bounded.envelope.meta.nextActions?.find((action) => action.tool === "source-read");
  assert.equal(boundedNext?.params.startLine, 11);
  assert.equal(boundedNext?.params.endLine, 30, "the requested end line is kept");
  assert.equal(boundedNext?.params.maxLines, 10);
  const boundedSecond = await catalog("source-read", boundedNext!.params);
  assert.deepEqual(boundedSecond.envelope.result!.items![0]!.returnedRange, { start: 11, end: 20 });
  const third = await catalog(
    "source-read",
    boundedSecond.envelope.meta.nextActions!.find((action) => action.tool === "source-read")!.params
  );
  assert.deepEqual(third.envelope.result!.items![0]!.returnedRange, { start: 21, end: 30 });
  assert.equal(third.envelope.meta.nextActions, undefined, "the window ends at endLine");
});

test("a class in several nested jars is ambiguous and offers an artifact-resolve call per jar", async () => {
  const services = stubServices({
    getClassSource: async (input: { className: string }) => {
      if (input.className !== "com.example.Shared") return sourceOutput(input.className);
      throw createError({
        code: ERROR_CODES.NESTED_JAR_AMBIGUOUS,
        message: 'Class "com.example.Shared" exists in 2 nested jars bundled by this shell jar; refusing to pick one automatically.',
        details: {
          className: "com.example.Shared",
          nextAction: "Resolve the intended nested jar as its own artifact, then query the class against that artifactId.",
          ...buildSuggestedCall({
            tool: "resolve-artifact",
            params: undefined,
            examples: ["a", "b"].map((name) => ({
              params: { target: { kind: "jar", value: `/cache/nested/${name}.jar` } },
              reason: `Query classes inside "META-INF/jars/${name}.jar" directly.`
            }))
          })
        }
      });
    }
  });
  const envelope = await injected(
    "source-read",
    { target: { kind: "jar", jarPath: "/shell.jar" }, classes: ["com.example.Shared", "com.example.Own"] },
    services
  );
  const [shared, own] = envelope.result!.items!;
  assert.equal(shared!.status, "ambiguous");
  assert.equal(shared!.error.code, "ERR_NESTED_JAR_AMBIGUOUS");
  assert.deepEqual(shared!.error.hints, [
    "Resolve the intended nested jar as its own artifact, then query the class against that artifactId."
  ]);
  assert.equal(own!.status, "ok");
  const resolves = envelope.meta.nextActions?.filter((action) => action.tool === "artifact-resolve") ?? [];
  assert.deepEqual(
    resolves.map((action) => action.params),
    ["a", "b"].map((name) => ({ target: { kind: "jar", jarPath: `/cache/nested/${name}.jar` } }))
  );
  for (const action of resolves) {
    assert.equal(action.template, undefined);
    assert.deepEqual(finalizeNextActions([action]), [action], "the artifact-resolve call validates");
  }
});

test("an internal or database failure while reading one class stays in that class's item", async () => {
  const services = stubServices({
    getClassSource: async (input: { className: string }) => {
      if (input.className === "a.Broken") throw new Error("boom");
      if (input.className === "a.Corrupt") {
        throw Object.assign(new Error("database disk image is malformed"), { code: "ERR_SQLITE_ERROR", errcode: 11 });
      }
      return sourceOutput(input.className);
    }
  });
  const envelope = await injected(
    "source-read",
    { target: { kind: "version", version: "1.21.10" }, classes: ["a.Broken", "a.Corrupt", "a.Fine"], mode: "full" },
    services
  );
  assert.equal(envelope.error, undefined, "the call itself succeeds");
  const [broken, corrupt, fine] = envelope.result!.items!;
  assert.equal(broken!.status, "error");
  assert.equal(broken!.error.code, "ERR_INTERNAL");
  assert.equal(broken!.error.detail, "Unexpected server error.");
  assert.equal(corrupt!.status, "error");
  assert.equal(corrupt!.error.code, "ERR_DB_FAILURE");
  assert.equal(fine!.status, "ok");
  assert.deepEqual(envelope.result!.counts, { total: 3, ok: 1, failed: 2 });

  const exportDir = mkdtempSync(join(tmpdir(), "catalog-source-export-internal-"));
  const exported = await injected(
    "source-export",
    { target: { kind: "version", version: "1.21.10" }, classes: ["a.Broken"], outputDir: exportDir },
    stubServices({ getClassSource: services.getClassSource })
  );
  assert.equal(exported.result!.items![0]!.error.code, "ERR_INTERNAL");

  const members = await injected(
    "member-list",
    { target: { kind: "version", version: "1.21.10" }, classes: ["a.Broken"] },
    stubServices({
      getClassMembers: async () => {
        throw new Error("boom");
      }
    })
  );
  assert.equal(members.result!.items![0]!.error.code, "ERR_INTERNAL");
});

test("a class error whose service suggestion fails validation keeps the internal fallback sentence out of its hints", async () => {
  const failure = () =>
    createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: "No mapping path for this class.",
      details: {
        nextAction: "Resolve the artifact with another mapping.",
        ...buildSuggestedCall({ tool: "resolve-artifact", params: { mapping: "obfuscated" } })
      }
    });
  const { mapErrorToProblem } = await import("../../src/tool-guidance.ts");
  const eightXProblem = mapErrorToProblem(failure(), "positive-control", { tool: "source-read" });
  assert.ok(eightXProblem.hints?.includes(FALLBACK_SENTENCE), "positive control: the 8.x mapping appends the sentence");

  const envelope = await injected(
    "source-read",
    { target: { kind: "version", version: "1.21.10" }, classes: ["a.Unmapped"], mode: "full" },
    stubServices({
      getClassSource: async () => {
        throw failure();
      }
    })
  );
  const item = envelope.result!.items![0]!;
  assert.equal(item.status, "unavailable");
  assert.deepEqual(item.error.hints, ["Resolve the artifact with another mapping."]);
  assert.equal(JSON.stringify(envelope).includes(FALLBACK_SENTENCE), false);
});

test("member-list summary members equal the 8.x signatures projection", async () => {
  const className = "com.example.Widget";
  const summary = await catalog("member-list", {
    target: jarTarget(),
    classes: [className],
    access: "all",
    includeSynthetic: true,
    includeInherited: true,
    detail: "summary"
  });
  const legacy = (await eightX("get-class-members", {
    target: legacyJarTarget(),
    className,
    access: "all",
    includeSynthetic: true,
    includeInherited: true,
    projection: "signatures"
  })).envelope.result!;
  const members = summary.envelope.result!.items![0]!.members;
  assert.ok(members.methods.length > 0, "positive control: the summary lists methods");
  assert.deepEqual(members, legacy.members);
});

test("member-list matches get-class-members for one class and batch-class-members for several", async () => {
  const one = await catalog("member-list", { target: jarTarget(), classes: ["com.example.Widget"], access: "all" });
  const legacy = (await eightX("get-class-members", {
    target: legacyJarTarget(),
    className: "com.example.Widget",
    access: "all"
  })).envelope.result!;
  const item = one.envelope.result!.items![0]!;
  assert.equal(item.status, "ok");
  assert.deepEqual(item.members, legacy.members);
  assert.deepEqual(item.counts, legacy.counts);
  assert.ok(item.members.methods.some((member: { name: string }) => member.name === "relabel"), "positive control");

  const withOptions = await catalog("member-list", {
    target: jarTarget(),
    classes: ["com.example.Widget"],
    withDescriptors: true,
    memberPattern: "size"
  });
  const legacyWithOptions = (await eightX("get-class-members", {
    target: legacyJarTarget(),
    className: "com.example.Widget",
    includeDescriptors: true,
    memberPattern: "size"
  })).envelope.result!;
  assert.deepEqual(withOptions.envelope.result!.items![0]!.members, legacyWithOptions.members);

  const classes = ["com.example.Widget", "com.example.Gadget"];
  const several = await catalog("member-list", { target: jarTarget(), classes });
  const batch = (await eightX("batch-class-members", {
    target: legacyJarTarget(),
    entries: classes.map((className) => ({ className }))
  })).envelope.result!;
  assert.deepEqual(
    several.envelope.result!.items!.map((entry) => entry.members),
    batch.results.map((entry: { result: { members: unknown } }) => entry.result.members)
  );
  assert.deepEqual(several.envelope.result!.counts, { total: 2, ok: 2, failed: 0 });
  assert.equal(several.envelope.meta.pagination, undefined, "a several-class listing has no single cursor");
});

test("member-list keeps every item's class name and status at every detail level", async () => {
  const classes = ["com.example.Widget", "com.example.NoSuchWidget"];
  const levels: Record<string, Item[]> = {};
  for (const detail of DETAIL_LEVELS) {
    const { envelope } = await catalog("member-list", { target: jarTarget(), classes, detail });
    levels[detail] = envelope.result!.items!;
    assert.deepEqual(levels[detail]!.map((item) => item.className), classes, detail);
    assert.deepEqual(levels[detail]!.map((item) => item.status), ["ok", "not_found"], detail);
    assert.ok(levels[detail]![0]!.members, `${detail} keeps the members`);
  }
  assert.equal("context" in levels.summary![0]!, false, "summary leaves out the context");
  assert.equal(levels.summary![0]!.members.methods[0].jvmDescriptor, undefined, "summary lists name and signature");
  assert.ok(levels.summary![0]!.members.methods[0].javaSignature);
  assert.ok(levels.standard![0]!.context, "standard keeps the context");
  assert.ok(levels.standard![0]!.members.methods[0].jvmDescriptor, "standard keeps method descriptors");
  assert.equal("provenance" in levels.standard![0]!, false, "provenance is kept only at full");
  assert.ok(levels.full![0]!.provenance);
  assert.ok(levels.full![1]!.error, "a failed item keeps its error at every level");
  assert.ok(levels.summary![1]!.error);
});

test("withDescriptors and withAnnotations hold at every detail level, and withProvenance adds the diagnostics", async () => {
  for (const detail of DETAIL_LEVELS) {
    const plain = await catalog("member-list", { target: jarTarget(), classes: ["com.example.Gadget"], detail });
    const plainField = plain.envelope.result!.items![0]!.members.fields.find((field: { name: string }) => field.name === "legacy");
    assert.equal(plainField.jvmDescriptor, undefined, `${detail}: no field descriptor without the flag`);
    assert.equal(plainField.annotations, undefined, `${detail}: no annotations without the flag`);

    const flagged = await catalog("member-list", {
      target: jarTarget(),
      classes: ["com.example.Gadget"],
      detail,
      withDescriptors: true,
      withAnnotations: true
    });
    const field = flagged.envelope.result!.items![0]!.members.fields.find((entry: { name: string }) => entry.name === "legacy");
    assert.equal(field.jvmDescriptor, "I", `${detail}: withDescriptors keeps the descriptor`);
    assert.deepEqual(field.annotations, ["@java.lang.Deprecated"], `${detail}: withAnnotations keeps the annotations`);
  }
  const legacy = (await eightX("get-class-members", {
    target: legacyJarTarget(),
    className: "com.example.Gadget",
    includeAnnotations: true,
    includeDescriptors: true
  })).envelope.result!;
  const standard = await catalog("member-list", {
    target: jarTarget(),
    classes: ["com.example.Gadget"],
    withDescriptors: true,
    withAnnotations: true
  });
  assert.deepEqual(standard.envelope.result!.items![0]!.members, legacy.members);

  const plainSource = await catalog("source-read", { target: jarTarget(), classes: ["com.example.Gadget"] });
  assert.equal("provenance" in plainSource.envelope.result!.items![0]!, false);
  const withProvenance = await catalog("source-read", {
    target: jarTarget(),
    classes: ["com.example.Gadget"],
    withProvenance: true
  });
  const legacyFull = (await eightX("get-class-source", {
    target: legacyJarTarget(),
    className: "com.example.Gadget",
    includeProvenance: true
  })).envelope.result!;
  const item = withProvenance.envelope.result!.items![0]!;
  assert.deepEqual(item.qualityFlags, legacyFull.qualityFlags);
  assert.deepEqual(item.artifactContents, legacyFull.artifactContents);
  assert.equal(item.provenance?.resolvedFrom?.origin, legacyFull.provenance.resolvedFrom.origin);
});

test("member-list reports partial and unavailable classes and a capped decompiled-source fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-source-members-status-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "artifact-partial",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["partial-source-no-net-minecraft"],
    binaryJarPath: join(root, "minecraft.jar"),
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
  const partial = await injected(
    "member-list",
    {
      target: { kind: "artifact", artifactId: "artifact-partial" },
      classes: ["net.minecraft.world.entity.player.Player"],
      mapping: "mojang",
      limit: 1
    },
    service as unknown as CatalogServices
  );
  const partialItem = partial.result!.items![0]!;
  assert.equal(partialItem.status, "partial");
  assert.equal(partialItem.decompiledMemberCounts.total, 2);
  const listed = ["constructors", "fields", "methods"].reduce(
    (sum, kind) => sum + partialItem.decompiledFallback[kind].length,
    0
  );
  assert.equal(listed, 1, "limit caps the fallback");
  assert.deepEqual(partial.meta.truncation, [{ field: "items[0].decompiledFallback", limitedBy: "limit" }]);
  assert.equal(partial.meta.pagination?.hasMore, false, "the fallback has no cursor");

  const whole = await injected(
    "member-list",
    {
      target: { kind: "artifact", artifactId: "artifact-partial" },
      classes: ["net.minecraft.world.entity.player.Player"],
      mapping: "mojang"
    },
    service as unknown as CatalogServices
  );
  assert.equal(whole.result!.items![0]!.status, "partial");
  assert.equal(whole.meta.truncation, undefined, "an uncapped fallback is not reported as cut");

  stubExplorer(service, { throwError: new Error("synthetic binary parse failure") });
  const unavailable = await injected(
    "member-list",
    {
      target: { kind: "artifact", artifactId: "artifact-partial" },
      classes: ["net.minecraft.world.entity.LivingEntity"],
      mapping: "mojang"
    },
    service as unknown as CatalogServices
  );
  const unavailableItem = unavailable.result!.items![0]!;
  assert.equal(unavailableItem.status, "unavailable");
  assert.match(unavailableItem.unavailableReason, /synthetic binary parse failure/);
  assert.deepEqual(unavailable.result!.counts, { total: 1, ok: 0, failed: 0 });
  const readSource = unavailable.meta.nextActions?.find((action) => action.tool === "source-read");
  assert.deepEqual(readSource?.params, {
    target: { kind: "artifact", artifactId: "artifact-partial" },
    mapping: "mojang",
    mode: "snippet",
    classes: ["net.minecraft.world.entity.LivingEntity"]
  });
  assert.deepEqual(finalizeNextActions([readSource!]), [readSource]);
});

test("member-list pages one class with a validated next-page call and reports several-class cuts", async () => {
  const first = await catalog("member-list", { target: jarTarget(), classes: ["com.example.Many"], limit: 2 });
  const legacyFirst = (await eightX("get-class-members", {
    target: legacyJarTarget(),
    className: "com.example.Many",
    maxMembers: 2
  })).envelope.result!;
  assert.deepEqual(first.envelope.result!.items![0]!.members, legacyFirst.members);
  assert.deepEqual(first.envelope.meta.pagination, { hasMore: true, nextCursor: legacyFirst.nextCursor });
  assert.deepEqual(first.envelope.meta.truncation, [{ field: "items[0].members", limitedBy: "limit" }]);
  assert.equal("nextCursor" in first.envelope.result!.items![0]!, false, "no cursor inside result");

  const next = first.envelope.meta.nextActions?.find((action) => action.tool === "member-list");
  assert.ok(next, "a next-page call is offered");
  assert.equal(next.params.cursor, legacyFirst.nextCursor);
  const second = await catalog("member-list", next.params);
  const legacySecond = (await eightX("get-class-members", {
    target: legacyJarTarget(),
    className: "com.example.Many",
    maxMembers: 2,
    cursor: legacyFirst.nextCursor
  })).envelope.result!;
  assert.deepEqual(second.envelope.result!.items![0]!.members, legacySecond.members);
  assert.equal(second.envelope.meta.pagination?.hasMore, legacySecond.nextCursor !== undefined);

  const several = await catalog("member-list", {
    target: jarTarget(),
    classes: ["com.example.Gadget", "com.example.Many"],
    limit: 2
  });
  assert.deepEqual(several.envelope.meta.truncation, [{ field: "items[1].members", limitedBy: "limit" }]);
  assert.equal(several.envelope.meta.pagination, undefined);
  const perClass = several.envelope.meta.nextActions?.find((action) => action.tool === "member-list");
  assert.deepEqual(perClass?.params.classes, ["com.example.Many"], "the next page names the cut class alone");
  const followed = await catalog("member-list", perClass!.params);
  assert.deepEqual(followed.envelope.result!.items![0]!.members, legacySecond.members);
});

test("source-export writes the same text as get-class-source outputFile under <outputDir>/<package path>", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "catalog-source-export-"));
  const legacyDir = mkdtempSync(join(tmpdir(), "catalog-source-export-legacy-"));
  const reply = await catalog("source-export", {
    target: jarTarget(),
    classes: ["com.example.Widget", "com.example.Gadget", "com.example.Widget$Part"],
    outputDir
  });
  assert.equal(reply.isError, false);
  const items = reply.envelope.result!.items!;
  assert.deepEqual(items.map((item) => item.status), ["ok", "ok", "ok"]);
  assert.equal(reply.envelope.result!.outputDir, outputDir);
  assert.equal(items[0]!.path, join(outputDir, "com", "example", "Widget.java"));
  assert.equal(items[1]!.path, join(outputDir, "com", "example", "Gadget.java"));
  assert.equal(items[2]!.path, items[0]!.path, "a nested class writes its top-level class's file");
  for (const [index, className] of ["com.example.Widget", "com.example.Gadget"].entries()) {
    const legacyFile = join(legacyDir, `${className}.java`);
    const legacy = (await eightX("get-class-source", {
      target: legacyJarTarget(),
      className,
      mode: "full",
      outputFile: legacyFile
    })).envelope.result!;
    assert.equal(legacy.outputFile, legacyFile);
    assert.equal(readFileSync(items[index]!.path, "utf8"), readFileSync(legacyFile, "utf8"), className);
  }

  // An existing file with other content is overwritten.
  writeFileSync(items[1]!.path, "stale bytes from an earlier export", "utf8");
  const again = await catalog("source-export", { target: jarTarget(), classes: ["com.example.Gadget"], outputDir });
  assert.equal(again.envelope.result!.items![0]!.status, "ok");
  assert.equal(readFileSync(items[1]!.path, "utf8"), GADGET_SOURCE.replace(/\n$/, ""));
});

test("a source-export write failure is that class's item error naming outputDir", async () => {
  const blocker = join(mkdtempSync(join(tmpdir(), "catalog-source-export-blocked-")), "not-a-directory");
  writeFileSync(blocker, "a file where a directory is needed", "utf8");
  const reply = await catalog("source-export", {
    target: jarTarget(),
    classes: ["com.example.Gadget", "com.example.NoSuchWidget"],
    outputDir: blocker
  });
  assert.equal(reply.isError, false);
  const [blocked, missing] = reply.envelope.result!.items!;
  assert.equal(blocked!.status, "error");
  assert.equal(blocked!.error.code, "ERR_INVALID_INPUT");
  assert.match(blocked!.error.detail, /outputDir/);
  assert.equal(missing!.status, "not_found");
  assert.deepEqual(reply.envelope.result!.counts, { total: 2, ok: 0, failed: 2 });
});

test("export paths follow the source file read, or else the package and the top-level class", () => {
  assert.equal(exportPathFor("/out", "a.b.Outer.Inner", "a/b/Outer.java"), join("/out", "a", "b", "Outer.java"));
  assert.equal(
    exportPathFor("/out", "com.google.gson.internal.$Gson$Types", "com/google/gson/internal/$Gson$Types.java"),
    join("/out", "com", "google", "gson", "internal", "$Gson$Types.java")
  );
  assert.equal(
    exportPathFor(
      "/out",
      "com.google.gson.internal.$Gson$Preconditions",
      "com/google/gson/internal/$Gson$Preconditions.java"
    ),
    join("/out", "com", "google", "gson", "internal", "$Gson$Preconditions.java")
  );
  assert.equal(exportPathFor("/out", "a.b.C"), join("/out", "a", "b", "C.java"));
  assert.equal(exportPathFor("/out", "a.b.C$D$E"), join("/out", "a", "b", "C.java"));
  assert.equal(exportPathFor("/out", "Top"), join("/out", "Top.java"));
  assert.equal(
    exportPathFor("/out", "a.b.C", "../../escape/C.java"),
    join("/out", "a", "b", "C.java"),
    "a source path that leaves outputDir is not used"
  );
});

test("source-export names files after the source file read: a dotted nested name and a $-prefixed top-level name", async () => {
  const found = await catalog("class-find", { target: jarTarget(), className: "Part" });
  const nestedName = found.envelope.result!.classes.find((entry: { className: string }) => entry.className.endsWith("Part"))
    ?.className as string;
  assert.equal(nestedName, "com.example.Widget.Part", "class-find reports the nested class with dots");

  const outputDir = mkdtempSync(join(tmpdir(), "catalog-source-export-names-"));
  const reply = await catalog("source-export", {
    target: jarTarget(),
    classes: [nestedName, "com.google.gson.internal.$Gson$Types"],
    outputDir
  });
  const [nested, gson] = reply.envelope.result!.items!;
  assert.equal(nested!.status, "ok", JSON.stringify(nested));
  assert.equal(nested!.path, join(outputDir, "com", "example", "Widget.java"));
  assert.equal(gson!.status, "ok", JSON.stringify(gson));
  assert.equal(gson!.path, join(outputDir, "com", "google", "gson", "internal", "$Gson$Types.java"));
  assert.equal(readFileSync(gson!.path, "utf8"), GSON_TYPES_SOURCE.replace(/\n$/, ""));
});

test("a snippet export that writes only the 200-line window reports the cut in meta.truncation", async () => {
  const outputDir = join(root, "export-snippet");
  const snippet = await catalog("source-export", {
    target: jarTarget(),
    classes: ["com.example.Gadget", "com.example.Long"],
    outputDir,
    mode: "snippet"
  });
  const [gadget, long] = snippet.envelope.result!.items!;
  assert.equal(long!.status, "ok");
  assert.equal(readFileSync(long!.path, "utf8").split("\n").length, 200, "the file holds the snippet window");
  assert.ok(long!.totalLines > 200);
  assert.deepEqual(snippet.envelope.meta.truncation, [{ field: "items[1].path", limitedBy: "maxLines" }], "only the cut class");
  assert.equal(gadget!.status, "ok");

  const full = await catalog("source-export", { target: jarTarget(), classes: ["com.example.Long"], outputDir });
  assert.equal(readFileSync(full.envelope.result!.items![0]!.path, "utf8").split("\n").length, full.envelope.result!.items![0]!.totalLines);
  assert.equal(full.envelope.meta.truncation, undefined, "positive control: a full export cuts nothing");
});

test("source-export writes under a \\\\wsl.localhost or drive outputDir converted on a WSL host", { skip: process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host" }, async () => {
  const distro = "catalog-distro";
  const windowsPath = (path: string) => path.replace(/^\//, "").replace(/\//g, "\\");
  // Both spellings convert into this test's temporary root: the UNC one directly, the drive one
  // through /mnt/c/../.., which resolves before anything is written.
  const cases: Array<[string, string]> = [
    [`\\\\wsl.localhost\\${distro}\\${windowsPath(join(root, "export-unc"))}`, join(root, "export-unc")],
    [`C:\\..\\..\\${windowsPath(join(root, "export-drive"))}`, join(root, "export-drive")]
  ];
  await withEnv({ WSL_DISTRO_NAME: distro }, async () => {
    for (const [outputDir, converted] of cases) {
      const reply = await catalog("source-export", { target: jarTarget(), classes: ["com.example.Gadget"], outputDir });
      assert.equal(reply.envelope.result!.outputDir, converted, `${outputDir} is written as ${converted}`);
      const item = reply.envelope.result!.items![0]!;
      assert.equal(item.status, "ok", JSON.stringify(item));
      assert.equal(item.path, join(converted, "com", "example", "Gadget.java"));
      assert.equal(readFileSync(item.path, "utf8"), GADGET_SOURCE.replace(/\n$/, ""));
    }
    const otherDistro = await catalog("source-export", {
      target: jarTarget(),
      classes: ["com.example.Gadget"],
      outputDir: `\\\\wsl.localhost\\other-distro\\${windowsPath(join(root, "export-other"))}`
    });
    assert.equal(otherDistro.envelope.error?.code, "ERR_INVALID_INPUT", "a path of another distro is refused");
    assert.equal(existsSync(join(root, "export-other")), false);
  });
});

test("every source tool validates its examples and rejects unknown, misspelled and one-class-only keys", async () => {
  for (const spec of SOURCE_TOOL_SPECS) {
    for (const example of spec.examples) {
      assert.equal(spec.inputSchema.safeParse(example).success, true, `${spec.name} example ${JSON.stringify(example)}`);
      const reply = await catalog(spec.name, example);
      assert.notEqual(reply.envelope.error?.detail, "Request validation failed.", `${spec.name} example passes validation`);
    }
    const example = spec.examples[0]!;

    const unknownTop = await catalog(spec.name, { ...example, bogusKey: 1 });
    assert.equal(unknownTop.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.ok(unknownTop.envelope.error?.fieldErrors?.some((entry) => entry.path === "bogusKey"), spec.name);

    const unknownTarget = await catalog(spec.name, {
      ...example,
      target: { ...(example.target as Record<string, unknown>), bogusKey: 1 }
    });
    assert.equal(unknownTarget.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.ok(
      unknownTarget.envelope.error?.fieldErrors?.some((entry) => entry.path === "target.bogusKey"),
      `${spec.name} names target.bogusKey`
    );

    const { classes, ...withoutClasses } = example as Record<string, unknown>;
    const misspelled = await catalog(spec.name, { ...withoutClasses, clases: classes });
    assert.equal(misspelled.envelope.error?.code, "ERR_INVALID_INPUT");
    const suggestion = misspelled.envelope.error?.fieldErrors?.find((entry) => entry.path === "clases");
    assert.ok(suggestion?.suggestions?.includes("classes"), `${spec.name}: "clases" suggests "classes"`);

    const empty = await catalog(spec.name, { ...example, classes: [] });
    assert.equal(empty.envelope.error?.code, "ERR_INVALID_INPUT");
    assert.ok(empty.envelope.error?.fieldErrors?.some((entry) => entry.path === "classes"));
  }

  const twoClasses = { target: jarTarget(), classes: ["com.example.Widget", "com.example.Gadget"] };
  for (const [name, extra] of [
    ["source-read", { startLine: 2 }],
    ["source-read", { endLine: 4 }],
    ["member-list", { cursor: "abc" }]
  ] as const) {
    const reply = await catalog(name, { ...twoClasses, ...extra });
    const field = Object.keys(extra)[0]!;
    assert.equal(reply.envelope.error?.code, "ERR_INVALID_INPUT", `${name} ${field} with two classes`);
    assert.deepEqual(reply.envelope.error?.fieldErrors?.map((entry) => entry.path), [field]);
  }
  const reversed = await catalog("source-read", { ...twoClasses, classes: ["com.example.Widget"], startLine: 5, endLine: 2 });
  assert.equal(reversed.envelope.error?.code, "ERR_INVALID_INPUT");
  const tooMany = await catalog("source-read", {
    target: jarTarget(),
    classes: Array.from({ length: 51 }, (_, index) => `com.example.C${index}`)
  });
  assert.equal(tooMany.envelope.error?.code, "ERR_INVALID_INPUT");
});

test("service suggestions naming get-class-source and get-class-members become valid catalog calls", () => {
  const cases: Array<[{ tool: string; params: Record<string, unknown> }, { tool: string; params: Record<string, unknown> }]> = [
    [
      {
        tool: "get-class-source",
        params: {
          className: "a.B",
          target: { kind: "artifact", artifactId: "a1" },
          mode: "snippet",
          startLine: 10,
          maxLines: 50,
          mapping: "mojang",
          allowDecompile: false
        }
      },
      {
        tool: "source-read",
        params: {
          target: { kind: "artifact", artifactId: "a1" },
          mapping: "mojang",
          allowDecompile: false,
          mode: "snippet",
          startLine: 10,
          maxLines: 50,
          classes: ["a.B"]
        }
      }
    ],
    [
      { tool: "get-class-source", params: { className: "a.B", target: { kind: "version", value: "1.21.10" }, scope: "vanilla" } },
      { tool: "source-read", params: { target: { kind: "version", version: "1.21.10", scope: "vanilla" }, classes: ["a.B"] } }
    ],
    [
      {
        tool: "get-class-members",
        params: {
          className: "a.B",
          artifactId: "a1",
          access: "all",
          maxMembers: 20,
          includeDescriptors: true,
          cursor: "c1"
        }
      },
      {
        tool: "member-list",
        params: {
          target: { kind: "artifact", artifactId: "a1" },
          access: "all",
          cursor: "c1",
          classes: ["a.B"],
          limit: 20,
          withDescriptors: true
        }
      }
    ]
  ];
  for (const [service, expected] of cases) {
    const translated = translateServiceSuggestedCall(service);
    assert.deepEqual(translated, expected, service.tool);
    assert.deepEqual(finalizeNextActions([translated!]), [expected], `${expected.tool} call validates`);
  }
  assert.equal(
    translateServiceSuggestedCall({ tool: "get-class-source", params: { target: { kind: "artifact", artifactId: "a1" } } }),
    undefined,
    "a suggestion without a class has no catalog form"
  );
});

test("a mod jar read through a jar target matches the 8.x mod tools", async () => {
  const runs = mockJavaRunner(async (options) => {
    const outputDir = options.args.at(-1)!;
    for (const [path, content] of Object.entries(MOD_SOURCES)) {
      mkdirSync(join(outputDir, path, ".."), { recursive: true });
      writeFileSync(join(outputDir, path), content, "utf8");
    }
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });
  const normalize = (text: string) => text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "").replace(/\s+$/, "");
  const classes = ["com.example.mod.DemoMod", "com.example.mod.Other"];

  const read = await catalog("source-read", { target: { kind: "jar", jarPath: modJarPath }, classes, mode: "full" });
  assert.deepEqual(read.envelope.result!.items!.map((item) => item.status), ["ok", "ok"], JSON.stringify(read.envelope));
  for (const [index, className] of classes.entries()) {
    const legacy = (await eightX("get-mod-class-source", { jarPath: modJarPath, className })).envelope.result!;
    const text = read.envelope.result!.items![index]!.sourceText as string;
    assert.ok(text.includes("package com.example.mod;"), "positive control: decompiled text was read");
    assert.equal(normalize(text), normalize(legacy.content), className);
  }
  assert.ok(runs.calls.length >= 2, "both paths ran the decompiler");
  const legacyRead = (await eightX("get-class-source", {
    target: { kind: "jar", value: modJarPath },
    className: classes[0],
    mode: "full"
  })).envelope;
  assert.ok(
    legacyRead.meta.warnings?.some((warning: string) => warning.startsWith("Source is decompiled")),
    "positive control: the service attaches the decompiled-source notice"
  );
  assert.equal(
    read.envelope.meta.warnings?.some((warning) => warning.message.startsWith("Source is decompiled")) ?? false,
    false,
    "the routine decompiled-source notice is left out"
  );

  const access = (signature: string) =>
    /\bpublic\b/.test(signature) ? "public" : /\bprivate\b/.test(signature) ? "private" : /\bprotected\b/.test(signature) ? "protected" : "package";
  const flagAccess = (flags: number) =>
    (flags & 0x0001) !== 0 ? "public" : (flags & 0x0002) !== 0 ? "private" : (flags & 0x0004) !== 0 ? "protected" : "package";
  const kinds = ["constructors", "fields", "methods"] as const;
  const listed = await catalog("member-list", {
    target: { kind: "jar", jarPath: modJarPath },
    classes,
    access: "all",
    withDescriptors: true
  });
  for (const [index, className] of classes.entries()) {
    const members = listed.envelope.result!.items![index]!.members;
    const catalogSet = kinds
      .flatMap((kind) =>
        (members[kind] as Array<{ name: string; jvmDescriptor: string; javaSignature: string }>).map(
          (member) => `${kind}|${member.name}|${member.jvmDescriptor}|${access(member.javaSignature)}`
        )
      )
      .sort();
    const legacy = (await eightX("analyze-mod", {
      task: "members",
      subject: { kind: "class", jarPath: modJarPath, className }
    })).envelope.result!;
    const legacySet = kinds
      .flatMap((kind) =>
        (legacy.members.members[kind] as Array<{ name: string; jvmDescriptor: string; accessFlags: number }>).map(
          (member) => `${kind}|${member.name}|${member.jvmDescriptor}|${flagAccess(member.accessFlags)}`
        )
      )
      .sort();
    assert.ok(catalogSet.length > 0, `positive control: ${className} has members`);
    assert.deepEqual(catalogSet, legacySet, className);
  }
  assert.ok(existsSync(modJarPath));
});
