import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  MODERN_META,
  startInProcessSession,
  type Frame,
  type InProcessSession
} from "./inprocess-era-serve.ts";
import { seedIndexedArtifact, stubExplorer } from "../helpers/seed-artifact.ts";

/**
 * resultType enumeration (fixed set + live registry): every modern result
 * carries resultType "complete".
 *
 *  - Fixed representative set: server/discover, tools/list, resources/list,
 *    resources/templates/list, resources/read.
 *  - Registry-driven: every tool named in the LIVE tools/list answers a cheap
 *    tools/call with resultType "complete" (invalid input still returns a
 *    SUCCESSFUL CallToolResult carrying ProblemDetails — that is a result,
 *    so it must carry resultType), and every one of the nine registered
 *    resources answers resources/read with resultType "complete"
 *    (errorResource reads included — they are successful reads).
 */

const root = mkdtempSync(join(tmpdir(), "p3-result-type-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const ARTIFACT_ID = "p3-rt-artifact";
const CLASS_FQN = "com.example.Probe";

/**
 * Cheap tools/call arguments for tools whose advertised inputSchema has no
 * required fields ({} would VALIDATE and run the real tool). A wrong-typed
 * known property fails validation deterministically before any heavy work;
 * get-runtime-metrics and json-to-nbt are cheap with {} (success and
 * custom-refine ProblemDetails respectively).
 */
const NO_REQUIRED_OVERRIDES: Record<string, Record<string, unknown>> = {
  "get-runtime-metrics": {},
  "json-to-nbt": {},
  "index-artifact": { artifactId: false },
  "inspect-minecraft": { task: false },
  "list-artifact-files": { limit: false },
  "list-versions": { limit: false }
};

/** Concrete cheap read URI per registered resource template. */
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

let manifestServer: Server;
let modern: InProcessSession;
let nextId = 1;

function id(): number {
  return nextId++;
}

before(async () => {
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
  // Deterministic, offline-cheap stand-ins for the two service seams the
  // mapping/member resources call into (test-process only; the wire encode
  // under test is unaffected by what the service returns).
  stubExplorer(sourceService, {});
  (sourceService as unknown as { mappingService: unknown }).mappingService = {
    findMapping: async () => ({ resolved: false, note: "p3-resultType-stub" })
  };

  modern = await startInProcessSession();
});

after(async () => {
  await modern?.close();
  await new Promise<void>((resolve) => manifestServer?.close(() => resolve()));
});

function assertComplete(frame: Frame, label: string): void {
  assert.equal(frame.error, undefined, `${label}: must answer a RESULT, not a JSON-RPC error`);
  assert.equal(frame.result?.resultType, "complete", `${label}: the modern result must carry resultType "complete"`);
}

test("fixed representative set: discover, tools/list, resources/list, templates/list, resources/read all carry resultType complete", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["server/discover", { _meta: MODERN_META }],
    ["tools/list", { _meta: MODERN_META }],
    ["resources/list", { _meta: MODERN_META }],
    ["resources/templates/list", { _meta: MODERN_META }],
    ["resources/read", { _meta: MODERN_META, uri: "mc://metrics" }]
  ];
  for (const [method, params] of cases) {
    const frame = await modern.request({ jsonrpc: "2.0", id: id(), method, params });
    assertComplete(frame, method);
  }
});

test("registry-driven: every advertised tool answers a cheap tools/call with resultType complete", async () => {
  const list = await modern.request({ jsonrpc: "2.0", id: id(), method: "tools/list", params: { _meta: MODERN_META } });
  const tools = list.result?.tools as Array<{ name: string; inputSchema?: { required?: string[] } }> | undefined;
  assert.ok(Array.isArray(tools), "tools/list must carry a tools array");
  assert.equal(tools.length, 41, "the default flag config advertises all 41 tools");

  for (const tool of tools) {
    const required = tool.inputSchema?.required ?? [];
    const args = required.length > 0 ? {} : NO_REQUIRED_OVERRIDES[tool.name];
    assert.ok(
      args !== undefined,
      `tool ${tool.name} has no required fields and no curated cheap input — add it to NO_REQUIRED_OVERRIDES`
    );
    const frame = await modern.request({
      jsonrpc: "2.0",
      id: id(),
      method: "tools/call",
      params: { _meta: MODERN_META, name: tool.name, arguments: args }
    });
    assertComplete(frame, `tools/call ${tool.name}`);
  }
});

test("registry-driven: every one of the nine registered resources answers resources/read with resultType complete", async () => {
  const fixed = await modern.request({ jsonrpc: "2.0", id: id(), method: "resources/list", params: { _meta: MODERN_META } });
  const resources = fixed.result?.resources as Array<{ uri: string }> | undefined;
  assert.ok(Array.isArray(resources), "resources/list must carry a resources array");

  const templatesFrame = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/templates/list",
    params: { _meta: MODERN_META }
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
    const frame = await modern.request({
      jsonrpc: "2.0",
      id: id(),
      method: "resources/read",
      params: { _meta: MODERN_META, uri }
    });
    assertComplete(frame, `resources/read ${uri}`);
  }
});
