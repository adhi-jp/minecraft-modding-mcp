import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveVineflowerJar } from "../src/vineflower-resolver.ts";

test("resolveVineflowerJar returns override path directly", async () => {
  const result = await resolveVineflowerJar("/tmp/cache", "/custom/vineflower.jar");
  assert.equal(result, "/custom/vineflower.jar");
});

test("resolveVineflowerJar returns cached jar without download", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-cached-"));
  const resourcesDir = join(root, "resources");
  await mkdir(resourcesDir, { recursive: true });
  const cachedPath = join(resourcesDir, "vineflower-1.11.2.jar");
  await writeFile(cachedPath, "fake-vineflower");

  const result = await resolveVineflowerJar(root, undefined);
  assert.equal(result, cachedPath);
});

test("resolveVineflowerJar downloads when not cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-download-"));
  const jarBytes = Buffer.from("vineflower-binary");

  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("vineflower")) {
      return new Response(jarBytes, { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const result = await resolveVineflowerJar(root, undefined, fetchFn);
  assert.ok(existsSync(result));
  assert.ok(result.includes("vineflower-1.11.2.jar"));
});

test("resolveVineflowerJar throws DECOMPILER_UNAVAILABLE on download failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-fail-"));

  const fetchFn = (async () => {
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    await resolveVineflowerJar(root, undefined, fetchFn);
    assert.fail("Expected error");
  } catch (err: any) {
    assert.equal(err.code, "ERR_DECOMPILER_UNAVAILABLE");
    assert.match(err.message, /Failed to download Vineflower/);
  }
});

test("resolveVineflowerJar concurrent calls trigger only one download", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-concurrent-"));
  let downloadCount = 0;

  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("vineflower")) {
      downloadCount += 1;
      return new Response(Buffer.from("vineflower-binary"), { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const [a, b] = await Promise.all([
    resolveVineflowerJar(root, undefined, fetchFn),
    resolveVineflowerJar(root, undefined, fetchFn)
  ]);

  assert.equal(a, b);
  assert.equal(downloadCount, 1);
});

test("resolveVineflowerJar does not share in-flight download across cache directories", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "vf-concurrent-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "vf-concurrent-b-"));
  let downloadCount = 0;
  let releaseFetch: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("vineflower")) {
      downloadCount += 1;
      await gate;
      return new Response(Buffer.from("vineflower-binary"), { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const promiseA = resolveVineflowerJar(rootA, undefined, fetchFn);
  const promiseB = resolveVineflowerJar(rootB, undefined, fetchFn);
  releaseFetch?.();

  const [pathA, pathB] = await Promise.all([promiseA, promiseB]);
  assert.notEqual(pathA, pathB);
  assert.ok(pathA.startsWith(rootA));
  assert.ok(pathB.startsWith(rootB));
  assert.equal(downloadCount, 2);
});
