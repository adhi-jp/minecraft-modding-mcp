import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultDownloadPath, downloadToCache } from "../src/repo-downloader.ts";

test("downloadToCache rejects non-http schemes", async () => {
  await assert.rejects(
    () => downloadToCache("ftp://example.com/file.jar", "/tmp/ignored.jar"),
    /Unsupported scheme/
  );
});

test("downloadToCache retries 429 and then succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-retry-"));
  const destination = join(root, "file.jar");
  let calls = 0;

  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(Buffer.from("jar-bytes"), {
      status: 200,
      headers: {
        etag: "etag-1",
        "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT"
      }
    });
  }) as typeof fetch;

  const result = await downloadToCache("https://repo.example.com/a.jar", destination, {
    retries: 1,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.path, destination);
  assert.equal(result.etag, "etag-1");
  const bytes = await readFile(destination, "utf8");
  assert.equal(bytes, "jar-bytes");
});

test("downloadToCache returns not-found metadata for 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-404-"));
  const destination = join(root, "missing.jar");
  const fetchFn: typeof fetch = (async () => new Response("", { status: 404 })) as typeof fetch;

  const result = await downloadToCache("https://repo.example.com/missing.jar", destination, {
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
});

test("defaultDownloadPath is deterministic for the same URL", () => {
  const left = defaultDownloadPath("/tmp/cache", "https://repo.example.com/a.jar");
  const right = defaultDownloadPath("/tmp/cache", "https://repo.example.com/a.jar");
  assert.equal(left, right);
});
