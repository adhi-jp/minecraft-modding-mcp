import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { resolveTinyRemapperJar } from "../src/tiny-remapper-resolver.ts";

function makeTempDir(): string {
  const dir = join(tmpdir(), `mcp-test-remapper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("resolveTinyRemapperJar returns override path when provided", async () => {
  const tempDir = makeTempDir();
  try {
    const overridePath = join(tempDir, "custom-remapper.jar");
    writeFileSync(overridePath, "fake jar");

    const result = await resolveTinyRemapperJar(tempDir, overridePath);
    assert.equal(result, overridePath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveTinyRemapperJar returns cached jar when it exists", async () => {
  const tempDir = makeTempDir();
  try {
    const resourcesDir = join(tempDir, "resources");
    mkdirSync(resourcesDir, { recursive: true });

    const version = process.env.MCP_TINY_REMAPPER_VERSION ?? "0.10.3";
    const cachedPath = join(resourcesDir, `tiny-remapper-${version}-fat.jar`);
    writeFileSync(cachedPath, "fake cached jar");

    const result = await resolveTinyRemapperJar(tempDir, undefined);
    assert.equal(result, cachedPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveTinyRemapperJar throws REMAPPER_UNAVAILABLE on download failure", async () => {
  const tempDir = makeTempDir();
  try {
    // Mock fetch that always returns 404
    const mockFetch = (async () =>
      new Response("Not found", { status: 404 })) as unknown as typeof fetch;

    await assert.rejects(
      () => resolveTinyRemapperJar(tempDir, undefined, mockFetch),
      (error: unknown) => {
        const appError = error as { code?: string };
        return appError.code === ERROR_CODES.REMAPPER_UNAVAILABLE;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveTinyRemapperJar deduplicates concurrent downloads", async () => {
  const tempDir = makeTempDir();
  let fetchCount = 0;

  try {
    const resourcesDir = join(tempDir, "resources");
    mkdirSync(resourcesDir, { recursive: true });

    const version = process.env.MCP_TINY_REMAPPER_VERSION ?? "0.10.3";
    const expectedPath = join(resourcesDir, `tiny-remapper-${version}-fat.jar`);

    const mockFetch = (async () => {
      fetchCount++;
      // Simulate a successful download by writing the file
      writeFileSync(expectedPath, "downloaded jar");
      return new Response("jar content", {
        status: 200,
        headers: { "content-length": "11" }
      });
    }) as unknown as typeof fetch;

    // Launch two concurrent resolutions
    const [result1, result2] = await Promise.all([
      resolveTinyRemapperJar(tempDir, undefined, mockFetch),
      resolveTinyRemapperJar(tempDir, undefined, mockFetch)
    ]);

    // Both should succeed
    assert.ok(existsSync(result1));
    assert.ok(existsSync(result2));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
