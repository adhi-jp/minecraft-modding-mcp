import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  legacyHandshake,
  parseResourceEnvelope,
  startInProcessSession,
  type Frame,
  type InProcessSession
} from "./inprocess-era-serve.ts";
import { seedIndexedArtifact, stubExplorer } from "../helpers/seed-artifact.ts";

/**
 * Legacy-era resource matrix (legacy byte-compat must-preserve), mirroring the modern
 * nine-resource enumeration in stdio-modern-result-type-inventory.test.ts on
 * a LEGACY-locked in-process session:
 *
 *  - resources/list answers exactly the 2 fixed resources;
 *  - resources/templates/list answers exactly the 7 registered templates;
 *  - every one of the nine resources answers resources/read with contents in
 *    its class's premigration format and with NO modern decoration on the
 *    result: no resultType, no ttlMs/cacheScope, and no
 *    `_meta["io.modelcontextprotocol/serverInfo"]` stamp.
 */

const root = mkdtempSync(join(tmpdir(), "legacy-resource-matrix-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const ARTIFACT_ID = "legacy-matrix-artifact";
const CLASS_FQN = "com.example.Probe";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

const FIXED_URIS = ["mc://metrics", "mc://versions/list"];

/** Concrete cheap read URI per registered resource template (modern-suite mirror). */
const TEMPLATE_URIS: Record<string, string> = {
  "mc://source/{artifactId}/{className}": `mc://source/${ARTIFACT_ID}/${CLASS_FQN}`,
  "mc://source-json/{artifactId}/{className}": `mc://source-json/${ARTIFACT_ID}/${CLASS_FQN}`,
  "mc://artifact/{artifactId}/files/{filePath}": `mc://artifact/${ARTIFACT_ID}/files/com%2Fexample%2FProbe.java`,
  "mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}":
    "mc://mappings/1.21.4/obfuscated/mojang/class/com.example.Probe",
  "mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{owner}/{name}":
    "mc://mappings/1.21.4/obfuscated/mojang/method/com.example.Probe/foo",
  "mc://artifact/{artifactId}/members/{className}": `mc://artifact/${ARTIFACT_ID}/members/${CLASS_FQN}`,
  "mc://artifact/{artifactId}": `mc://artifact/${ARTIFACT_ID}`
};

/**
 * Raw-text resource classes (text/x-java and text/plain): their premigration
 * contents are plain source text; every other resource read answers the
 * single-content JSON envelope the modern suite treats as JSON.
 */
const RAW_TEXT_URIS = new Set([
  `mc://source/${ARTIFACT_ID}/${CLASS_FQN}`,
  `mc://artifact/${ARTIFACT_ID}/files/com%2Fexample%2FProbe.java`
]);

let manifestServer: Server;
let legacy: InProcessSession;
let nextId = 1;

function id(): number {
  return nextId++;
}

/**
 * Modern-field absence scan. Kept as a violation-listing predicate (not bare
 * asserts) so the suite can self-check that a decorated result IS flagged —
 * the absence assertions below are falsifiable, not vacuous.
 */
function modernFieldViolations(result: Record<string, unknown>): string[] {
  const violations: string[] = [];
  if ("resultType" in result) violations.push("resultType");
  if ("ttlMs" in result) violations.push("ttlMs");
  if ("cacheScope" in result) violations.push("cacheScope");
  const meta = result._meta as Record<string, unknown> | undefined;
  if (meta !== undefined && SERVER_INFO_KEY in meta) violations.push(`_meta[${SERVER_INFO_KEY}]`);
  return violations;
}

before(async () => {
  // Local deterministic Mojang-manifest stand-in so the mc://versions/list
  // read SUCCEEDS offline (an empty object is a valid manifest shape).
  manifestServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ latest: { release: "1.99.9-lm", snapshot: "1.99.9-lm" }, versions: [] }));
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
  // Deterministic, offline-cheap stand-ins for the two service seams the
  // mapping/member resources call into (modern-suite mirror; the wire encode
  // under test is unaffected by what the service returns).
  stubExplorer(sourceService, {});
  (sourceService as unknown as { mappingService: unknown }).mappingService = {
    findMapping: async () => ({ resolved: false, note: "legacy-matrix-stub" })
  };

  legacy = await startInProcessSession();
  await legacyHandshake(legacy);
});

after(async () => {
  await legacy?.close();
  await new Promise<void>((resolve) => manifestServer?.close(() => resolve()));
});

