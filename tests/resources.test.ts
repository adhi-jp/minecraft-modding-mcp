import assert from "node:assert/strict";
import test from "node:test";

import { MCPServer } from "mcp-use/server";

import { registerResources } from "../src/resources.js";

async function withSuppressedResourceCallbackNoise<T>(action: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const shouldSuppress = (args: unknown[]): boolean =>
    args.length === 1 && args[0] === "resourceCallbacks undefined";
  const shouldSuppressChunk = (chunk: unknown): boolean =>
    typeof chunk === "string" && chunk.trim() === "resourceCallbacks undefined";

  console.log = ((...args: unknown[]) => {
    if (shouldSuppress(args)) {
      return;
    }
    originalLog(...args);
  }) as typeof console.log;
  console.warn = ((...args: unknown[]) => {
    if (shouldSuppress(args)) {
      return;
    }
    originalWarn(...args);
  }) as typeof console.warn;

  (process.stdout.write as unknown as (...args: unknown[]) => boolean) = (
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean => {
    if (shouldSuppressChunk(chunk)) {
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }
    return originalStdoutWrite(chunk as never, encoding as never, callback as never);
  };

  (process.stderr.write as unknown as (...args: unknown[]) => boolean) = (
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean => {
    if (shouldSuppressChunk(chunk)) {
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }
    return originalStderrWrite(chunk as never, encoding as never, callback as never);
  };

  try {
    return await action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    (process.stdout.write as unknown as (...args: unknown[]) => boolean) = originalStdoutWrite as unknown as (
      ...args: unknown[]
    ) => boolean;
    (process.stderr.write as unknown as (...args: unknown[]) => boolean) = originalStderrWrite as unknown as (
      ...args: unknown[]
    ) => boolean;
  }
}

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
  return withSuppressedResourceCallbackNoise(() => {
    const server = new MCPServer({ name: "test", version: "0.0.0" });
    const stub = createStubSourceService();

    assert.doesNotThrow(() => {
      registerResources(server, stub as never);
    });
  });
});

test("registerResources registers exactly 2 fixed and 5 template resources", () => {
  return withSuppressedResourceCallbackNoise(() => {
    const server = new MCPServer({ name: "test", version: "0.0.0" });
    const stub = createStubSourceService();

    let resourceCount = 0;
    let templateCount = 0;
    const origResource = server.resource.bind(server);
    const origTemplate = server.resourceTemplate.bind(server);

    server.resource = (...args: Parameters<typeof server.resource>) => {
      resourceCount++;
      return origResource(...args);
    };
    server.resourceTemplate = (...args: Parameters<typeof server.resourceTemplate>) => {
      templateCount++;
      return origTemplate(...args);
    };

    registerResources(server, stub as never);

    assert.equal(resourceCount, 2, "expected 2 fixed resources");
    assert.equal(templateCount, 5, "expected 5 template resources");
  });
});

test("class-source template returns MCP error for malformed URL encoding", async () => {
  await withSuppressedResourceCallbackNoise(async () => {
    const server = new MCPServer({ name: "test", version: "0.0.0" });
    const stub = createStubSourceService();
    registerResources(server, stub as never);

    const template = (server as unknown as {
      registrations: {
        resourceTemplates: Map<string, { handler: (uri: URL, params: Record<string, string>) => Promise<unknown> }>;
      };
    }).registrations.resourceTemplates.get("class-source");
    assert.ok(template, "class-source template should be registered");

    const result = await template.handler(
      new URL("mc://source/artifact/%E0%A4%A"),
      { artifactId: "artifact", className: "%E0%A4%A" }
    );

    assert.equal((result as { isError?: boolean }).isError, true);
  });
});
