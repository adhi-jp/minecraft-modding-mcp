import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AnalyzeModService, analyzeModSchema } from "../src/entry-tools/analyze-mod-service.ts";
import { SourceService } from "../src/source-service.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

function failingDep(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be invoked by the members task`);
  };
}

async function buildModJar(): Promise<{ jarPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "mod-members-"));
  const jarPath = join(root, "geckolib-fabric-26.2.jar");
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "geckolib" }),
    "software/bernie/geckolib/GeckoLibMod.class": buildClassFile({
      internalName: "software/bernie/geckolib/GeckoLibMod",
      fields: [{ name: "MOD_ID", descriptor: "Ljava/lang/String;", accessFlags: 0x0019 }],
      methods: [
        { name: "onInitialize", descriptor: "()V", accessFlags: 0x0001 },
        // 0x0002 = private: the members task reads all access levels.
        { name: "registerInternals", descriptor: "()V", accessFlags: 0x0002 }
      ]
    })
  });
  return { jarPath, root };
}

test("analyze-mod members task answers from bytecode without any decompiler involvement", async () => {
  const { jarPath, root } = await buildModJar();
  const sourceService = new SourceService(buildTestConfig(root));
  const service = new AnalyzeModService({
    analyzeModJar: failingDep("analyzeModJar"),
    decompileModJar: failingDep("decompileModJar"),
    getModClassSource: failingDep("getModClassSource"),
    searchModSource: failingDep("searchModSource"),
    remapModJar: failingDep("remapModJar"),
    getModClassMembers: (input) => sourceService.getModClassMembers(input)
  });

  const result = (await service.execute(
    analyzeModSchema.parse({
      task: "members",
      subject: { kind: "class", jarPath, className: "software.bernie.geckolib.GeckoLibMod" }
    })
  )) as {
    members?: {
      extractionMethod?: string;
      members?: { fields?: Array<{ name: string }>; methods?: Array<{ name: string }> };
    };
    warnings?: string[];
  };

  assert.equal(result.members?.extractionMethod, "bytecode-only");
  assert.ok(result.members?.members?.fields?.some((field) => field.name === "MOD_ID"));
  assert.ok(result.members?.members?.methods?.some((method) => method.name === "onInitialize"));
  // All access levels are read, including private members.
  assert.ok(result.members?.members?.methods?.some((method) => method.name === "registerInternals"));
  // No context block: the version/namespace heuristic would misreport a mod's
  // own version (26.2 here) as a Minecraft version.
  assert.equal((result.members as { context?: unknown }).context, undefined);
});

test("the members block is emitted even at explicit summary detail", async () => {
  const { jarPath, root } = await buildModJar();
  const sourceService = new SourceService(buildTestConfig(root));
  const service = new AnalyzeModService({
    analyzeModJar: failingDep("analyzeModJar"),
    decompileModJar: failingDep("decompileModJar"),
    getModClassSource: failingDep("getModClassSource"),
    searchModSource: failingDep("searchModSource"),
    remapModJar: failingDep("remapModJar"),
    getModClassMembers: (input) => sourceService.getModClassMembers(input)
  });

  const result = (await service.execute(
    analyzeModSchema.parse({
      task: "members",
      subject: { kind: "class", jarPath, className: "software.bernie.geckolib.GeckoLibMod" },
      detail: "summary"
    })
  )) as { members?: unknown };

  assert.ok(result.members, "the members block is the deliverable and must survive summary detail");
});

test("an invalid jarPath for the members task is rejected as invalid input", async () => {
  const { root } = await buildModJar();
  const sourceService = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      sourceService.getModClassMembers({
        jarPath: "/nonexistent/missing.jar",
        className: "com.example.Anything"
      }),
    (error: Error & { code?: string }) => error.code === "ERR_INVALID_INPUT"
  );
});

test("the members task requires a class subject", () => {
  const parsed = analyzeModSchema.safeParse({
    task: "members",
    subject: { kind: "jar", jarPath: "/tmp/some.jar" }
  });
  assert.equal(parsed.success, false);
});

test("getModClassMembers reports a class missing from the mod jar as CLASS_NOT_FOUND", async () => {
  const { jarPath, root } = await buildModJar();
  const sourceService = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      sourceService.getModClassMembers({
        jarPath,
        className: "software.bernie.geckolib.DoesNotExist"
      }),
    (error: Error & { code?: string }) => error.code === "ERR_CLASS_NOT_FOUND"
  );
});
