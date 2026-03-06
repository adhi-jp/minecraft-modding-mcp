import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { errorResource, objectResource } from "../src/mcp-helpers.js";
import { registerResources } from "../src/resources.js";

function createStubSourceService(): Record<string, unknown> {
  return {
    listVersions: async () => ({ versions: [] }),
    getRuntimeMetrics: () => ({ uptime: 0 }),
    getClassSource: async () => ({ sourceText: "" }),
    getArtifactFile: async () => ({ content: "" }),
    findMapping: async () => ({}),
    getClassMembers: async () => ({ members: {} }),
    getArtifact: () => ({})
  };
}

test("registerResources completes without errors", () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const stub = createStubSourceService();

  assert.doesNotThrow(() => {
    registerResources(server, stub as never);
  });
});

test("registerResources registers exactly 7 resources (2 fixed + 5 template)", () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const stub = createStubSourceService();

  let resourceCount = 0;
  const origResource = server.resource.bind(server);

  server.resource = (...args: Parameters<typeof server.resource>) => {
    resourceCount++;
    return origResource(...args);
  };

  registerResources(server, stub as never);

  assert.equal(resourceCount, 7, "expected 7 total resources (2 fixed + 5 template)");
});

test("objectResource wraps JSON resources in a structured result envelope", () => {
  const result = objectResource("mc://versions/list", { versions: [] });
  const payload = JSON.parse(result.contents[0]!.text as string) as Record<string, unknown>;

  assert.deepEqual(payload.result, { versions: [] });
  assert.deepEqual(payload.meta, { uri: "mc://versions/list" });
});

test("errorResource returns structured problem details instead of a bare string", () => {
  const result = errorResource("mc://artifact/test", "Resource failed.");
  const payload = JSON.parse(result.contents[0]!.text as string) as Record<string, unknown>;

  assert.equal(typeof payload.error, "object");
  assert.deepEqual(payload.meta, { uri: "mc://artifact/test" });
  assert.deepEqual(payload.error, {
    type: "https://minecraft-modding-mcp.dev/problems/resource",
    title: "Resource read failed",
    detail: "Resource failed.",
    status: 400,
    code: "ERR_INVALID_INPUT",
    instance: "mc://artifact/test"
  });
});
