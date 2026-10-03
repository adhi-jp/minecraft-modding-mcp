import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createDirectWorkerBridgeTransport, selectManualStdioMode } from "../helpers/manual-stdio-bridge.ts";
import { hasRuntimeCapability } from "../helpers/runtime-capabilities.ts";
import { createJar } from "../helpers/zip.ts";

type Schema = {
  properties?: Record<string, Schema>;
  anyOf?: Schema[];
  const?: string;
};
type SearchResult = {
  task: string;
  summary: { counts: { hits: number }; status: string };
  search?: { hits: Array<{ filePath: string }>; nextCursor?: string };
};
type Envelope = {
  result: Record<string, unknown>;
  error?: unknown;
  meta: { includeApplied?: string[]; detailApplied?: string; pagination?: Record<string, unknown> };
};

test("stdio inspect-minecraft summary samples expose bounded local-JAR hits with requested includes and page metadata", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stdio-inspect-search-samples-"));
  const jarPath = join(root, "sample-sources.jar");
  const cachePath = join(root, "cache");
  await mkdir(cachePath);
  await createJar(jarPath, Object.fromEntries(
    ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Zulu"].map((name) => [
      `com/example/${name}.java`,
      `package com.example;\npublic class ${name} { void sampleMarker() {} }\n`
    ])
  ));
  const env = {
    ...process.env,
    NODE_ENV: "production",
    MCP_CACHE_DIR: cachePath,
    MCP_SQLITE_PATH: join(cachePath, "source-cache.db"),
    MCP_LOCAL_M2: join(root, "m2"),
    GRADLE_USER_HOME: join(root, "gradle")
  };
  const mode = selectManualStdioMode(await hasRuntimeCapability("native-stdio-pipes"));
  const transport = mode.kind === "native"
    ? new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts"], env })
    : createDirectWorkerBridgeTransport({ cwd: process.cwd(), env });
  const client = new Client({ name: "inspect-search-samples-test", version: "1.0.0" });

  async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined);
    const envelope = response.structuredContent as Envelope;
    assert.ok(envelope?.meta, "wire result must retain the standard meta envelope");
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    assert.ok(envelope.result, "wire envelope must contain a successful result");
    const text = response.content.find((entry) => entry.type === "text");
    assert.ok(text && typeof text.text === "string");
    assert.deepEqual(JSON.parse(text.text), envelope);
    return envelope;
  }

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const inspect = tools.find((tool) => tool.name === "inspect-minecraft");
    assert.ok(inspect);
    const artifactUnion = (schema: Schema) => schema.properties?.subject?.anyOf
      ?.find((branch) => branch.properties?.kind?.const === "artifact")?.properties?.artifact?.anyOf;
    const liveUnion = artifactUnion(inspect.inputSchema as Schema);
    assert.ok(liveUnion, "artifact references must be advertised as a structured union");
    assert.deepEqual(liveUnion.map((branch) => branch.properties?.type?.const), ["resolved-id", "resolve-target"]);
    const fixture = JSON.parse(await readFile(new URL("../fixtures/premigration/tool-contracts/inspect-minecraft.json", import.meta.url), "utf8"));
    assert.deepEqual(liveUnion, artifactUnion(fixture.advertised.inputSchema));

    const resolved = await call("resolve-artifact", {
      target: { kind: "jar", value: jarPath },
      mapping: "obfuscated",
      allowDecompile: false
    });
    const artifactId = resolved.result.artifactId;
    assert.equal(typeof artifactId, "string");
    const request = {
      task: "search",
      subject: {
        kind: "search",
        query: "sampleMarker",
        intent: "text",
        queryMode: "literal",
        artifact: { type: "resolved-id", artifactId }
      },
      limit: 10
    };

    const sampled = await call("inspect-minecraft", {
      ...request, detail: "summary", include: ["samples", "warnings", "samples"]
    });
    const sampledResult = sampled.result as unknown as SearchResult;
    assert.ok(sampledResult.search, "summary with samples must expose search hits over actual stdio");
    assert.equal(sampledResult.task, "search");
    assert.equal(sampledResult.summary.counts.hits, 7);
    assert.equal(sampledResult.search.hits.length, 5);
    assert.equal(sampledResult.search.nextCursor, undefined);
    assert.equal(sampled.meta.detailApplied, undefined, "the default summary detail needs no echo");
    assert.deepEqual(sampled.meta.includeApplied, ["warnings", "samples"]);
    assert.deepEqual(sampled.meta.pagination, { returnedCount: 5, hasMore: false });

    const summary = await call("inspect-minecraft", { ...request, detail: "summary" });
    assert.equal(summary.result.search, undefined);
    assert.equal(summary.meta.includeApplied, undefined);
    assert.deepEqual(summary.meta.pagination, sampled.meta.pagination);
    for (const detail of ["standard", "full"]) {
      const complete = await call("inspect-minecraft", { ...request, detail, include: ["samples"] });
      const completeResult = complete.result as unknown as SearchResult;
      assert.ok(completeResult.search);
      assert.equal(completeResult.search.hits.length, 7);
      assert.deepEqual(sampledResult.search.hits, completeResult.search.hits.slice(0, 5));
      assert.deepEqual(complete.meta.includeApplied, ["samples"]);
      assert.equal(complete.meta.detailApplied, detail);
      assert.deepEqual(complete.meta.pagination, { returnedCount: 7, hasMore: false });
    }
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});
