/**
 * Service sentences that advise an 8.x input or target shape reach catalog
 * replies in their catalog wording: the resolver's request for a versioned
 * target, the member lookup's requests for a version and a binary jar, and
 * the class lookup's request for a Mojang-mapped lookup of a deobfuscated
 * name. Each case runs the catalog tool through the in-process MCP session on
 * the real services, with the 8.x tool on the same input as the control that
 * the service writes the 8.x sentence.
 *
 * Fixtures, all local: a sources jar whose name carries no version, and
 * artifact rows seeded into the server's own SQLite cache database (one
 * without a version, one without a binary jar, one of a Minecraft version
 * indexed in obfuscated names). Nothing reaches the network and no Java
 * process runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { ALIAS_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { SERVICE_SENTENCE_REWRITES } from "../../src/tools/translation.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-service-sentences-"));
const cacheDir = join(root, "cache");
process.env.MCP_CACHE_DIR = cacheDir;
process.env.MCP_SQLITE_PATH = join(cacheDir, "source-cache.db");

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);

/**
 * 8.x request spellings a catalog reply must not advise: the 8.x target
 * locator `value`, and inputs the catalog tools spell differently or only
 * `artifact-resolve` takes.
 */
const EIGHT_X_INPUTS =
  /\bvalue\s*[}:]|\b(?:queryNamespace|atNamespace|sourceMapping|targetMapping|preferProjectVersion|strictVersion|sourcePriority|gradleUserHome|executionMode)\b|member\.name|\btask=|\binclude:/;

type Envelope = {
  result?: Record<string, any>;
  error?: Record<string, any>;
  meta: Record<string, any>;
};

let session: CatalogSession;
let versionlessSourcesJar: string;

before(async () => {
  versionlessSourcesJar = join(root, "server-sources.jar");
  await createJar(versionlessSourcesJar, {
    "com/example/NoVersion.java": ["package com.example;", "public class NoVersion {}"].join("\n")
  });
  session = await startCatalogSession(CATALOG_TOOL_SPECS);
  const { sourceService } = await import("../../src/index.ts");
  for (const [artifactId, version] of [
    ["art-without-version", undefined],
    ["art-without-binary", "9.0.2"],
    ["art-obfuscated-minecraft", "1.21.10"]
  ] as const) {
    seedIndexedArtifact(sourceService, {
      artifactId,
      origin: "local-jar",
      requestedMapping: "obfuscated",
      mappingApplied: "obfuscated",
      qualityFlags: [],
      ...(version !== undefined ? { version } : {}),
      files: [{ filePath: "com/example/Probe.java", content: "package com.example;\npublic class Probe {}\n" }],
      symbols: [
        { filePath: "com/example/Probe.java", symbolKind: "class", symbolName: "Probe", qualifiedName: "com.example.Probe", line: 2 }
      ]
    });
  }
});

after(async () => {
  await session.close();
});

function envelopeOf(frame: SessionFrame): { envelope: Envelope; text: string } {
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const result = frame.result as { content: Array<{ text: string }>; structuredContent: Envelope };
  return { envelope: result.structuredContent, text: result.content[0]!.text };
}

function rewriteOf(id: string): { service: string; catalog: string } {
  const sentence = SERVICE_SENTENCE_REWRITES.find((entry) => entry.id === id);
  assert.ok(sentence !== undefined && "service" in sentence, `${id} is a fixed sentence`);
  return sentence;
}

/**
 * Calls a catalog tool and checks that its reply names neither an 8.x tool
 * nor an 8.x input, while it carries `catalogWording` (the positive control).
 */
async function catalogReply(name: string, args: unknown, catalogWording: string): Promise<Envelope> {
  const { envelope, text } = envelopeOf(await session.callTool(name, args));
  assert.equal(envelope.meta.tool, name);
  assert.ok(text.includes(JSON.stringify(catalogWording).slice(1, -1)), `the ${name} reply carries the catalog wording: ${text}`);
  assert.doesNotMatch(text, ALIAS_NAME_PATTERN, `no 8.x tool name in the ${name} reply`);
  assert.doesNotMatch(text, EIGHT_X_INPUTS, `no 8.x input in the ${name} reply: ${text}`);
  return envelope;
}

async function eightXText(name: string, args: unknown): Promise<string> {
  return envelopeOf(await session.callTool(name, args)).text;
}

