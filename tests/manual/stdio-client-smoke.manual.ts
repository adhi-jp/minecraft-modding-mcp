import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createJar } from "../helpers/zip.ts";

const EXPECTED_TOOLS = [
  "list-versions",
  "resolve-artifact",
  "get-class-source",
  "search-class-source",
  "get-artifact-file",
  "trace-symbol-lifecycle",
  "diff-class-signatures",
  "find-mapping",
  "resolve-method-mapping-exact",
  "get-class-api-matrix",
  "resolve-workspace-symbol",
  "check-symbol-exists",
  "index-artifact"
] as const;

type ErrorPayload = {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: string;
  instance: string;
  fieldErrors?: unknown;
  hints?: unknown;
};

type ToolEnvelope<T extends Record<string, unknown>> =
  | { ok: true; result: T; meta: Record<string, unknown> }
  | { ok: false; error: ErrorPayload; meta: Record<string, unknown> };

function extractPayload(toolName: string, result: { content: Array<{ type: string; text?: string }> }): unknown {
  const textEntry = result.content.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof entry.text === "string"
  );

  if (!textEntry) {
    throw new Error(`${toolName}: no text content found.`);
  }

  try {
    return JSON.parse(textEntry.text);
  } catch {
    throw new Error(`${toolName}: text content is not valid JSON.`);
  }
}

function parseEnvelope(toolName: string, result: { content: Array<{ type: string; text?: string }> }): ToolEnvelope<Record<string, unknown>> {
  const payload = extractPayload(toolName, result);

  if (!payload || typeof payload !== "object") {
    throw new Error(`${toolName}: expected object payload.`);
  }

  const envelope = payload as Record<string, unknown>;
  if (!envelope.meta || typeof envelope.meta !== "object") {
    throw new Error(`${toolName}: missing object "meta" in payload.`);
  }

  if (envelope.result && typeof envelope.result === "object") {
    return {
      ok: true,
      result: envelope.result as Record<string, unknown>,
      meta: envelope.meta as Record<string, unknown>
    };
  }

  if (!envelope.error || typeof envelope.error !== "object") {
    throw new Error(`${toolName}: expected either "result" or "error" in payload.`);
  }

  const error = envelope.error as Record<string, unknown>;
  if (
    typeof error.type !== "string" ||
    typeof error.title !== "string" ||
    typeof error.detail !== "string" ||
    typeof error.status !== "number" ||
    typeof error.code !== "string" ||
    typeof error.instance !== "string"
  ) {
    throw new Error(`${toolName}: invalid problem details payload.`);
  }

  return {
    ok: false,
    error: {
      type: error.type,
      title: error.title,
      detail: error.detail,
      status: error.status,
      code: error.code,
      instance: error.instance,
      fieldErrors: error.fieldErrors,
      hints: error.hints
    },
    meta: envelope.meta as Record<string, unknown>
  };
}

function requireToolOk<T extends Record<string, unknown>>(
  toolName: string,
  result: { content: Array<{ type: string; text?: string }> }
): T {
  const envelope = parseEnvelope(toolName, result);
  if (envelope.ok) {
    return envelope.result as T;
  }
  throw new Error(`${toolName} failed: ${envelope.error.code} ${envelope.error.detail}`);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing string field: ${field}`);
  }
  return value;
}

async function ensureSqliteAvailable(): Promise<void> {
  const sqliteAvailable = await import("node:sqlite")
    .then(() => true)
    .catch(() => false);

  if (!sqliteAvailable) {
    throw new Error(
      "node:sqlite is unavailable. Use a Node.js version that includes the built-in sqlite module."
    );
  }
}

async function canUseStdioPipeReliably(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        "-e",
        [
          "process.stdin.resume();",
          "process.stdin.once('end', () => process.exit(42));",
          "setTimeout(() => process.exit(0), 150);"
        ].join("")
      ],
      {
        stdio: ["pipe", "ignore", "ignore"]
      }
    );

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      if (code === 42) {
        resolve(false);
        return;
      }
      reject(new Error(`stdio preflight exited unexpectedly with code ${code ?? "null"}.`));
    });
  });
}

async function main(): Promise<void> {
  await ensureSqliteAvailable();

  const stdioReady = await canUseStdioPipeReliably();
  if (!stdioReady) {
    console.warn("Manual stdio smoke skipped: stdin pipe closes immediately in this runtime.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "stdio-smoke-v03-"));
  const cacheDir = join(root, "cache");
  const sqlitePath = join(cacheDir, "source-cache.db");
  const binaryJarPath = join(root, "minecraft-client.jar");
  const sourcesJarPath = join(root, "minecraft-client-sources.jar");

  await mkdir(cacheDir, { recursive: true });

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/world/World.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });

  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "import net.minecraft.world.World;",
      "public class Main {",
      "  void tickServer() {",
      "    World.update();",
      "  }",
      "}"
    ].join("\n"),
    "net/minecraft/world/World.java": [
      "package net.minecraft.world;",
      "public class World {",
      "  static void update() {}",
      "}"
    ].join("\n")
  });

  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", "src/cli.ts"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      MCP_CACHE_DIR: cacheDir,
      MCP_SQLITE_PATH: sqlitePath
    }
  });

  const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    for (const expectedToolName of EXPECTED_TOOLS) {
      assert.ok(toolNames.includes(expectedToolName), `Missing tool "${expectedToolName}".`);
    }

    const resolveResult = await client.callTool({
      name: "resolve-artifact",
      arguments: {
        targetKind: "jar",
        targetValue: binaryJarPath,
        mapping: "official",
        allowDecompile: false
      }
    });

    const resolved = requireToolOk<Record<string, unknown>>("resolve-artifact", resolveResult as never);
    const artifactId = asString(resolved.artifactId, "artifactId");
    assert.equal(asString(resolved.mappingApplied, "mappingApplied"), "official");

    const classSourceResult = await client.callTool({
      name: "get-class-source",
      arguments: {
        artifactId,
        className: "net.minecraft.server.Main"
      }
    });

    const classSource = requireToolOk<Record<string, unknown>>("get-class-source", classSourceResult as never);
    assert.match(asString(classSource.sourceText, "sourceText"), /tickServer/);

    const searchResult = await client.callTool({
      name: "search-class-source",
      arguments: {
        artifactId,
        query: "tickServer",
        intent: "symbol",
        match: "exact",
        limit: 5
      }
    });

    const searched = requireToolOk<Record<string, unknown>>("search-class-source", searchResult as never);
    const hits = searched.hits;
    assert.ok(Array.isArray(hits), "Expected search hits array.");
    assert.ok(hits.length >= 1, "Expected at least one search hit.");

    const fileResult = await client.callTool({
      name: "get-artifact-file",
      arguments: {
        artifactId,
        filePath: "net/minecraft/server/Main.java"
      }
    });

    const file = requireToolOk<Record<string, unknown>>("get-artifact-file", fileResult as never);
    assert.match(asString(file.content, "content"), /class Main/);

    const mappingResult = await client.callTool({
      name: "find-mapping",
      arguments: {
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "official",
        targetMapping: "official"
      }
    });

    const mapped = requireToolOk<Record<string, unknown>>("find-mapping", mappingResult as never);
    assert.ok(Array.isArray(mapped.candidates), "Expected mapping candidates array.");

    const indexResult = await client.callTool({
      name: "index-artifact",
      arguments: {
        artifactId
      }
    });

    const reindexed = requireToolOk<Record<string, unknown>>("index-artifact", indexResult as never);
    assert.equal(typeof reindexed.reindexed, "boolean");

    console.log("Manual stdio client smoke passed: source tools validated.");
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
