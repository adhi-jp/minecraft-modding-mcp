import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { MCPClient, type CallToolResult } from "mcp-use/client";

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

const SERVER_STARTUP_TIMEOUT_MS = 20_000;
const LOG_BUFFER_LIMIT = 20_000;

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

type ManagedServerProcess = {
  child: ChildProcessWithoutNullStreams;
  getStdout: () => string;
  getStderr: () => string;
};

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

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve test port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function appendLog(buffer: string, chunk: unknown): string {
  const next = `${buffer}${String(chunk)}`;
  if (next.length <= LOG_BUFFER_LIMIT) {
    return next;
  }
  return next.slice(next.length - LOG_BUFFER_LIMIT);
}

function buildServerFailureMessage(reason: string, server: ManagedServerProcess): string {
  const stdout = server.getStdout().trim();
  const stderr = server.getStderr().trim();
  const stdoutPart = stdout ? `\n--- server stdout ---\n${stdout}` : "";
  const stderrPart = stderr ? `\n--- server stderr ---\n${stderr}` : "";
  return `${reason}${stdoutPart}${stderrPart}`;
}

async function startServer(
  port: number,
  env: { cacheDir: string; sqlitePath: string }
): Promise<ManagedServerProcess> {
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;

  const child = spawn("node", ["--import", "tsx", "src/cli.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      MCP_CACHE_DIR: env.cacheDir,
      MCP_SQLITE_PATH: env.sqlitePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = appendLog(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendLog(stderr, chunk);
  });
  child.once("error", (error) => {
    spawnError = error;
  });

  const managed: ManagedServerProcess = {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr
  };

  const startedAt = Date.now();
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  while (Date.now() - startedAt < SERVER_STARTUP_TIMEOUT_MS) {
    if (spawnError) {
      throw new Error(buildServerFailureMessage(`Failed to spawn MCP server: ${spawnError.message}`, managed));
    }
    if (child.exitCode !== null) {
      throw new Error(
        buildServerFailureMessage(`MCP server exited before startup (code: ${child.exitCode}).`, managed)
      );
    }

    try {
      const response = await fetch(mcpUrl, {
        headers: { accept: "application/json, text/event-stream" },
        signal: AbortSignal.timeout(1_000)
      });
      if (response.status >= 200 && response.status < 500) {
        return managed;
      }
    } catch {
      // server is still starting
    }

    await delay(150);
  }

  throw new Error(
    buildServerFailureMessage(
      `Timed out waiting for MCP server startup after ${SERVER_STARTUP_TIMEOUT_MS}ms.`,
      managed
    )
  );
}

async function stopServer(server: ManagedServerProcess | undefined): Promise<void> {
  if (!server) {
    return;
  }

  const { child } = server;
  if (child.exitCode !== null) {
    return;
  }

  const waitForTermExit = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([waitForTermExit, delay(3_000)]);

  if (child.exitCode === null) {
    const waitForKillExit = once(child, "exit");
    child.kill("SIGKILL");
    await Promise.race([waitForKillExit, delay(3_000)]);
  }
}

function extractPayload(toolName: string, result: CallToolResult): unknown {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const textEntry = result.content.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof entry.text === "string"
  );

  if (!textEntry) {
    throw new Error(`${toolName}: neither structuredContent nor text content exists.`);
  }

  try {
    return JSON.parse(textEntry.text);
  } catch {
    throw new Error(`${toolName}: text content is not valid JSON.`);
  }
}

function parseEnvelope(toolName: string, result: CallToolResult): ToolEnvelope<Record<string, unknown>> {
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

function requireToolOk<T extends Record<string, unknown>>(toolName: string, result: CallToolResult): T {
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

async function main(): Promise<void> {
  await ensureSqliteAvailable();
  const serverPort = await reservePort();

  const root = await mkdtemp(join(tmpdir(), "mcp-use-smoke-v03-"));
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

  let client: MCPClient | undefined;
  let server: ManagedServerProcess | undefined;

  try {
    server = await startServer(serverPort, { cacheDir, sqlitePath });
    client = MCPClient.fromDict({
      mcpServers: {
        local: {
          url: `http://127.0.0.1:${serverPort}/mcp`,
          transport: "http"
        }
      }
    });

    const session = await client.createSession("local");
    const tools = await session.listTools();
    const toolNames = tools.map((tool) => tool.name);

    for (const expectedToolName of EXPECTED_TOOLS) {
      assert.ok(toolNames.includes(expectedToolName), `Missing tool "${expectedToolName}".`);
    }

    const resolved = requireToolOk<Record<string, unknown>>(
      "resolve-artifact",
      await session.callTool("resolve-artifact", {
        targetKind: "jar",
        targetValue: binaryJarPath,
        mapping: "official",
        allowDecompile: false
      })
    );

    const artifactId = asString(resolved.artifactId, "artifactId");
    assert.equal(asString(resolved.mappingApplied, "mappingApplied"), "official");

    const classSource = requireToolOk<Record<string, unknown>>(
      "get-class-source",
      await session.callTool("get-class-source", {
        artifactId,
        className: "net.minecraft.server.Main"
      })
    );
    assert.match(asString(classSource.sourceText, "sourceText"), /tickServer/);

    const searched = requireToolOk<Record<string, unknown>>(
      "search-class-source",
      await session.callTool("search-class-source", {
        artifactId,
        query: "tickServer",
        intent: "symbol",
        match: "exact",
        limit: 5
      })
    );
    const hits = searched.hits;
    assert.ok(Array.isArray(hits), "Expected search hits array.");
    assert.ok(hits.length >= 1, "Expected at least one search hit.");

    const file = requireToolOk<Record<string, unknown>>(
      "get-artifact-file",
      await session.callTool("get-artifact-file", {
        artifactId,
        filePath: "net/minecraft/server/Main.java"
      })
    );
    assert.match(asString(file.content, "content"), /class Main/);

    const mapped = requireToolOk<Record<string, unknown>>(
      "find-mapping",
      await session.callTool("find-mapping", {
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "official",
        targetMapping: "official"
      })
    );
    assert.ok(Array.isArray(mapped.candidates), "Expected mapping candidates array.");

    const reindexed = requireToolOk<Record<string, unknown>>(
      "index-artifact",
      await session.callTool("index-artifact", {
        artifactId
      })
    );
    assert.equal(typeof reindexed.reindexed, "boolean");

    console.log("Manual mcp-use client smoke passed: source tools validated.");
  } finally {
    await client?.closeAllSessions().catch(() => undefined);
    await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
