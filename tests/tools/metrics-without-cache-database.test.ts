/**
 * Counting a tool call does not open the cache database: the NBT tools and
 * cache-manage limited to file-backed kinds leave a database file they do not
 * need untouched, even one the server would back up and recreate on open.
 * `server-metrics` still counts those calls.
 *
 * Fixture: a cache database file holding bytes that are not SQLite, which
 * opening it would rename to `source-cache.db.corrupted.<timestamp>` and
 * replace, and one cached download beside it. Each test file runs in its own
 * process, so nothing has opened the database before these calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-metrics-no-db-"));
const cacheDir = join(root, "cache");
const sqlitePath = join(cacheDir, "source-cache.db");
process.env.MCP_CACHE_DIR = cacheDir;
process.env.MCP_SQLITE_PATH = sqlitePath;
process.env.MCP_FETCH_RETRIES = "0";

const NOT_SQLITE = "this is not a SQLite database file";
/** Compound "R" holding the int `answer` = 42. */
const PAYLOAD_BASE64 = Buffer.from("0a000152030006616e737765720000002a00", "hex").toString("base64");

type Envelope = { result?: Record<string, any>; error?: Record<string, any>; meta: Record<string, any> };

let session: CatalogSession;

before(async () => {
  mkdirSync(join(cacheDir, "downloads"), { recursive: true });
  writeFileSync(join(cacheDir, "downloads", "client-1.21.1.jar"), "jar-bytes");
  writeFileSync(sqlitePath, NOT_SQLITE);
  session = await startCatalogSession(CATALOG_TOOL_SPECS);
});

after(async () => {
  await session.close();
});

async function call(name: string, args: unknown): Promise<Envelope> {
  const frame: SessionFrame = await session.callTool(name, args);
  assert.equal(frame.error, undefined);
  return (frame.result as { structuredContent: Envelope }).structuredContent;
}

test("NBT and file-backed cache-manage calls leave the cache database unopened while their calls are counted", async () => {
  const decoded = await call("nbt-decode", { nbtBase64: PAYLOAD_BASE64 });
  assert.equal(decoded.error, undefined, JSON.stringify(decoded.error));
  const encoded = await call("nbt-encode", { typedJson: decoded.result!.typedJson });
  assert.equal(encoded.result?.nbtBase64, PAYLOAD_BASE64, JSON.stringify(encoded.error));
  const summary = await call("cache-manage", { action: "summary", cacheKinds: ["downloads"] });
  assert.equal(summary.result?.cache.entryCount, 1, JSON.stringify(summary.error));

  assert.equal(readFileSync(sqlitePath, "utf8"), NOT_SQLITE, "the database file is untouched");
  assert.deepEqual(readdirSync(cacheDir).filter((name) => name.startsWith("source-cache.db")), ["source-cache.db"], "no backup was made");

  // server-metrics reads the source service, so it opens (and here recreates) the database.
  const metrics = await call("server-metrics", {});
  assert.equal(metrics.error, undefined, JSON.stringify(metrics.error));
  const calls = JSON.stringify(metrics.result!.metrics);
  for (const tool of ["nbt-decode", "nbt-encode", "cache-manage"]) {
    assert.ok(calls.includes(`"${tool}"`), `${tool} was counted before the service existed: ${calls}`);
  }
});
