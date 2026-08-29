import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildClassFile } from "../../helpers/classfile.ts";
import { createJar } from "../../helpers/zip.ts";

const integrationRoot = await mkdtemp(join(tmpdir(), "mcp-get-artifact-file-integration-"));
process.env.MCP_CACHE_DIR = join(integrationRoot, "cache");
process.env.MCP_LOCAL_M2 = join(integrationRoot, "m2");

async function harness() {
  return import("../../helpers/mcp-tools-harness.ts");
}

async function seedFixtureDependency() {
  const m2Version = join(process.env.MCP_LOCAL_M2!, "com", "example", "fixture-lib", "1.0.0");
  await mkdir(m2Version, { recursive: true });
  await createJar(join(m2Version, "fixture-lib-1.0.0.jar"), {
    "com/example/FixtureWidget.class": buildClassFile({ internalName: "com/example/FixtureWidget" })
  });
  await createJar(join(m2Version, "fixture-lib-1.0.0-sources.jar"), {
    "com/example/FixtureWidget.java": "package com.example;\npublic class FixtureWidget {}\n"
  });
}

test("get-artifact-file forwards projectPath while resolving a dependency version from a workspace", async () => {
  await seedFixtureDependency();

  const project = join(integrationRoot, "workspace-success");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "gradle.properties"), "fixture_lib_version=1.0.0\n", "utf8");

  const { callTool } = await harness();
  const response = (await callTool("get-artifact-file", {
    target: {
      kind: "dependency",
      group: "com.example",
      name: "fixture-lib",
      versionFromProject: true
    },
    projectPath: project,
    filePath: "com/example/FixtureWidget.java"
  })) as {
    structuredContent?: {
      result?: { content?: string };
      error?: { code?: string };
      meta?: { tool?: string };
    };
  };

  assert.equal(response.structuredContent?.error, undefined);
  assert.equal(response.structuredContent?.meta?.tool, "get-artifact-file");
  assert.match(response.structuredContent?.result?.content ?? "", /class FixtureWidget/);
});

test("get-artifact-file without projectPath still rejects an unversioned dependency target", async () => {
  await seedFixtureDependency();

  const { callTool } = await harness();
  const response = (await callTool("get-artifact-file", {
    target: {
      kind: "dependency",
      group: "com.example",
      name: "fixture-lib",
      versionFromProject: true
    },
    filePath: "com/example/FixtureWidget.java"
  })) as {
    structuredContent?: {
      error?: { code?: string; detail?: string; fieldErrors?: Array<{ path?: string }> };
      meta?: { tool?: string };
    };
  };

  assert.equal(response.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.match(response.structuredContent?.error?.detail ?? "", /projectPath is required/);
  assert.ok(
    response.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "projectPath")
  );
  assert.equal(response.structuredContent?.meta?.tool, "get-artifact-file");
});
