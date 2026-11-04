/**
 * Symbol tools when the version manifest cannot be reached, told apart from a
 * version that has no mapping data, through the in-process MCP session.
 *
 * Fixtures, all local: while the manifest is down, the fetch stub fails its
 * request the way Node's fetch fails on a refused connection (a TypeError
 * "fetch failed" whose cause has code ECONNREFUSED); once it is up, the stub
 * serves a manifest listing a version whose document names no client
 * mappings, and a version whose jar is already in the version cache but whose
 * document request the stub refuses the same way. Every other URL is a 404;
 * nothing reaches the network and no socket is opened.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { createJar } from "../helpers/zip.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-symbol-manifest-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
process.env.MCP_LOCAL_M2 = join(root, "m2");
process.env.MCP_FETCH_RETRIES = "0";
process.env.MCP_FETCH_TIMEOUT_MS = "1000";
process.env.GRADLE_USER_HOME = join(root, "gradle-home");

const VERSION = "1.21.10";
const UNMAPPED_VERSION = "1.21.9";
/** Its jar is in the version cache; its document, which locates its mapping files, cannot be fetched. */
const CACHED_JAR_VERSION = "1.21.8";

const manifestUrl = "https://manifest.test/version_manifest_v2.json";
process.env.MCP_VERSION_MANIFEST_URL = manifestUrl;
/** Version documents under this base are refused. */
const refusedDocuments = "https://refused.test/versions";
let manifestUp = false;

/** The error Node's fetch rejects with when the connection is refused. */
function refusedConnection(url: string): TypeError {
  const cause = Object.assign(new Error(`connect ECONNREFUSED ${new URL(url).host}`), { code: "ECONNREFUSED" });
  return new TypeError("fetch failed", { cause });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === manifestUrl) {
    if (!manifestUp) throw refusedConnection(url);
    return new Response(
      JSON.stringify({
        latest: { release: VERSION, snapshot: VERSION },
        versions: [
          ...[VERSION, UNMAPPED_VERSION].map((id) => ({ id, type: "release", url: `https://manifest.test/versions/${id}.json` })),
          { id: CACHED_JAR_VERSION, type: "release", url: `${refusedDocuments}/${CACHED_JAR_VERSION}.json` }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (url.startsWith(`${refusedDocuments}/`)) throw refusedConnection(url);
  const versionDocument = /^https:\/\/manifest\.test\/versions\/(.+)\.json$/.exec(url);
  if (versionDocument !== null) {
    const id = versionDocument[1]!;
    return new Response(JSON.stringify({ id, downloads: { client: { url: `https://manifest.test/jars/${id}.jar` } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

type Envelope = {
  result?: Record<string, any>;
  meta: Record<string, any> & { warnings?: Array<{ code: string; severity: string; message: string }> };
};

let session: CatalogSession;

before(async () => {
  const jarPath = join(root, `client-${CACHED_JAR_VERSION}.jar`);
  await createJar(jarPath, { "a/b/C.class": buildClassFile({ internalName: "a/b/C" }) });
  mkdirSync(join(root, "cache", "versions"), { recursive: true });
  writeFileSync(
    join(root, "cache", "versions", "index.json"),
    JSON.stringify({ entries: [{ version: CACHED_JAR_VERSION, jarPath, downloadedAt: new Date().toISOString() }] })
  );
  session = await startCatalogSession(CATALOG_TOOL_SPECS);
});

after(async () => {
  await session.close();
  globalThis.fetch = originalFetch;
});

async function catalog(name: string, args: unknown): Promise<Envelope> {
  const frame: SessionFrame = await session.callTool(name, args);
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const envelope = (frame.result as { structuredContent: Envelope }).structuredContent;
  assert.equal(envelope.meta.tool, name);
  return envelope;
}

const SYMBOLS = [
  { kind: "class", className: "net.minecraft.world.item.Item" },
  { kind: "method", className: "net.minecraft.world.item.Item", memberName: "use" }
];

test("an unreachable version manifest leaves the symbols unavailable with a mapping-fetch-failed warning", async () => {
  manifestUp = false;
  const check = await catalog("symbol-check", { target: { kind: "version", version: VERSION }, mapping: "mojang", symbols: SYMBOLS });
  assert.deepEqual(check.result!.items.map((item: { status: string }) => item.status), ["unavailable", "unavailable"]);
  assert.deepEqual(check.result!.counts, { total: 2, ok: 0, failed: 0 }, "the lookups answered; no item carries an error");
  const fetchFailed = check.meta.warnings?.filter((warning) => warning.code === "mapping-fetch-failed") ?? [];
  assert.equal(fetchFailed.length, 1, "one warning for the version, however many symbols");
  assert.equal(fetchFailed[0]!.severity, "warning");
  assert.match(
    fetchFailed[0]!.message,
    new RegExp(`^The mapping data of Minecraft ${VERSION.replaceAll(".", "\\.")} could not be fetched \\(Request failed for "${manifestUrl.replaceAll(".", "\\.")}": fetch failed\\), .* Retry the call`)
  );
  assert.equal(
    check.meta.warnings?.some((warning) => warning.message.startsWith("Failed to resolve version metadata")),
    false,
    "the service sentence is replaced, not repeated"
  );

  const map = await catalog("symbol-map", {
    target: { kind: "version", version: VERSION },
    mapping: "mojang",
    toMapping: "obfuscated",
    symbols: [SYMBOLS[0]]
  });
  assert.equal(map.result!.items[0].status, "unavailable");
  assert.ok(map.meta.warnings?.some((warning) => warning.code === "mapping-fetch-failed"), "symbol-map reports it the same way");

  const trace = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "net.minecraft.world.item.Item", memberName: "use" },
    mapping: "mojang",
    toVersion: VERSION
  });
  assert.equal(trace.result, undefined, "symbol-trace needs the manifest to choose the versions it scans");
  assert.equal((trace as Envelope & { error?: { code?: string } }).error?.code, "ERR_REPO_FETCH_FAILED");
});

test("a version without mapping data leaves the symbols unavailable without a mapping-fetch-failed warning", async () => {
  manifestUp = true;
  const check = await catalog("symbol-check", {
    target: { kind: "version", version: UNMAPPED_VERSION },
    mapping: "mojang",
    symbols: SYMBOLS
  });
  assert.deepEqual(check.result!.items.map((item: { status: string }) => item.status), ["unavailable", "unavailable"]);
  assert.ok(
    check.meta.warnings?.some((warning) => warning.message.includes(`"${UNMAPPED_VERSION}" does not expose client mappings`)),
    "positive control: the warning says the version has no mapping files"
  );
  assert.equal(check.meta.warnings?.some((warning) => warning.code === "mapping-fetch-failed"), false);
});

test("symbol-trace warns with mapping-fetch-failed for a scanned version whose metadata cannot be fetched", async () => {
  manifestUp = true;
  const trace = await catalog("symbol-trace", {
    symbol: { kind: "method", className: "net.minecraft.world.item.Item", memberName: "use" },
    mapping: "mojang",
    fromVersion: CACHED_JAR_VERSION,
    toVersion: CACHED_JAR_VERSION
  });
  const fetchFailed = trace.meta.warnings?.find((warning) => warning.code === "mapping-fetch-failed");
  assert.match(
    fetchFailed?.message ?? "",
    new RegExp(`^The mapping data of Minecraft ${CACHED_JAR_VERSION.replaceAll(".", "\\.")} could not be fetched \\(Request failed for "${refusedDocuments.replaceAll(".", "\\.")}/`),
    JSON.stringify(trace.meta.warnings)
  );
});
