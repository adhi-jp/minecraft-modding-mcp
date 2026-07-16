import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildClassFile } from "../../helpers/classfile.ts";
import { buildInnerJarBytes, createShellJar } from "../../helpers/nested-jar.ts";
import { createJar } from "../../helpers/zip.ts";

const integrationRoot = await mkdtemp(join(tmpdir(), "mcp-find-class-integration-"));
process.env.MCP_CACHE_DIR = join(integrationRoot, "cache");
process.env.MCP_LOCAL_M2 = join(integrationRoot, "m2");

async function harness() {
  return import("../../helpers/mcp-tools-harness.ts");
}

test("find-class tools/list exposes workspace context for dependency targets", async () => {
  const { listTools } = await harness();
  const tool = (await listTools()).find((entry) => entry.name === "find-class");
  const schema = tool?.inputSchema as {
    properties?: { projectPath?: { description?: string } };
  } | undefined;

  assert.ok(tool);
  assert.match(schema?.properties?.projectPath?.description ?? "", /workspace root/i);
});

test("find-class forwards projectPath while resolving a dependency version from a workspace", async () => {
  const project = join(integrationRoot, "workspace");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "gradle.properties"), "fixture_lib_version=1.0.0\n", "utf8");

  const m2Version = join(
    process.env.MCP_LOCAL_M2!,
    "com",
    "example",
    "fixture-lib",
    "1.0.0"
  );
  await mkdir(m2Version, { recursive: true });
  await createJar(join(m2Version, "fixture-lib-1.0.0.jar"), {
    "com/example/FixtureWidget.class": buildClassFile({ internalName: "com/example/FixtureWidget" })
  });
  await createJar(join(m2Version, "fixture-lib-1.0.0-sources.jar"), {
    "com/example/FixtureWidget.java": "package com.example;\npublic class FixtureWidget {}\n"
  });

  const { callTool } = await harness();
  const response = await callTool("find-class", {
    className: "FixtureWidget",
    target: {
      kind: "dependency",
      group: "com.example",
      name: "fixture-lib",
      versionFromProject: true
    },
    projectPath: project
  }) as {
    structuredContent?: {
      result?: { matches?: Array<{ qualifiedName?: string }> };
      error?: { code?: string };
      meta?: { tool?: string };
    };
  };

  assert.equal(response.structuredContent?.error, undefined);
  assert.equal(response.structuredContent?.meta?.tool, "find-class");
  assert.deepEqual(
    Object.keys(response.structuredContent?.result ?? {}).sort(),
    ["matches", "total"]
  );
  assert.deepEqual(
    response.structuredContent?.result?.matches?.map((match) => match.qualifiedName),
    ["com.example.FixtureWidget"]
  );
});

test("find-class returns nested shell matches through the standard MCP envelope", async () => {
  const inner = await buildInnerJarBytes({
    "com/example/nested/NestedWidget.class": buildClassFile({
      internalName: "com/example/nested/NestedWidget"
    })
  });
  const shellPath = join(integrationRoot, "fabric-shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/widget-api.jar": inner });

  const { callTool } = await harness();
  const response = await callTool("find-class", {
    className: "NestedWidget",
    target: { kind: "jar", value: shellPath }
  }) as {
    structuredContent?: {
      result?: { matches?: Array<{ qualifiedName?: string }> };
      error?: { code?: string };
      meta?: { tool?: string };
    };
  };

  assert.equal(response.structuredContent?.error, undefined);
  assert.equal(response.structuredContent?.meta?.tool, "find-class");
  assert.deepEqual(
    response.structuredContent?.result?.matches?.map((match) => match.qualifiedName),
    ["com.example.nested.NestedWidget"]
  );
});

test("find-class maps invalid projectPath input to ERR_INVALID_INPUT", async () => {
  const { callTool } = await harness();
  const response = await callTool("find-class", {
    className: "Widget",
    artifactId: "unused",
    projectPath: "   "
  }) as {
    structuredContent?: {
      error?: { code?: string; fieldErrors?: Array<{ path?: string }> };
      meta?: { tool?: string };
    };
  };

  assert.equal(response.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(
    response.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "projectPath")
  );
  assert.equal(response.structuredContent?.meta?.tool, "find-class");
});