test("legacy resources/list advertises exactly the two fixed resources", async () => {
  const frame = await legacy.request({ jsonrpc: "2.0", id: id(), method: "resources/list", params: {} });
  assert.equal(frame.error, undefined);
  const resources = frame.result?.resources as Array<{ uri: string }> | undefined;
  assert.ok(Array.isArray(resources), "resources/list must carry a resources array");
  assert.deepEqual(
    resources.map((resource) => resource.uri).sort(),
    FIXED_URIS,
    "the legacy list must advertise exactly the two fixed resources"
  );
});

test("legacy resources/templates/list advertises exactly the seven registered templates", async () => {
  const frame = await legacy.request({ jsonrpc: "2.0", id: id(), method: "resources/templates/list", params: {} });
  assert.equal(frame.error, undefined);
  const templates = frame.result?.resourceTemplates as Array<{ uriTemplate: string }> | undefined;
  assert.ok(Array.isArray(templates), "resources/templates/list must carry a resourceTemplates array");
  assert.deepEqual(
    templates.map((template) => template.uriTemplate).sort(),
    Object.keys(TEMPLATE_URIS).sort(),
    "the legacy list must advertise exactly the seven registered templates"
  );
});

test("legacy reads of all nine resources answer plain 2025-era results with no modern decoration", async () => {
  // Predicate self-check: a fully modern-decorated result is flagged on
  // every field the scan below asserts absent, and a clean legacy result is
  // not flagged at all.
  assert.deepEqual(
    modernFieldViolations({
      resultType: "complete",
      ttlMs: 60_000,
      cacheScope: "private",
      _meta: { [SERVER_INFO_KEY]: { name: "x", version: "0" } },
      contents: []
    }),
    ["resultType", "ttlMs", "cacheScope", `_meta[${SERVER_INFO_KEY}]`]
  );
  assert.deepEqual(modernFieldViolations({ contents: [] }), []);

  // Drive the matrix from the LIVE registry (modern-suite mirror), so a new
  // resource cannot silently escape the legacy matrix.
  const fixed = await legacy.request({ jsonrpc: "2.0", id: id(), method: "resources/list", params: {} });
  const resources = fixed.result?.resources as Array<{ uri: string }> | undefined;
  assert.ok(Array.isArray(resources), "resources/list must carry a resources array");
  const templatesFrame = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/templates/list",
    params: {}
  });
  const templates = templatesFrame.result?.resourceTemplates as Array<{ uriTemplate: string }> | undefined;
  assert.ok(Array.isArray(templates), "resources/templates/list must carry a resourceTemplates array");
  assert.equal(resources.length + templates.length, 9, "the registry advertises exactly nine resources (2 fixed + 7 template)");

  const uris: string[] = resources.map((resource) => resource.uri);
  for (const template of templates) {
    const uri = TEMPLATE_URIS[template.uriTemplate];
    assert.ok(uri, `no cheap read URI mapped for live template ${template.uriTemplate} — extend TEMPLATE_URIS`);
    uris.push(uri);
  }

  for (const uri of uris) {
    const frame = (await legacy.request({
      jsonrpc: "2.0",
      id: id(),
      method: "resources/read",
      params: { uri }
    })) as Frame;
    assert.equal(frame.error, undefined, `resources/read ${uri}: must answer a result`);
    const result = frame.result as Record<string, unknown> | undefined;
    assert.ok(result, `resources/read ${uri}: result must be present`);

    const contents = result.contents as Array<{ text?: string }> | undefined;
    assert.ok(Array.isArray(contents) && contents.length > 0, `resources/read ${uri}: contents must be present`);
    if (RAW_TEXT_URIS.has(uri)) {
      // Raw-text classes: plain source text, not a JSON envelope.
      const text = contents[0]?.text;
      assert.ok(typeof text === "string" && text.length > 0, `resources/read ${uri}: raw text content expected`);
      assert.match(text, /class Probe/, `resources/read ${uri}: the seeded source must be served`);
    } else {
      // JSON classes: the single-content envelope must parse (success or
      // ProblemDetails alike — both are successful reads).
      const payload = parseResourceEnvelope(frame);
      assert.ok(payload !== null && typeof payload === "object", `resources/read ${uri}: JSON envelope expected`);
    }

    assert.deepEqual(
      modernFieldViolations(result),
      [],
      `resources/read ${uri}: legacy results must carry no modern fields`
    );
  }
});
