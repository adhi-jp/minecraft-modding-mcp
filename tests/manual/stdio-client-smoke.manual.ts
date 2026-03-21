import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createJar } from "../helpers/zip.ts";
import {
  createDirectWorkerBridgeTransport,
  selectManualStdioMode
} from "../helpers/manual-stdio-bridge.ts";
import type { ListVersionsOutput } from "../../src/version-service.ts";

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

async function measureToolCall<T extends Record<string, unknown>>(
  toolName: string,
  call: () => Promise<{ content: Array<{ type: string; text?: string }> }>
): Promise<{ result: T; durationMs: number }> {
  const startedAt = performance.now();
  const response = await call();
  const durationMs = performance.now() - startedAt;
  return {
    result: requireToolOk<T>(toolName, response),
    durationMs
  };
}

type ColdWarmProbe = {
  coldMs: number;
  warmMs: number;
};

function classifyColdStartProbes(probes: {
  artifactResolve: ColdWarmProbe;
  searchClassSource: ColdWarmProbe;
}): {
  classification: "steady-state-like" | "cold-start-overhead-observed" | "manual-review-needed";
  reason: string;
  ratios: {
    artifactResolve: number | null;
    searchClassSource: number | null;
    worstObserved: number | null;
  };
} {
  const artifactResolveRatio = probes.artifactResolve.warmMs > 0
    ? probes.artifactResolve.coldMs / probes.artifactResolve.warmMs
    : null;
  const searchClassSourceRatio = probes.searchClassSource.warmMs > 0
    ? probes.searchClassSource.coldMs / probes.searchClassSource.warmMs
    : null;
  const finiteRatios = [artifactResolveRatio, searchClassSourceRatio].filter((ratio): ratio is number => ratio != null && Number.isFinite(ratio));

  if (finiteRatios.length !== 2) {
    return {
      classification: "manual-review-needed",
      reason: "At least one warm probe duration was zero or invalid, so the cold/warm ratio could not be classified automatically.",
      ratios: {
        artifactResolve: artifactResolveRatio,
        searchClassSource: searchClassSourceRatio,
        worstObserved: null
      }
    };
  }

  const worstObserved = Math.max(...finiteRatios);
  if (worstObserved >= 1.25) {
    return {
      classification: "cold-start-overhead-observed",
      reason: `The worst cold/warm ratio was ${worstObserved.toFixed(2)}x, so cold-start overhead was measurable in this environment.`,
      ratios: {
        artifactResolve: artifactResolveRatio,
        searchClassSource: searchClassSourceRatio,
        worstObserved
      }
    };
  }

  return {
    classification: "steady-state-like",
    reason: `The worst cold/warm ratio stayed within 1.25x (${worstObserved.toFixed(2)}x), so the probes behaved close to steady-state in this environment.`,
    ratios: {
      artifactResolve: artifactResolveRatio,
      searchClassSource: searchClassSourceRatio,
      worstObserved
    }
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing string field: ${field}`);
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChildPid(pidFile: string, previousPid?: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const raw = (await readFile(pidFile, "utf8")).trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== previousPid) {
        return pid;
      }
    } catch {
      // Wait for the supervisor to publish the current worker pid.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for worker pid file: ${pidFile}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
      return false;
    }

    await wait(50);
  }

  return false;
}

async function terminateChildProcess(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null) {
    child.unref();
    return;
  }

  const pid = child.pid;

  try {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  } catch {
    // Best-effort stream teardown only.
  }

  try {
    child.kill("SIGTERM");
  } catch {
    child.unref();
    return;
  }

  if (pid != null && await waitForProcessExit(pid, timeoutMs)) {
    child.unref();
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    child.unref();
    return;
  }

  if (pid != null) {
    await waitForProcessExit(pid, timeoutMs);
  }
  child.unref();
}

type ManagedTransport = Transport & {
  pid?: number | null;
};

async function closeTransportWithTimeout(transport: ManagedTransport, timeoutMs = 5_000): Promise<void> {
  const pid = transport.pid ?? null;
  const closePromise = transport.close().catch(() => undefined);
  const timedOut = await Promise.race([
    closePromise.then(() => false),
    wait(timeoutMs).then(() => true)
  ]);

  if (!timedOut || pid == null) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  if (await waitForProcessExit(pid, 2_000)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }

  await waitForProcessExit(pid, 2_000);
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

function tryExtractContentLengthMessage(buffer: Buffer): { message: unknown; consumedBytes: number } | undefined {
  const headersEnd = buffer.indexOf("\r\n\r\n");
  if (headersEnd === -1) {
    return undefined;
  }

  const headers = buffer.subarray(0, headersEnd).toString("utf8");
  const lengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
  if (!lengthMatch) {
    throw new Error("Content-Length response missing Content-Length header.");
  }

  const contentLength = Number.parseInt(lengthMatch[1], 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error(`Invalid Content-Length value: ${lengthMatch[1]}`);
  }

  const bodyStart = headersEnd + 4;
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) {
    return undefined;
  }

  const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
  return {
    message: JSON.parse(body),
    consumedBytes: bodyEnd
  };
}

async function assertContentLengthInitializeHandshake(env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", "src/cli.ts"], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdoutBuffer = Buffer.alloc(0);
    let stderrOutput = "";
    let settled = false;

    const finalize = async (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      child.stdout.off("data", onStdoutData);
      child.stderr.off("data", onStderrData);
      child.off("error", onChildError);
      child.off("exit", onChildExit);
      await terminateChildProcess(child);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const onStdoutData = (chunk: Buffer | string) => {
      try {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunkBuffer]);
        const parsed = tryExtractContentLengthMessage(stdoutBuffer);
        if (!parsed) {
          return;
        }

        const payload = parsed.message as Record<string, unknown>;
        assert.equal(payload.jsonrpc, "2.0");
        assert.equal(payload.id, 1);
        assert.ok(typeof payload.result === "object" && payload.result != null);

        const result = payload.result as Record<string, unknown>;
        assert.equal(result.protocolVersion, "2024-11-05");
        void finalize();
      } catch (error) {
        void finalize(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onStderrData = (chunk: Buffer | string) => {
      stderrOutput += chunk.toString();
    };

    const onChildError = (error: Error) => {
      void finalize(error);
    };

    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!settled) {
        void finalize(
          new Error(
            `Content-Length initialize handshake failed: child exited before response (code=${code ?? "null"}, signal=${signal ?? "null"}).\nstderr:\n${stderrOutput}`
          )
        );
      }
    };

    const timeoutHandle = setTimeout(() => {
      void finalize(
        new Error(
          `Timed out waiting for Content-Length initialize response.\nstderr:\n${stderrOutput}`
        )
      );
    }, 5_000);

    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.once("error", onChildError);
    child.once("exit", onChildExit);

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "manual-content-length-smoke",
          version: "1.0.0"
        }
      }
    };
    const body = JSON.stringify(request);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  });
}

async function main(): Promise<void> {
  await ensureSqliteAvailable();

  const stdioMode = selectManualStdioMode(await canUseStdioPipeReliably());

  const root = await mkdtemp(join(tmpdir(), "stdio-smoke-v03-"));
  const cacheDir = join(root, "cache");
  const sqlitePath = join(cacheDir, "source-cache.db");
  const binaryJarPath = join(root, "minecraft-client.jar");
  const sourcesJarPath = join(root, "minecraft-client-sources.jar");
  const probeBinaryJarPath = join(root, "probe-client.jar");
  const probeSourcesJarPath = join(root, "probe-client-sources.jar");
  const workspacePath = join(root, "workspace");
  const workspaceLoomCacheDir = join(workspacePath, ".gradle", "loom-cache", "1.21.10");
  const workspaceBinaryJarPath = join(workspaceLoomCacheDir, "minecraft-merged-1.21.10.jar");
  const workspaceSourcesJarPath = join(workspaceLoomCacheDir, "minecraft-merged-1.21.10-sources.jar");
  const workerPidFile = join(root, "worker.pid");
  const transportEnv = {
    ...process.env,
    NODE_ENV: "production",
    MCP_CACHE_DIR: cacheDir,
    MCP_SQLITE_PATH: sqlitePath,
    MCP_SUPERVISOR_CHILD_PID_FILE: workerPidFile
  };

  await mkdir(cacheDir, { recursive: true });
  if (stdioMode.kind === "native") {
    await assertContentLengthInitializeHandshake(transportEnv);
  } else {
    console.log(
      `Manual stdio smoke fallback active: ${stdioMode.detail} Running the direct worker through a bash bridge; worker restart validation is disabled in this mode.`
    );
  }

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

  await createJar(probeBinaryJarPath, {
    "net/minecraft/server/ProbeMain.class": Buffer.from([0xca, 0xfe, 0xba, 0xaa]),
    "net/minecraft/world/ProbeWorld.class": Buffer.from([0xca, 0xfe, 0xba, 0xab])
  });

  await createJar(probeSourcesJarPath, {
    "net/minecraft/server/ProbeMain.java": [
      "package net.minecraft.server;",
      "import net.minecraft.world.ProbeWorld;",
      "public class ProbeMain {",
      "  void probeTick() {",
      "    ProbeWorld.update();",
      "  }",
      "}"
    ].join("\n"),
    "net/minecraft/world/ProbeWorld.java": [
      "package net.minecraft.world;",
      "public class ProbeWorld {",
      "  static void update() {}",
      "}"
    ].join("\n")
  });

  await mkdir(workspaceLoomCacheDir, { recursive: true });
  await writeFile(join(workspacePath, "gradle.properties"), "minecraft_version=1.21.10\n", "utf8");
  await createJar(workspaceBinaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await createJar(workspaceSourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {}"
    ].join("\n"),
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {}"
    ].join("\n")
  });

  const transport: ManagedTransport = stdioMode.kind === "native"
    ? new StdioClientTransport({
        command: "node",
        args: ["--import", "tsx", "src/cli.ts"],
        env: transportEnv
      })
    : createDirectWorkerBridgeTransport({
        cwd: process.cwd(),
        env: transportEnv
      });

  const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const initialWorkerPid = stdioMode.supportsWorkerRestartValidation
      ? await waitForChildPid(workerPidFile)
      : undefined;

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    for (const expectedToolName of EXPECTED_TOOLS) {
      assert.ok(toolNames.includes(expectedToolName), `Missing tool "${expectedToolName}".`);
    }

    const resolveResult = await client.callTool({
      name: "resolve-artifact",
      arguments: {
        target: {
          kind: "jar",
          value: binaryJarPath
        },
        mapping: "obfuscated",
        allowDecompile: false
      }
    });

    const resolved = requireToolOk<Record<string, unknown>>("resolve-artifact", resolveResult as never);
    const artifactId = asString(resolved.artifactId, "artifactId");
    assert.equal(asString(resolved.mappingApplied, "mappingApplied"), "obfuscated");

    const classSourceResult = await client.callTool({
      name: "get-class-source",
      arguments: {
        target: {
          type: "artifact",
          artifactId
        },
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
        sourceMapping: "obfuscated",
        targetMapping: "obfuscated"
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

    if (initialWorkerPid !== undefined) {
      process.kill(initialWorkerPid, "SIGKILL");
      const restartedWorkerPid = await waitForChildPid(workerPidFile, initialWorkerPid);
      assert.notEqual(restartedWorkerPid, initialWorkerPid);

      const versionsAfterRestartResult = await client.callTool({
        name: "list-versions",
        arguments: {
          limit: 1
        }
      });
      const versionsAfterRestart = requireToolOk<ListVersionsOutput>(
        "list-versions-after-restart",
        versionsAfterRestartResult as never
      );
      assert.ok(Array.isArray(versionsAfterRestart.releases), "Expected releases list after worker restart.");
      assert.equal(typeof versionsAfterRestart.totalAvailable, "number");
    }

    const probeResolveArtifactCold = await measureToolCall<Record<string, unknown>>(
      "resolve-artifact-probe-cold",
      () =>
        client.callTool({
          name: "resolve-artifact",
          arguments: {
            target: {
              kind: "jar",
              value: probeBinaryJarPath
            },
            mapping: "obfuscated",
            allowDecompile: false
          }
        }) as Promise<{ content: Array<{ type: string; text?: string }> }>
    );
    const probeResolveArtifactWarm = await measureToolCall<Record<string, unknown>>(
      "resolve-artifact-probe-warm",
      () =>
        client.callTool({
          name: "resolve-artifact",
          arguments: {
            target: {
              kind: "jar",
              value: probeBinaryJarPath
            },
            mapping: "obfuscated",
            allowDecompile: false
          }
        }) as Promise<{ content: Array<{ type: string; text?: string }> }>
    );
    const probeArtifactId = asString(probeResolveArtifactCold.result.artifactId, "probeArtifactId");
    const probeSearchClassSourceCold = await measureToolCall<Record<string, unknown>>(
      "search-class-source-probe-cold",
      () =>
        client.callTool({
          name: "search-class-source",
          arguments: {
            artifactId: probeArtifactId,
            query: "probeTick",
            intent: "symbol",
            match: "exact",
            limit: 5
          }
        }) as Promise<{ content: Array<{ type: string; text?: string }> }>
    );
    const probeSearchClassSourceWarm = await measureToolCall<Record<string, unknown>>(
      "search-class-source-probe-warm",
      () =>
        client.callTool({
          name: "search-class-source",
          arguments: {
            artifactId: probeArtifactId,
            query: "probeTick",
            intent: "symbol",
            match: "exact",
            limit: 5
          }
        }) as Promise<{ content: Array<{ type: string; text?: string }> }>
    );

    assert.equal(asString(probeResolveArtifactCold.result.mappingApplied, "probeMappingApplied"), "obfuscated");
    assert.ok(Array.isArray(probeSearchClassSourceCold.result.hits), "Expected probe search hits array.");
    const coldStartClassification = classifyColdStartProbes({
      artifactResolve: {
        coldMs: probeResolveArtifactCold.durationMs,
        warmMs: probeResolveArtifactWarm.durationMs
      },
      searchClassSource: {
        coldMs: probeSearchClassSourceCold.durationMs,
        warmMs: probeSearchClassSourceWarm.durationMs
      }
    });

    console.log(
      "Cold-start perf probes:",
      JSON.stringify(
        {
          transportMode: stdioMode.kind,
          workerRestartValidation: stdioMode.supportsWorkerRestartValidation,
          conditions: {
            appCache: "empty at process start",
            gradleCache: "workspace loom cache pre-populated",
            contentLengthHandshake: stdioMode.kind === "native" ? "validated" : "skipped in bash-bridge fallback"
          },
          probes: {
            artifactResolve: {
              coldMs: Number(probeResolveArtifactCold.durationMs.toFixed(3)),
              warmMs: Number(probeResolveArtifactWarm.durationMs.toFixed(3))
            },
            searchClassSource: {
              coldMs: Number(probeSearchClassSourceCold.durationMs.toFixed(3)),
              warmMs: Number(probeSearchClassSourceWarm.durationMs.toFixed(3))
            }
          },
          classification: coldStartClassification.classification,
          classificationReason: coldStartClassification.reason,
          ratios: {
            artifactResolve: coldStartClassification.ratios.artifactResolve == null
              ? null
              : Number(coldStartClassification.ratios.artifactResolve.toFixed(3)),
            searchClassSource: coldStartClassification.ratios.searchClassSource == null
              ? null
              : Number(coldStartClassification.ratios.searchClassSource.toFixed(3)),
            worstObserved: coldStartClassification.ratios.worstObserved == null
              ? null
              : Number(coldStartClassification.ratios.worstObserved.toFixed(3))
          },
          nextMeasurement: "pnpm test:manual:stdio-smoke"
        },
        null,
        2
      )
    );

    if (stdioMode.supportsWorkerRestartValidation) {
      console.log("Manual stdio client smoke passed: source tools and worker auto-restart validated.");
    } else {
      console.log("Manual stdio client smoke passed via bash bridge fallback: source tools validated in a runtime where Node child-process stdio pipes close stdin immediately.");
    }
  } finally {
    await closeTransportWithTimeout(transport);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
