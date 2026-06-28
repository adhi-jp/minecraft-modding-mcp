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

test("downloadToCache retries a 503 and then succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-5xx-"));
  const destination = join(root, "file.jar");
  let calls = 0;

  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("", { status: 503 });
    }
    return new Response(Buffer.from("jar-bytes"), {
      status: 200,
      headers: { etag: "etag-5xx" }
    });
  }) as typeof fetch;

  const result = await downloadToCache("https://repo.example.com/a.jar", destination, {
    retries: 1,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.etag, "etag-5xx");
  assert.equal(await readFile(destination, "utf8"), "jar-bytes");
});

test("downloadToCache gives up with ok:false after exhausting retries on a persistent 503", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-5xx-exhaust-"));
  const destination = join(root, "file.jar");
  let calls = 0;

  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    return new Response("", { status: 503 });
  }) as typeof fetch;

  const result = await downloadToCache("https://repo.example.com/a.jar", destination, {
    retries: 1,
    timeoutMs: 2_000,
    fetchFn
  });

  // initial attempt + one retry, then give up rather than loop forever
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
});

test("downloadToCache returns metadata without retrying on a non-retryable 403", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-403-"));
  const destination = join(root, "file.jar");
  let calls = 0;

  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    return new Response("", {
      status: 403,
      headers: {
        etag: "etag-403",
        "last-modified": "Tue, 02 Jan 2024 00:00:00 GMT",
        "content-length": "123"
      }
    });
  }) as typeof fetch;

  const result = await downloadToCache("https://repo.example.com/secret.jar", destination, {
    retries: 3,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.etag, "etag-403");
  assert.equal(result.lastModified, "Tue, 02 Jan 2024 00:00:00 GMT");
  assert.equal(result.contentLength, 123);
});

test("downloadToCache honors a positive retry-after header delay", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-retry-after-"));
  const destination = join(root, "file.jar");
  let calls = 0;

  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("", { status: 429, headers: { "retry-after": "1" } });
    }
    return new Response(Buffer.from("ok-bytes"), { status: 200 });
  }) as typeof fetch;

  const startedAt = Date.now();
  const result = await downloadToCache("https://repo.example.com/a.jar", destination, {
    retries: 1,
    timeoutMs: 5_000,
    fetchFn
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  // A 1s retry-after must dominate the ~200ms exponential backoff, proving the
  // positive retry-after was honored rather than the default delay.
  assert.ok(elapsed >= 900, `expected >= ~1s retry-after delay, got ${elapsed}ms`);
});

test("downloadToCache rethrows a network error once retries are exhausted", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-neterr-"));
  const destination = join(root, "file.jar");
  let calls = 0;

  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    throw new Error("network down");
  }) as typeof fetch;

  await assert.rejects(
    () =>
      downloadToCache("https://repo.example.com/a.jar", destination, {
        retries: 0,
        timeoutMs: 2_000,
        fetchFn
      }),
    /network down/
  );
  assert.equal(calls, 1);
});
