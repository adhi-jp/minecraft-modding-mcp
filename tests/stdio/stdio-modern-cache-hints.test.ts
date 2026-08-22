import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  MODERN_META,
  legacyHandshake,
  parseResourceEnvelope,
  startInProcessSession,
  type InProcessSession
} from "./inprocess-era-serve.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";

/**
 * Adopted cache-hint values (approved P-policy), observed on the WIRE through
 * the real serveStdio entry + real factory:
 *   tools/list 0; server/discover 0; resources/list AND
 *   resources/templates/list 3_600_000; resources/read mc://versions/list
 *   300_000; mc://metrics 0; every other (template) resource read 60_000;
 *   any successful resource read whose content is a ProblemDetails envelope
 *   0 (unconditional precedence over its class row). cacheScope "private"
 *   everywhere. Legacy-era results NEVER carry cache fields.
 */

// Env must be set before the harness's first src/index.ts import.
const root = mkdtempSync(join(tmpdir(), "p3-cache-hints-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const ARTIFACT_ID = "p3-cache-artifact";
const CLASS_FQN = "com.example.Probe";

let manifestServer: Server;
let modern: InProcessSession;
let legacy: InProcessSession;
let nextId = 1;

function id(): number {
  return nextId++;
}

before(async () => {
  // Local deterministic Mojang-manifest stand-in so the mc://versions/list
  // read SUCCEEDS offline (an empty object is a valid manifest shape).
  manifestServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ latest: { release: "1.99.9-p3", snapshot: "1.99.9-p3" }, versions: [] }));
  });
  await new Promise<void>((resolve) => manifestServer.listen(0, "127.0.0.1", resolve));
  const address = manifestServer.address() as { port: number };
  process.env.MCP_VERSION_MANIFEST_URL = `http://127.0.0.1:${address.port}/version_manifest_v2.json`;

  const { sourceService } = await import("../../src/index.ts");
  seedIndexedArtifact(sourceService, {
    artifactId: ARTIFACT_ID,
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files: [{ filePath: "com/example/Probe.java", content: "public class Probe {}\n" }],
    symbols: [
      { filePath: "com/example/Probe.java", symbolKind: "class", symbolName: "Probe", qualifiedName: CLASS_FQN, line: 1 }
    ]
  });

  modern = await startInProcessSession();
  legacy = await startInProcessSession();
  await legacyHandshake(legacy);
});

after(async () => {
  await modern?.close();
  await legacy?.close();
  await new Promise<void>((resolve) => manifestServer?.close(() => resolve()));
});

function assertCache(frame: { result?: Record<string, unknown> }, ttlMs: number, label: string): void {
  assert.equal(frame.result?.ttlMs, ttlMs, `${label}: ttlMs must be ${ttlMs}`);
  assert.equal(frame.result?.cacheScope, "private", `${label}: cacheScope must be private`);
}

function assertNoCacheFields(result: Record<string, unknown> | undefined, label: string): void {
  assert.ok(result, `${label}: expected a result frame`);
  assert.equal("ttlMs" in result, false, `${label}: legacy results must not carry ttlMs`);
  assert.equal("cacheScope" in result, false, `${label}: legacy results must not carry cacheScope`);
}

test("modern resources/list and resources/templates/list answer ttlMs 3600000 cacheScope private", async () => {
  const list = await modern.request({ jsonrpc: "2.0", id: id(), method: "resources/list", params: { _meta: MODERN_META } });
  assert.equal(list.error, undefined);
  assertCache(list, 3_600_000, "resources/list");

  const templates = await modern.request({ jsonrpc: "2.0", id: id(), method: "resources/templates/list", params: { _meta: MODERN_META } });
  assert.equal(templates.error, undefined);
  assertCache(templates, 3_600_000, "resources/templates/list");
});

test("modern mc://versions/list read answers ttlMs 300000 on success", async () => {
  const frame = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { _meta: MODERN_META, uri: "mc://versions/list" }
  });
  assert.equal(frame.error, undefined);
  const payload = parseResourceEnvelope(frame);
  assert.equal("error" in payload, false, "the versions-list read must SUCCEED (local manifest server)");
  assertCache(frame, 300_000, "mc://versions/list read");
});

test("modern class-source read answers ttlMs 60000 on success", async () => {
  const frame = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { _meta: MODERN_META, uri: `mc://source/${ARTIFACT_ID}/${CLASS_FQN}` }
  });
  assert.equal(frame.error, undefined);
  const contents = frame.result?.contents as Array<{ text?: string }> | undefined;
  assert.match(contents?.[0]?.text ?? "", /class Probe/, "the class-source read must SUCCEED from the seeded artifact");
  assertCache(frame, 60_000, "class-source read");
});