test("a mapped resolution of a jar without a version asks for a version or coordinate target in catalog terms", async () => {
  const { service, catalog } = rewriteOf("resolver-versioned-target");
  const legacy = await eightXText("resolve-artifact", {
    target: { kind: "jar", value: versionlessSourcesJar },
    mapping: "intermediary"
  });
  assert.ok(legacy.includes(JSON.stringify(service).slice(1, -1)), "control: the resolver writes the 8.x sentence");

  const jar = { kind: "jar", jarPath: versionlessSourcesJar };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["artifact-resolve", { target: jar, mapping: "intermediary" }],
    ["source-read", { target: jar, mapping: "yarn", classes: ["com.example.NoVersion"] }],
    ["member-list", { target: jar, mapping: "intermediary", classes: ["com.example.NoVersion"] }],
    ["source-search", { target: jar, mapping: "intermediary", query: "NoVersion" }],
    [
      "mixin-verify-target",
      { target: jar, className: "com.example.NoVersion", kind: "method", memberName: "tick", mapping: "intermediary" }
    ]
  ];
  for (const [name, args] of cases) {
    const envelope = await catalogReply(name, args, catalog);
    assert.equal(envelope.error?.code, "ERR_MAPPING_NOT_APPLIED", name);
    assert.ok(envelope.error?.hints?.includes(catalog), `${name}: the hint is the catalog sentence`);
  }
});

test("a mapped member read of an artifact without a version asks for a version or coordinate target in catalog terms", async () => {
  const { service, catalog } = rewriteOf("member-versioned-target");
  const legacy = await eightXText("get-class-members", {
    target: { kind: "artifact", artifactId: "art-without-version" },
    className: "com.example.Probe",
    mapping: "mojang"
  });
  assert.ok(legacy.includes(JSON.stringify(service).slice(1, -1)), "control: the member lookup writes the 8.x sentence");

  const envelope = await catalogReply(
    "member-list",
    { target: { kind: "artifact", artifactId: "art-without-version" }, mapping: "mojang", classes: ["com.example.Probe"] },
    catalog
  );
  const item = envelope.result!.items[0];
  assert.equal(item.error.code, "ERR_MAPPING_NOT_APPLIED");
  assert.ok(item.error.hints.includes(catalog), "the item's hint is the catalog sentence");
});

test("a member read of an artifact without a binary jar asks for a jar or version target in catalog terms", async () => {
  const { service, catalog } = rewriteOf("member-binary-jar-target");
  const legacy = await eightXText("get-class-members", {
    target: { kind: "artifact", artifactId: "art-without-binary" },
    className: "com.example.Probe"
  });
  assert.ok(legacy.includes(JSON.stringify(service).slice(1, -1)), "control: the member lookup writes the 8.x sentence");

  const envelope = await catalogReply(
    "member-list",
    { target: { kind: "artifact", artifactId: "art-without-binary" }, classes: ["com.example.Probe"] },
    catalog
  );
  const item = envelope.result!.items[0];
  assert.equal(item.error.code, "ERR_CONTEXT_UNRESOLVED");
  assert.ok(item.error.hints[0].startsWith(`${catalog} `), "the sentence keeps its place before the cache-manage advice");
});

test("a class lookup that misses a deobfuscated name in obfuscated names advises artifact-resolve or symbol-map", async () => {
  const sentence = SERVICE_SENTENCE_REWRITES.find((entry) => entry.id === "class-find-obfuscated-names");
  assert.ok(sentence !== undefined && "pattern" in sentence, "class-find-obfuscated-names is a pattern sentence");
  const legacy = await eightXText("find-class", { className: "Blocks", artifactId: "art-obfuscated-minecraft" });
  assert.ok(
    legacy.includes('usually require mapping=\\"mojang\\" or a find-mapping lookup'),
    `control: the class lookup asks for mapping="mojang": ${legacy}`
  );

  const catalog = sentence.catalog("Blocks");
  const envelope = await catalogReply(
    "class-find",
    { target: { kind: "artifact", artifactId: "art-obfuscated-minecraft" }, className: "Blocks" },
    catalog
  );
  assert.equal(envelope.result!.status, "not_found");
  const warning = envelope.meta.warnings.find((entry: { message: string }) => entry.message.startsWith('No exact class symbol matched "Blocks"'));
  assert.equal(warning?.message, catalog, "the whole warning is the catalog sentence");
  assert.doesNotMatch(warning.message, /mapping="/, "no mapping= input, which class-find does not take");
  assert.match(warning.message, /artifact-resolve and mapping: "mojang"/);
  assert.match(warning.message, /with symbol-map\.$/);
});
