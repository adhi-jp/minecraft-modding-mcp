import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { RegistryService } from "../src/registry-service.ts";
import type { Config } from "../src/types.ts";

function buildTestConfig(root: string): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: join(root, "cache", "source-cache.db"),
    sourceRepos: [],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    indexedSearchEnabled: true,
    mappingSourcePriority: "loom-first",
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 1_000,
    fetchRetries: 0,
    searchScanPageSize: 250,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024,
    tinyRemapperJarPath: undefined,
    remapTimeoutMs: 600_000,
    remapMaxMemoryMb: 4096
  };
}

async function installFakeJava(binDir: string, body: string): Promise<void> {
  const runnerPath = join(binDir, "java-runner.cjs");
  await writeFile(runnerPath, body, "utf8");

  if (process.platform === "win32") {
    await writeFile(
      join(binDir, "java.cmd"),
      `@echo off\r\n"${process.execPath}" "${runnerPath}" %*\r\n`,
      "utf8"
    );
    return;
  }

  const wrapperPath = join(binDir, "java");
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec "${process.execPath}" "${runnerPath}" "$@"\n`,
    "utf8"
  );
  await chmod(wrapperPath, 0o755);
}

test("RegistryService discards corrupt cached registries and regenerates them", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-service-recover-"));
  const config = buildTestConfig(root);
  const version = "1.20.1";
  const registryDir = join(config.cacheDir, "registries", version);
  const staleRegistryPath = join(registryDir, "registries.json");
  const reportsRegistryPath = join(registryDir, "reports", "registries.json");
  await mkdir(registryDir, { recursive: true });
  await writeFile(staleRegistryPath, "{not json", "utf8");

  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  await installFakeJava(
    binDir,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.lastIndexOf("--output");',
      "const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : process.cwd();",
      'const registryPath = path.join(outputDir, "reports", "registries.json");',
      'fs.mkdirSync(path.dirname(registryPath), { recursive: true });',
      'fs.writeFileSync(registryPath, JSON.stringify({ "minecraft:block": { entries: { "minecraft:stone": { protocol_id: 1 } } } }));'
    ].join("\n")
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;

  try {
    const service = new RegistryService(
      config,
      {
        async resolveServerJar(requestedVersion: string) {
          assert.equal(requestedVersion, version);
          return {
            version: requestedVersion,
            jarPath: join(root, "fake-server.jar")
          };
        }
      } as any
    );
    await writeFile(join(root, "fake-server.jar"), "stub", "utf8");

    const result = await service.getRegistryData({ version });

    assert.deepEqual(result.registries, ["minecraft:block"]);
    assert.equal(result.entryCount, 1);
    assert.match(result.warnings.join("\n"), /corrupt cached registry snapshot/i);
    assert.equal(existsSync(staleRegistryPath), false);
    assert.equal(existsSync(reportsRegistryPath), true);

    const regenerated = JSON.parse(await readFile(reportsRegistryPath, "utf8")) as Record<string, unknown>;
    assert.ok("minecraft:block" in regenerated);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test("RegistryService maps invalid regenerated registry snapshots to ERR_REGISTRY_GENERATION_FAILED", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-service-invalid-"));
  const config = buildTestConfig(root);
  const version = "1.20.1";
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  await installFakeJava(
    binDir,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.lastIndexOf("--output");',
      "const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : process.cwd();",
      'const registryPath = path.join(outputDir, "reports", "registries.json");',
      'fs.mkdirSync(path.dirname(registryPath), { recursive: true });',
      'fs.writeFileSync(registryPath, "{not json");'
    ].join("\n")
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;

  try {
    const service = new RegistryService(
      config,
      {
        async resolveServerJar(requestedVersion: string) {
          return {
            version: requestedVersion,
            jarPath: join(root, "fake-server.jar")
          };
        }
      } as any
    );
    await writeFile(join(root, "fake-server.jar"), "stub", "utf8");

    await assert.rejects(
      () => service.getRegistryData({ version }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          ERROR_CODES.REGISTRY_GENERATION_FAILED
        );
        assert.match(
          String((error as { message?: string }).message),
          /invalid json|invalid structure|failed to parse/i
        );
        return true;
      }
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});
