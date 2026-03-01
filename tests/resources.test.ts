import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