test("modern matched-template resource misses answer -32602 with data.uri and no result/cache fields", async () => {
  // Same registered resource (artifact-metadata) drives BOTH halves: the
  // seeded artifact proves the template still resolves normally, while the
  // nonexistent artifact must use the SDK's protocol-level not-found path.
  const success = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { _meta: MODERN_META, uri: `mc://artifact/${ARTIFACT_ID}` }
  });
  assert.equal(success.error, undefined);
  const successPayload = parseResourceEnvelope(success);
  assert.equal("error" in successPayload, false, "the seeded artifact-metadata read must SUCCEED");
  assertCache(success, 60_000, "artifact-metadata success read");

  const uri = "mc://artifact/p3-no-such-artifact";
  const missing = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { _meta: MODERN_META, uri }
  });
  assert.equal(missing.error?.code, -32602);
  assert.deepEqual(missing.error?.data, { uri });
  assert.equal("result" in missing, false, "a resource-not-found protocol error must carry no result");
  assert.equal(missing.result?.ttlMs, undefined, "a resource-not-found protocol error must carry no ttlMs");
  assert.equal(missing.result?.cacheScope, undefined, "a resource-not-found protocol error must carry no cacheScope");
});

test("modern mc://metrics read, tools/list, and server/discover keep ttlMs 0 cacheScope private", async () => {
  const metrics = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { _meta: MODERN_META, uri: "mc://metrics" }
  });
  assert.equal(metrics.error, undefined);
  assertCache(metrics, 0, "mc://metrics read");

  const tools = await modern.request({ jsonrpc: "2.0", id: id(), method: "tools/list", params: { _meta: MODERN_META } });
  assert.equal(tools.error, undefined);
  assertCache(tools, 0, "tools/list");

  const discover = await modern.request({ jsonrpc: "2.0", id: id(), method: "server/discover", params: { _meta: MODERN_META } });
  assert.equal(discover.error, undefined);
  assertCache(discover, 0, "server/discover");
});

test("legacy-era results never carry cache fields (lists, success reads, and ProblemDetails reads)", async () => {
  const tools = await legacy.request({ jsonrpc: "2.0", id: id(), method: "tools/list", params: {} });
  assertNoCacheFields(tools.result, "legacy tools/list");

  const list = await legacy.request({ jsonrpc: "2.0", id: id(), method: "resources/list", params: {} });
  assertNoCacheFields(list.result, "legacy resources/list");

  const templates = await legacy.request({ jsonrpc: "2.0", id: id(), method: "resources/templates/list", params: {} });
  assertNoCacheFields(templates.result, "legacy resources/templates/list");

  const success = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { uri: `mc://artifact/${ARTIFACT_ID}` }
  });
  assertNoCacheFields(success.result, "legacy artifact-metadata success read");

  // The ProblemDetails (errorResource) path is the one a naive un-gated
  // per-result override would poison on the 2025 wire — pin its absence.
  const problem = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { uri: "mc://artifact/p3-no-such-artifact" }
  });
  assert.equal(problem.error, undefined);
  const payload = parseResourceEnvelope(problem) as { error?: { type?: string } };
  assert.equal(payload.error?.type, "https://minecraft-modding-mcp.dev/problems/resource");
  assertNoCacheFields(problem.result, "legacy ProblemDetails read");
});

test("legacy-era mc://versions/list and mc://metrics reads never carry cache fields", async () => {
  // The two PER-RESOURCE hint constants (VERSIONS_LIST_READ_CACHE_HINT
  // 300000, METRICS_READ_CACHE_HINT 0) had no legacy-absence drive: their
  // modern twins above prove the hints EXIST on these very reads, so this
  // helper demonstrably fails on a decorated result.
  assert.throws(
    () => assertNoCacheFields({ ttlMs: 300_000, cacheScope: "private" }, "helper self-check"),
    "assertNoCacheFields must flag a cache-decorated result (falsifiability self-check)"
  );

  const versions = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { uri: "mc://versions/list" }
  });
  assert.equal(versions.error, undefined);
  const versionsPayload = parseResourceEnvelope(versions);
  assert.equal("error" in versionsPayload, false, "the legacy versions-list read must SUCCEED (local manifest server)");
  assertNoCacheFields(versions.result, "legacy mc://versions/list read");

  const metrics = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { uri: "mc://metrics" }
  });
  assert.equal(metrics.error, undefined);
  const metricsPayload = parseResourceEnvelope(metrics);
  assert.equal("error" in metricsPayload, false, "the legacy metrics read must SUCCEED");
  assertNoCacheFields(metrics.result, "legacy mc://metrics read");
});

test("a legacy-era claim-shaped-invalid ProblemDetails read (protocolVersion without clientCapabilities) never gains cache fields", async () => {
  // A request carrying ONLY the protocol-version reserved key is
  // claim-shaped-INVALID: legacy-permissive admission forwards it on a
  // legacy-locked connection, the SDK lifts the key into
  // ctx.mcpReq.envelope, and the reply is encoded by the LEGACY codec —
  // which serializes handler-returned fields verbatim. The errorResource
  // era gate must therefore mirror the FULL shallow modern-signal check
  // (protocolVersion string AND plain-object clientCapabilities), not the
  // version key alone.
  const problem = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      uri: "mc://artifact/p3-no-such-artifact"
    }
  });
  assert.equal(problem.error, undefined);
  const payload = parseResourceEnvelope(problem) as { error?: { type?: string } };
  assert.equal(payload.error?.type, "https://minecraft-modding-mcp.dev/problems/resource");
  assertNoCacheFields(problem.result, "legacy claim-shaped-invalid ProblemDetails read");
});
