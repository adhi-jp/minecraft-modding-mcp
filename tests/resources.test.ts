import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createError, ERROR_CODES } from "../src/errors.js";
import { errorResource, objectResource } from "../src/mcp-helpers.js";
import { registerResources } from "../src/resources.js";

function createStubSourceService(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listVersions: async () => ({ versions: [] }),
    getRuntimeMetrics: () => ({ uptime: 0 }),
    getClassSource: async () => ({ sourceText: "" }),
    getArtifactFile: async () => ({ content: "" }),
    findMapping: async () => ({}),
    getClassMembers: async () => ({ members: {} }),
    getArtifact: () => ({}),
    ...overrides
  };
}

function captureResources(sourceServiceOverrides: Record<string, unknown> = {}) {
  const registrations = new Map<string, { handler: (...args: any[]) => Promise<any> }>();
  const server = {
    resource(
      name: string,
      _target: unknown,
      _metadata: unknown,
      handler: (...args: any[]) => Promise<any>
    ) {
      registrations.set(name, { handler });
      return undefined;
    }
  } as unknown as McpServer;

  registerResources(server, createStubSourceService(sourceServiceOverrides) as never);
  return registrations;
}

function parseJsonResource(result: { contents: Array<{ text?: string }> }) {
  return JSON.parse(result.contents[0]!.text as string) as Record<string, any>;
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

test("class-source resource decodes template params before calling sourceService", async () => {
  let receivedInput: Record<string, string> | undefined;
  const registrations = captureResources({
    async getClassSource(input: Record<string, string>) {
      receivedInput = input;
      return { sourceText: "class Example {}" };
    }
  });

  const handler = registrations.get("class-source")?.handler;
  assert.ok(handler);

  const result = await handler(
    new URL("mc://source/artifact-1/com.example%2FMain"),
    { artifactId: "artifact-1", className: "com.example%2FMain" }
  );

  assert.deepEqual(receivedInput, {
    artifactId: "artifact-1",
    className: "com.example/Main"
  });
  assert.equal(result.contents[0]?.text, "class Example {}");
});

test("class-source resource returns an invalid-input envelope for missing template params", async () => {
  const registrations = captureResources();
  const handler = registrations.get("class-source")?.handler;
  assert.ok(handler);

  const result = await handler(
    new URL("mc://source/artifact-1"),
    { artifactId: "artifact-1" }
  );
  const payload = parseJsonResource(result);

  assert.equal(payload.error.code, ERROR_CODES.INVALID_INPUT);
  assert.match(payload.error.detail, /Missing template parameter: className/);
  assert.deepEqual(payload.meta, { uri: "mc://source/artifact-1" });
});

test("class-source resource returns an invalid-input envelope for invalid URL encoding", async () => {
  const registrations = captureResources();
  const handler = registrations.get("class-source")?.handler;
  assert.ok(handler);

  const result = await handler(
    new URL("mc://source/artifact-1/%25E0"),
    { artifactId: "artifact-1", className: "%E0%A4%A" }
  );
  const payload = parseJsonResource(result);

  assert.equal(payload.error.code, ERROR_CODES.INVALID_INPUT);
  assert.match(payload.error.detail, /className contains invalid URL encoding/);
});

test("versions-list resource converts AppError failures into resource error envelopes", async () => {
  const registrations = captureResources({
    async listVersions() {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: "manifest unavailable"
      });
    }
  });
  const handler = registrations.get("versions-list")?.handler;
  assert.ok(handler);

  const result = await handler(new URL("mc://versions/list"));
  const payload = parseJsonResource(result);

  assert.equal(payload.error.code, ERROR_CODES.VERSION_NOT_FOUND);
  assert.equal(payload.error.status, 404);
  assert.equal(payload.error.detail, "manifest unavailable");
  assert.deepEqual(payload.meta, { uri: "mc://versions/list" });
});

test("remaining resources delegate to the expected source-service methods", async () => {
  const received: Record<string, unknown> = {};
  const registrations = captureResources({
    getRuntimeMetrics() {
      received.runtimeMetrics = true;
      return { uptime: 12 };
    },
    async getArtifactFile(input: Record<string, string>) {
      received.artifactFile = input;
      return { content: "artifact-body" };
    },
    async findMapping(input: Record<string, string>) {
      received.findMapping = input;
      return { resolved: true };
    },
    async getClassMembers(input: Record<string, string>) {
      received.classMembers = input;
      return { methods: ["run"] };
    },
    getArtifact(artifactId: string) {
      received.artifactId = artifactId;
      return { artifactId, origin: "cache" };
    }
  });

  const runtimeResult = await registrations.get("runtime-metrics")!.handler(new URL("mc://metrics"));
  const runtimePayload = parseJsonResource(runtimeResult);
  assert.deepEqual(runtimePayload.result, { uptime: 12 });
  assert.equal(received.runtimeMetrics, true);

  const artifactFileResult = await registrations.get("artifact-file")!.handler(
    new URL("mc://artifact/artifact-1/files/src%2FMain.java"),
    { artifactId: "artifact-1", filePath: "src%2FMain.java" }
  );
  assert.equal(artifactFileResult.contents[0]?.text, "artifact-body");
  assert.deepEqual(received.artifactFile, {
    artifactId: "artifact-1",
    filePath: "src/Main.java"
  });

  const findMappingResult = await registrations.get("find-mapping")!.handler(
    new URL("mc://mappings/1.21.4/obfuscated/mojang/class/com.example%2FMain"),
    {
      version: "1.21.4",
      kind: "class",
      name: "com.example%2FMain",
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    }
  );
  const findMappingPayload = parseJsonResource(findMappingResult);
  assert.deepEqual(received.findMapping, {
    version: "1.21.4",
    kind: "class",
    name: "com.example/Main",
    sourceMapping: "obfuscated",
    targetMapping: "mojang"
  });
  assert.deepEqual(findMappingPayload.result, { resolved: true });

  const classMembersResult = await registrations.get("class-members")!.handler(
    new URL("mc://artifact/artifact-1/members/com.example%2FMain"),
    { artifactId: "artifact-1", className: "com.example%2FMain" }
  );
  const classMembersPayload = parseJsonResource(classMembersResult);
  assert.deepEqual(received.classMembers, {
    artifactId: "artifact-1",
    className: "com.example/Main"
  });
  assert.deepEqual(classMembersPayload.result, { methods: ["run"] });

  const artifactMetadataResult = await registrations.get("artifact-metadata")!.handler(
    new URL("mc://artifact/artifact-1"),
    { artifactId: "artifact-1" }
  );
  const artifactMetadataPayload = parseJsonResource(artifactMetadataResult);
  assert.equal(received.artifactId, "artifact-1");
  assert.deepEqual(artifactMetadataPayload.result, {
    artifactId: "artifact-1",
    origin: "cache"
  });
});
