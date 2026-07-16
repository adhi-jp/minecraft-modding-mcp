import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { RegistryService } from "../../src/registry-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

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

// A fake `java` body that writes a minimal valid registries.json into the
// `--output <dir>/reports/` location, mimicking a successful data generation run.
const REGISTRY_GEN_JAVA = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const args = process.argv.slice(2);",
  'const outputIndex = args.lastIndexOf("--output");',
  "const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : process.cwd();",
  'const registryPath = path.join(outputDir, "reports", "registries.json");',
  'fs.mkdirSync(path.dirname(registryPath), { recursive: true });',
  'fs.writeFileSync(registryPath, JSON.stringify({ "minecraft:block": { entries: { "minecraft:stone": { protocol_id: 1 } } } }));'
].join("\n");

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

test("RegistryService treats a cached registry value missing entries as corrupt and regenerates", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-service-no-entries-"));
  const config = buildTestConfig(root);
  const version = "1.20.1";
  const registryDir = join(config.cacheDir, "registries", version);
  const staleRegistryPath = join(registryDir, "registries.json");
  await mkdir(registryDir, { recursive: true });
  // Valid JSON object, but the registry value has no `entries` object. Previously
  // this slipped past validation and later threw a raw TypeError on .entries.
  await writeFile(staleRegistryPath, JSON.stringify({ "minecraft:block": { default: "minecraft:air" } }), "utf8");

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
          return { version: requestedVersion, jarPath: join(root, "fake-server.jar") };
        }
      } as any
    );
    await writeFile(join(root, "fake-server.jar"), "stub", "utf8");

    const result = await service.getRegistryData({ version });

    assert.deepEqual(result.registries, ["minecraft:block"]);
    assert.equal(result.entryCount, 1);
    assert.match(result.warnings.join("\n"), /corrupt cached registry snapshot/i);
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

test("RegistryService supports summary-only and entry-capped registry responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-service-compact-"));
  const config = buildTestConfig(root);
  const version = "1.21.1";
  const registryDir = join(config.cacheDir, "registries", version);
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, "registries.json"),
    JSON.stringify({
      "minecraft:block": {
        default: "minecraft:stone",
        entries: {
          "minecraft:dirt": { protocol_id: 2 },
          "minecraft:stone": { protocol_id: 1 },
          "minecraft:grass_block": { protocol_id: 3 }
        }
      },
      "minecraft:item": {
        entries: {
          "minecraft:apple": { protocol_id: 10 },
          "minecraft:stick": { protocol_id: 11 }
        }
      }
    }),
    "utf8"
  );

  const service = new RegistryService(config, {} as never);

  const summaryOnly = await service.getRegistryData({
    version,
    includeData: false
  } as never) as unknown as {
    data?: unknown;
    registries?: string[];
    entryCount: number;
    returnedEntryCount?: number;
    registryEntryCounts?: Record<string, number>;
  };

  assert.equal(summaryOnly.data, undefined);
  assert.deepEqual(summaryOnly.registries, ["minecraft:block", "minecraft:item"]);
  assert.equal(summaryOnly.entryCount, 5);
  assert.equal(summaryOnly.returnedEntryCount, 0);
  assert.deepEqual(summaryOnly.registryEntryCounts, {
    "minecraft:block": 3,
    "minecraft:item": 2
  });

  const capped = await service.getRegistryData({
    version,
    maxEntriesPerRegistry: 1
  } as never) as unknown as {
    data: Record<string, { entries: Record<string, { protocol_id: number }> }>;
    entryCount: number;
    returnedEntryCount?: number;
    dataTruncated?: boolean;
  };

  assert.equal(capped.entryCount, 5);
  assert.equal(capped.returnedEntryCount, 2);
  assert.equal(capped.dataTruncated, true);
  assert.equal(Object.keys(capped.data["minecraft:block"]!.entries).length, 1);
  assert.equal(Object.keys(capped.data["minecraft:item"]!.entries).length, 1);

  const singleRegistry = await service.getRegistryData({
    version,
    registry: "block",
    maxEntriesPerRegistry: 1
  } as never) as unknown as {
    data: { default?: string; entries: Record<string, { protocol_id: number }> };
    entryCount: number;
    returnedEntryCount?: number;
    dataTruncated?: boolean;
  };

  assert.equal(singleRegistry.entryCount, 3);
  assert.equal(singleRegistry.returnedEntryCount, 1);
  assert.equal(singleRegistry.dataTruncated, true);
  assert.equal(singleRegistry.data.default, "minecraft:stone");
  assert.equal(Object.keys(singleRegistry.data.entries).length, 1);
});

test("RegistryService dedups concurrent loads of the same version into one generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-service-inflight-"));
  const config = buildTestConfig(root);
  const version = "1.20.1";

  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  await installFakeJava(binDir, REGISTRY_GEN_JAVA);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;

  try {
    let resolveServerJarCalls = 0;
    const service = new RegistryService(
      config,
      {
        async resolveServerJar(requestedVersion: string) {
          resolveServerJarCalls += 1;
          return { version: requestedVersion, jarPath: join(root, "fake-server.jar") };
        }
      } as any
    );
    await writeFile(join(root, "fake-server.jar"), "stub", "utf8");

    // Two concurrent callers must share a single in-flight load (loadLocks),
    // so the underlying server jar is resolved (and data generated) only once.
    const [first, second] = await Promise.all([
      service.getRegistryData({ version }),
      service.getRegistryData({ version })
    ]);

    assert.equal(resolveServerJarCalls, 1);
    assert.deepEqual(first.registries, ["minecraft:block"]);
    assert.deepEqual(second.registries, ["minecraft:block"]);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test("RegistryService evicts the coldest version once the in-memory cache bound is exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-service-lru-"));
  const config = buildTestConfig(root);

  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  await installFakeJava(binDir, REGISTRY_GEN_JAVA);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;

  try {
    const resolveCalls = new Map<string, number>();
    const service = new RegistryService(
      config,
      {
        async resolveServerJar(requestedVersion: string) {
          resolveCalls.set(requestedVersion, (resolveCalls.get(requestedVersion) ?? 0) + 1);
          return { version: requestedVersion, jarPath: join(root, "fake-server.jar") };
        }
      } as any
    );
    await writeFile(join(root, "fake-server.jar"), "stub", "utf8");

    // The registryCache caps at 8 entries; loading 9 distinct versions evicts
    // the coldest (first-inserted) one.
    const versions = Array.from({ length: 9 }, (_, i) => `9.0.${i}`);
    for (const version of versions) {
      await service.getRegistryData({ version });
    }
    for (const version of versions) {
      assert.equal(resolveCalls.get(version), 1, `first load generates ${version} once`);
    }

    const coldVersion = versions[0]!;
    const hotVersion = versions[versions.length - 1]!;

    // Remove the on-disk snapshots so a cache miss is forced to regenerate
    // (which calls resolveServerJar again). This distinguishes an in-memory
    // cache hit from a miss.
    await rm(join(config.cacheDir, "registries", coldVersion), { recursive: true, force: true });
    await rm(join(config.cacheDir, "registries", hotVersion), { recursive: true, force: true });

    // The hottest version is still cached in memory: no regeneration despite the
    // deleted disk snapshot.
    await service.getRegistryData({ version: hotVersion });
    assert.equal(resolveCalls.get(hotVersion), 1, "hot version served from in-memory cache");

    // The coldest version was evicted: with no cache entry and no disk snapshot,
    // it must regenerate.
    await service.getRegistryData({ version: coldVersion });
    assert.equal(resolveCalls.get(coldVersion), 2, "cold version was evicted and regenerated");
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});
