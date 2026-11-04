/**
 * The NBT tools and cache-manage answer while the cache database cannot be
 * opened, as their 8.x counterparts do: they read the server's loaded
 * configuration, never the source service, whose construction opens the
 * database.
 *
 * Fixture: a cache database whose `cache_meta.schema_version` is newer than
 * the server supports, so opening it fails with ERR_DB_FAILURE, one cached
 * download beside it, and a Fabric mod jar whose classes already carry Mojang
 * names, so remapping it to `mojang` copies the jar without Java or mappings.
 * Nothing reaches the network (fetch is stubbed and records every URL).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { runMigrations } from "../../src/storage/migrations.ts";
import Database from "../../src/storage/sqlite.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-unusable-db-"));
const cacheDir = join(root, "cache");
const sqlitePath = join(cacheDir, "source-cache.db");
process.env.MCP_CACHE_DIR = cacheDir;
process.env.MCP_SQLITE_PATH = sqlitePath;
process.env.MCP_FETCH_RETRIES = "0";

const fetchedUrls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  fetchedUrls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const modJar = join(root, "mods", "examplemod-1.0.0.jar");
/** Class bytes whose constant pool reads as Mojang names (remapping to mojang copies the jar). */
const MOJANG_CLASS = Buffer.from(
  ["CAFEBABE", "Lnet/minecraft/server/MinecraftServer;", "Lnet/minecraft/world/level/Level;"].join("\0"),
  "latin1"
);

/** Compound "R" holding the int `answer` = 42. */
const PAYLOAD_BASE64 = Buffer.from("0a000152030006616e737765720000002a00", "hex").toString("base64");

type Envelope = { result?: Record<string, any>; error?: Record<string, any>; meta: Record<string, any> };

let session: CatalogSession;

before(async () => {
  mkdirSync(join(cacheDir, "downloads"), { recursive: true });
  writeFileSync(join(cacheDir, "downloads", "client-1.21.1.jar"), "jar-bytes");
  const db = new Database(sqlitePath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("UPDATE cache_meta SET value = ? WHERE key = ?").run(["999", "schema_version"]);
  db.close();
  mkdirSync(join(root, "mods"), { recursive: true });
  await createJar(modJar, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "examplemod", version: "1.0.0", depends: { minecraft: "~1.21.1" } }),
    "com/example/ExampleMod.class": MOJANG_CLASS
  });
  session = await startCatalogSession(CATALOG_TOOL_SPECS);
});

after(async () => {
  await session.close();
  globalThis.fetch = originalFetch;
});

async function call(name: string, args: unknown): Promise<Envelope> {
  const frame: SessionFrame = await session.callTool(name, args);
  assert.equal(frame.error, undefined);
  return (frame.result as { structuredContent: Envelope }).structuredContent;
}

test("a tool backed by the source service fails on this database (positive control)", async () => {
  const reply = await call("file-list", { target: { kind: "artifact", artifactId: "any" } });
  assert.equal(reply.error?.code, "ERR_DB_FAILURE");
});

test("nbt-decode, nbt-encode and nbt-patch answer like their 8.x counterparts when the database cannot be opened", async () => {
  const legacyDecode = await call("nbt-to-json", { nbtBase64: PAYLOAD_BASE64 });
  assert.equal(legacyDecode.error, undefined, "positive control: the 8.x tool answers");
  const decoded = await call("nbt-decode", { nbtBase64: PAYLOAD_BASE64 });
  assert.equal(decoded.error, undefined, JSON.stringify(decoded.error));
  assert.deepEqual(decoded.result!.typedJson, legacyDecode.result!.typedJson);

  const encoded = await call("nbt-encode", { typedJson: decoded.result!.typedJson });
  assert.equal(encoded.result?.nbtBase64, PAYLOAD_BASE64, JSON.stringify(encoded.error));

  const patched = await call("nbt-patch", {
    typedJson: decoded.result!.typedJson,
    patch: [{ op: "replace", path: "/root/value/answer/value", value: 7 }]
  });
  assert.equal(patched.result?.typedJson.root.value.answer.value, 7, JSON.stringify(patched.error));
});

test("cache-manage summarizes and lists a file-backed kind like manage-cache when the database cannot be opened", async () => {
  const legacy = await call("manage-cache", { action: "summary", cacheKinds: ["downloads"], detail: "standard" });
  assert.equal(legacy.error, undefined, "positive control: the 8.x tool answers");
  const summary = await call("cache-manage", { action: "summary", cacheKinds: ["downloads"] });
  assert.equal(summary.error, undefined, JSON.stringify(summary.error));
  assert.deepEqual(summary.result!.cache.kinds, legacy.result!.stats);
  assert.equal(summary.result!.cache.entryCount, 1);

  const listed = await call("cache-manage", { action: "list", cacheKinds: ["downloads"] });
  assert.deepEqual(
    listed.result?.cache.entries.map((entry: { entryId: string }) => entry.entryId),
    ["client-1.21.1.jar"],
    JSON.stringify(listed.error)
  );
});

test("mod-remap applies like remap-mod-jar when the database cannot be opened", async () => {
  const legacyOutput = join(root, "out", "legacy.jar");
  const catalogOutput = join(root, "out", "catalog.jar");
  const legacy = await call("remap-mod-jar", { inputJar: modJar, targetMapping: "mojang", outputJar: legacyOutput, forceRemap: true });
  assert.equal(legacy.error, undefined, `positive control: the 8.x tool answers: ${JSON.stringify(legacy.error)}`);
  const applied = await call("mod-remap", { jarPath: modJar, toMapping: "mojang", outputJar: catalogOutput, force: true, apply: true });
  assert.equal(applied.error, undefined, JSON.stringify(applied.error));
  assert.equal(applied.result!.remap.outputJar, catalogOutput);
  assert.equal(applied.result!.remap.fromMapping, legacy.result!.fromMapping);
  assert.deepEqual(readFileSync(catalogOutput), readFileSync(legacyOutput), "the written jars are identical");
  assert.deepEqual(fetchedUrls, [], "no network");
});
