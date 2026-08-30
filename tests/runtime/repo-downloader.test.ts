import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultDownloadPath,
  downloadSidecarPath,
  downloadToCache,
  isDownloadSidecarPath,
  resolveCachedDownload
} from "../../src/repo-downloader.ts";

function sha256Of(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The sidecar schema this build writes and is willing to read. Pinned here so a
 * fixture that hand-writes a record cannot silently drift out of the schema the
 * reader accepts - and so the deliberately-foreign-version fixtures below stay
 * obviously foreign.
 */
const CURRENT_SIDECAR_VERSION = 2;

/**
 * The conditional validators in `headers`, matched the way HTTP matches header
 * names: case-insensitively.
 *
 * Asserting on one exact spelling is how a validator sneaks through - a caller
 * writes `if-none-match`, the assertion looks for `If-None-Match`, and a request
 * that is still conditional reads as unconditional. The full RFC 9110 set is
 * listed here rather than just the two this module sends, because the property
 * under test is "no validator from any source", not "not the one we know about".
 */
function conditionalHeadersIn(headers: Record<string, string>): Record<string, string> {
  const conditional = new Set([
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
    "if-range"
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => conditional.has(name.toLowerCase()))
  );
}

/** A fetch stub that fails the test if it is ever called. */
function forbiddenFetch(seen: { calls: number }): typeof fetch {
  return (async () => {
    seen.calls += 1;
    return new Response("network-should-not-be-reached", { status: 200 });
  }) as typeof fetch;
}

/**
 * Write the identity record `resolveCachedDownload` would have left beside
 * `destination`, stamped with the file's real size and mtime.
 *
 * A record binds an identity to one specific set of bytes, and it is the size
 * *and* the mtime that pin it to them. A fixture has to stamp it the same way
 * the implementation does, or it is simply a record the reader is right to
 * reject - which would make the fixture prove nothing.
 */
async function writeSidecarFor(
  destination: string,
  record: {
    url: string;
    contentSha256: string;
    contentLength?: number;
    etag?: string;
    lastModified?: string;
  }
): Promise<void> {
  const stats = await stat(destination);
  await writeFile(
    downloadSidecarPath(destination),
    JSON.stringify({
      version: CURRENT_SIDECAR_VERSION,
      url: record.url,
      contentSha256: record.contentSha256,
      contentLength: record.contentLength ?? stats.size,
      contentMtimeMs: stats.mtimeMs,
      ...(record.etag === undefined ? {} : { etag: record.etag }),
      ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified })
    })
  );
}

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

  // performance.now() is monotonic. Date.now() is the wall clock, which jumps
  // backwards under load on WSL2 and made this assertion read ~100ms for a sleep
  // that genuinely took a second.
  const startedAt = performance.now();
  const result = await downloadToCache("https://repo.example.com/a.jar", destination, {
    retries: 1,
    timeoutMs: 5_000,
    fetchFn
  });
  const elapsed = performance.now() - startedAt;

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  // A 1s retry-after must dominate the ~200ms exponential backoff, proving the
  // positive retry-after was honored rather than the default delay.
  assert.ok(elapsed >= 900, `expected >= ~1s retry-after delay, got ${elapsed}ms`);
});

test("downloadToCache caps an unreasonable retry-after instead of honoring it whole", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const root = await mkdtemp(join(tmpdir(), "downloader-retry-after-cap-"));
  const destination = join(root, "file.jar");
  let calls = 0;

  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      // Far past any reasonable retry pace - proves the header is capped,
      // not trusted whole, per the "Retry-After can suspend a tool call far
      // beyond its configured timeout" review finding.
      return new Response("", { status: 429, headers: { "retry-after": "10000" } });
    }
    return new Response(Buffer.from("ok-bytes"), { status: 200 });
  }) as typeof fetch;

  const resultPromise = downloadToCache("https://repo.example.com/a.jar", destination, {
    retries: 1,
    timeoutMs: 60_000,
    fetchFn
  });

  // Real setImmediate (not mocked) flushes the microtasks between the first
  // fetch resolving and the retry's `sleep()` actually scheduling its
  // (mocked) setTimeout, so the tick below lands after that timer exists.
  await new Promise((resolve) => setImmediate(resolve));

  // Pinned to the production cap: a value this test never reads from source,
  // so it fails loudly if the cap ever regresses back toward the raw header.
  const MAX_RETRY_AFTER_MS = 30_000;
  t.mock.timers.tick(MAX_RETRY_AFTER_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "must not retry before the capped delay elapses");

  t.mock.timers.tick(2);
  const result = await resultPromise;

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
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

test("resolveCachedDownload(immutable) adopts an already-cached jar that has no sidecar without touching the network", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-immutable-legacy-"));
  const destination = join(root, "legacy.jar");
  await writeFile(destination, "legacy-cached-bytes");
  const seen = { calls: 0 };

  const result = await resolveCachedDownload("https://repo.example.com/legacy.jar", destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0, "an immutable cache hit must never reach the network");
  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "hit");
  assert.equal(result.path, destination);
  assert.equal(result.contentLength, "legacy-cached-bytes".length);
  assert.equal(result.contentSha256, sha256Of("legacy-cached-bytes"));

  // The migration path must leave a sidecar behind so the next hit is free.
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.url, "https://repo.example.com/legacy.jar");
  assert.equal(sidecar.contentSha256, sha256Of("legacy-cached-bytes"));
  assert.equal(sidecar.contentLength, "legacy-cached-bytes".length);
});

test("resolveCachedDownload(immutable) serves the digest from a valid sidecar without rehashing or fetching", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-immutable-sidecar-"));
  const destination = join(root, "pinned.jar");
  const url = "https://repo.example.com/pinned.jar";
  await writeFile(destination, "pinned");
  // The record is a truthful description of the bytes beside it - anything else
  // would be a record the reader is supposed to reject. What proves the hit was
  // free is the *freshness* data: only the record carries `etag`, so a call that
  // discarded the record and re-derived the digest could not return one, and
  // would have overwritten the record with an etag-less one on the way out.
  await writeSidecarFor(destination, {
    url,
    contentSha256: sha256Of("pinned"),
    etag: "etag-pinned"
  });
  const recordBeforeHit = await readFile(downloadSidecarPath(destination), "utf8");
  const seen = { calls: 0 };

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0, "an immutable cache hit must never reach the network");
  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "hit");
  assert.equal(result.contentSha256, sha256Of("pinned"));
  assert.equal(result.contentLength, "pinned".length);
  assert.equal(result.etag, "etag-pinned", "a rehashing hit could not have produced this");
  assert.equal(
    await readFile(downloadSidecarPath(destination), "utf8"),
    recordBeforeHit,
    "a hit that re-derived the digest would have rewritten the record"
  );
});

test("resolveCachedDownload(immutable) treats a corrupt sidecar as absent and recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-immutable-corrupt-"));
  const destination = join(root, "corrupt-meta.jar");
  const url = "https://repo.example.com/corrupt-meta.jar";
  await writeFile(destination, "still-good-bytes");
  await writeFile(downloadSidecarPath(destination), "{ this is not json");
  const seen = { calls: 0 };

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "hit");
  assert.equal(result.contentSha256, sha256Of("still-good-bytes"));

  const rewritten = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(rewritten.contentSha256, sha256Of("still-good-bytes"));
});

test("resolveCachedDownload(revalidate) sends If-None-Match and keeps the cached bytes on 304", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-revalidate-304-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await writeFile(destination, "snapshot-bytes-v1");
  await writeSidecarFor(destination, {
    url,
    contentSha256: sha256Of("snapshot-bytes-v1"),
    etag: "etag-v1",
    lastModified: "Mon, 01 Jan 2024 00:00:00 GMT"
  });

  const sentHeaders: Array<Record<string, string>> = [];
  const fetchFn: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    sentHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    return new Response(null, { status: 304, headers: { etag: "etag-v1" } });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(sentHeaders.length, 1);
  assert.equal(sentHeaders[0]["If-None-Match"], "etag-v1");
  assert.equal(sentHeaders[0]["If-Modified-Since"], "Mon, 01 Jan 2024 00:00:00 GMT");
  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "revalidated");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v1"));
  assert.equal(await readFile(destination, "utf8"), "snapshot-bytes-v1");
});

test("resolveCachedDownload(revalidate) re-derives the digest instead of trusting a sidecar the bytes on disk no longer match", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-revalidate-race-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await writeFile(destination, "snapshot-bytes-v1");
  await writeSidecarFor(destination, {
    url,
    contentSha256: sha256Of("snapshot-bytes-v1"),
    etag: "etag-v1",
    lastModified: "Mon, 01 Jan 2024 00:00:00 GMT"
  });

  // Simulates a concurrent resolve of the same mutable coordinate landing
  // its own (newer) bytes while this request's conditional check is still in
  // flight - this call's own sidecar read happened before this write.
  const fetchFn: typeof fetch = (async () => {
    await writeFile(destination, "snapshot-bytes-v2-concurrent-write");
    return new Response(null, { status: 304, headers: { etag: "etag-v1" } });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "revalidated");
  // Must describe the bytes actually on disk (v2), not the pre-request
  // sidecar snapshot (v1) - a stale-but-trusted digest would report v1's hash
  // here while the file the caller reads back holds v2's bytes.
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v2-concurrent-write"));
  assert.notEqual(result.contentSha256, sha256Of("snapshot-bytes-v1"));
});

test("resolveCachedDownload(revalidate) replaces the bytes and the digest on a 200", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-revalidate-200-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await writeFile(destination, "snapshot-bytes-v1");
  await writeSidecarFor(destination, {
    url,
    contentSha256: sha256Of("snapshot-bytes-v1"),
    etag: "etag-v1"
  });

  const fetchFn: typeof fetch = (async () =>
    new Response(Buffer.from("snapshot-bytes-v2"), {
      status: 200,
      headers: { etag: "etag-v2" }
    })) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "downloaded");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v2"));
  assert.equal(result.etag, "etag-v2");
  assert.equal(await readFile(destination, "utf8"), "snapshot-bytes-v2");

  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.contentSha256, sha256Of("snapshot-bytes-v2"));
  assert.equal(sidecar.etag, "etag-v2");
});

test("resolveCachedDownload returns the same result shape whether the bytes came from the network or the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-uniform-shape-"));
  const destination = join(root, "uniform.jar");
  const url = "https://repo.example.com/uniform.jar";

  let calls = 0;
  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    return new Response(Buffer.from("uniform-bytes"), {
      status: 200,
      headers: { etag: "etag-uniform" }
    });
  }) as typeof fetch;

  const downloaded = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });
  const cached = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 1);
  assert.equal(downloaded.cacheStatus, "downloaded");
  assert.equal(cached.cacheStatus, "hit");

  for (const field of ["path", "contentLength", "contentSha256"] as const) {
    assert.notEqual(downloaded[field], undefined, `download result must carry ${field}`);
    assert.notEqual(cached[field], undefined, `cache-hit result must carry ${field}`);
    assert.deepEqual(cached[field], downloaded[field], `${field} must not drift between legs`);
  }
});

// ---------------------------------------------------------------------------
// Stale-if-error, and the line it must not cross.
//
// A revalidation that fails *transiently* keeps serving the cached bytes on
// purpose: they are a byte-exact copy of what the repository handed out before,
// and losing them to an outage would be worse than using them. The request
// throwing, a 5xx, a 429 - all of those land on that reuse, reported as
// `"stale"` rather than as a clean `"hit"`, because nothing confirmed these
// bytes on this call and a caller (or a freshness report) is entitled to know.
//
// A *definitive* rejection is the opposite case. When the repository answers
// 403/404/410 it is telling us, authoritatively and repeatably, that it will not
// serve this artifact. Answering that with the cached copy hides the withdrawal
// for as long as the file survives, and - worse - it looks like success to the
// repository loop in src/source-resolver.ts, which then never tries the next
// repository that may well have the artifact. Those statuses must surface as an
// ordinary failure so failover can happen.
// ---------------------------------------------------------------------------

/** Seed a cached jar plus the valid sidecar a previous download would have left. */
async function seedCachedDownload(
  destination: string,
  url: string,
  bytes: string,
  freshness: { etag?: string; lastModified?: string } = {}
): Promise<void> {
  await writeFile(destination, bytes);
  await writeSidecarFor(destination, { url, contentSha256: sha256Of(bytes), ...freshness });
}

test("resolveCachedDownload(revalidate) serves the cached bytes as stale when the revalidation request throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-throw-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  const fetchFn: typeof fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND repo.example.com");
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "stale", "an unconfirmed reuse must not look like a clean hit");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v1"));
  assert.equal(await readFile(destination, "utf8"), "snapshot-bytes-v1");
  // The identity record must survive the failed round trip: an outage is no
  // reason to make the next call re-hash the jar.
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.contentSha256, sha256Of("snapshot-bytes-v1"));
  assert.equal(sidecar.etag, "etag-v1");
});

test("resolveCachedDownload(revalidate) re-derives the digest instead of trusting a stale sidecar when the revalidation request throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-throw-race-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  // Simulates a concurrent resolve of the same mutable coordinate landing its
  // own (newer) bytes while this request is in flight - this call's own
  // sidecar read happened before this write, so serving "the cached bytes"
  // must describe what is actually on disk now, not the pre-request identity.
  const fetchFn: typeof fetch = (async () => {
    await writeFile(destination, "snapshot-bytes-v2-concurrent-write");
    throw new Error("getaddrinfo ENOTFOUND repo.example.com");
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v2-concurrent-write"));
  assert.notEqual(result.contentSha256, sha256Of("snapshot-bytes-v1"));
  // The stale-if-error path must not overwrite the concurrent winner's sidecar
  // with the pre-request (now wrong) identity it retired.
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.contentSha256, sha256Of("snapshot-bytes-v2-concurrent-write"));
});

test("resolveCachedDownload(revalidate) surfaces the original error instead of a stale-but-vanished digest when a concurrent resolve deletes the bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-throw-vanish-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  const originalError = new Error("getaddrinfo ENOTFOUND repo.example.com");
  const fetchFn: typeof fetch = (async () => {
    // Simulates a concurrent eviction (e.g. discardCachedDownload) removing
    // the file this call's sidecar was read against.
    await rm(destination);
    throw originalError;
  }) as typeof fetch;

  await assert.rejects(
    resolveCachedDownload(url, destination, {
      freshness: "revalidate",
      retries: 0,
      timeoutMs: 2_000,
      fetchFn
    }),
    (error: Error) => error === originalError
  );
});

test("resolveCachedDownload(revalidate) serves the cached bytes as stale when the repository answers 5xx", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-5xx-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  const fetchFn: typeof fetch = (async () => new Response("upstream exploded", { status: 503 })) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v1"));
  assert.equal(await readFile(destination, "utf8"), "snapshot-bytes-v1");
});

// NOTE: this title describes the behaviour this test used to pin and no longer
// does - a withdrawn artifact is now refused, not served stale. The title is
// deliberately left alone here because renaming it is outside this change's
// remit; it wants to become "...refuses to serve the cached bytes when the
// artifact has been withdrawn".
test("resolveCachedDownload(revalidate) serves the cached bytes as stale when the artifact has been withdrawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-404-"));
  const destination = join(root, "withdrawn.jar");
  const url = "https://repo.example.com/withdrawn.jar";
  await seedCachedDownload(destination, url, "withdrawn-bytes", { etag: "etag-withdrawn" });

  const fetchFn: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  // A withdrawn artifact is the sharpest case, and it cuts the other way: the
  // repository is emphatically telling us this is gone, and answering that with
  // the cached copy makes an artifact that was pulled from repository A stay
  // resolvable forever - and, because the caller reads it as success, stops the
  // repository loop from ever asking repository B, which may still publish it.
  assert.equal(result.ok, false, "a definitive rejection must not be laundered into a stale success");
  assert.equal(result.statusCode, 404);

  // The bytes stay put. They are no longer allowed to answer for this url, but
  // deleting the only copy on disk is not this module's call to make - and the
  // identity record must survive with them, so a later revalidation that finds
  // the artifact back can still send its validators instead of re-hashing.
  assert.equal(await readFile(destination, "utf8"), "withdrawn-bytes");
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.contentSha256, sha256Of("withdrawn-bytes"));
  assert.equal(sidecar.etag, "etag-withdrawn");
});

test("resolveCachedDownload(revalidate) refuses the stale fallback for every definitive repository rejection", async () => {
  for (const statusCode of [403, 404, 410]) {
    const root = await mkdtemp(join(tmpdir(), `downloader-definitive-${statusCode}-`));
    const destination = join(root, "gone.jar");
    const url = "https://repo.example.com/gone.jar";
    await seedCachedDownload(destination, url, "gone-bytes", { etag: "etag-gone" });

    const fetchFn: typeof fetch = (async () =>
      new Response("refused", { status: statusCode })) as typeof fetch;

    const result = await resolveCachedDownload(url, destination, {
      freshness: "revalidate",
      // Retries must not paper over it either: none of these are retryable.
      retries: 2,
      timeoutMs: 2_000,
      fetchFn
    });

    assert.equal(result.ok, false, `${statusCode} must surface as a failure the caller can fail over on`);
    assert.equal(result.statusCode, statusCode);
    assert.equal(existsSync(destination), true, `${statusCode} must not delete the cached bytes`);
  }
});

test("resolveCachedDownload(revalidate) serves the cached bytes as stale when the repository answers 429", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-429-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  // Rate limiting is the definition of transient: the artifact is fine, we are
  // simply being asked to come back later. Dropping bytes we already hold over
  // it would be a self-inflicted outage.
  const fetchFn: typeof fetch = (async () =>
    new Response("slow down", { status: 429, headers: { "retry-after": "0" } })) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v1"));
});

test("resolveCachedDownload surfaces the original network error when the stale fallback cannot read the cached bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-vanished-"));
  const destination = join(root, "racing.jar");
  const url = "https://repo.example.com/racing.jar";
  // No sidecar: the fallback has to hash the file, which is what fails below.
  await writeFile(destination, "bytes-about-to-vanish");

  const fetchFn: typeof fetch = (async () => {
    // A concurrent prune between the existence check and the fallback read.
    await rm(destination);
    throw new Error("network down");
  }) as typeof fetch;

  await assert.rejects(
    () =>
      resolveCachedDownload(url, destination, {
        freshness: "revalidate",
        retries: 0,
        timeoutMs: 2_000,
        fetchFn
      }),
    /network down/,
    "a second failure inside the fallback must not replace the reason the call failed"
  );
});

test("resolveCachedDownload(revalidate) retires the stale sidecar before the replacement bytes land", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-sidecar-ordering-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  let sidecarPresentDuringTransfer: boolean | undefined;
  const fetchFn: typeof fetch = (async () => {
    // Observed at the moment the transfer starts, i.e. inside the window where
    // a kill would otherwise leave a record describing bytes that are gone.
    sidecarPresentDuringTransfer = existsSync(downloadSidecarPath(destination));
    return new Response(Buffer.from("snapshot-bytes-v2"), { status: 200, headers: { etag: "etag-v2" } });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(
    sidecarPresentDuringTransfer,
    false,
    "the record of the old bytes must be gone before the new bytes can replace them"
  );
  assert.equal(result.cacheStatus, "downloaded");
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.contentSha256, sha256Of("snapshot-bytes-v2"), "and the new record lands afterwards");
});

// ---------------------------------------------------------------------------
// Sidecar rejection rules. A record that may describe something other than the
// bytes beside it is worse than no record at all: it is trusted without a read.
// ---------------------------------------------------------------------------

test("resolveCachedDownload treats a sidecar whose recorded size no longer matches the file as absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-sidecar-size-"));
  const destination = join(root, "truncated.jar");
  const url = "https://repo.example.com/truncated.jar";
  await seedCachedDownload(destination, url, "full-length-bytes", { etag: "etag-full" });
  // Something outside this module replaced the bytes (an interrupted copy, a
  // manual edit). The recorded digest now describes a file that is not there.
  await writeFile(destination, "truncated");
  const seen = { calls: 0 };

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0);
  assert.equal(result.ok, true);
  assert.equal(
    result.contentSha256,
    sha256Of("truncated"),
    "the digest must be re-derived from the bytes actually on disk"
  );
  assert.equal(result.contentLength, "truncated".length);
  assert.equal(result.etag, undefined, "a rejected record carries no freshness data forward either");

  const rewritten = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(rewritten.contentSha256, sha256Of("truncated"));
  assert.equal(rewritten.contentLength, "truncated".length);
});

test("resolveCachedDownload treats a sidecar recorded for a different url as absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-sidecar-url-"));
  const destination = join(root, "shared-path.jar");
  const url = "https://repo.example.com/shared-path.jar";
  // Same path, different origin: a cache key collision or a rewritten repo list.
  await seedCachedDownload(destination, "https://mirror.example.com/shared-path.jar", "shared-bytes", {
    etag: "etag-mirror"
  });
  const seen = { calls: 0 };

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.contentSha256, sha256Of("shared-bytes"));
  assert.equal(result.etag, undefined, "a foreign url's validator must never be replayed for this url");

  const rewritten = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(rewritten.url, url, "the record is rebound to the url that owns this path");
});

test("resolveCachedDownload treats a sidecar written by another sidecar version as absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-sidecar-version-"));
  const destination = join(root, "future.jar");
  const url = "https://repo.example.com/future.jar";
  await writeFile(destination, "future-bytes");
  await writeFile(
    downloadSidecarPath(destination),
    JSON.stringify({
      version: 99,
      url,
      contentSha256: "digest-from-a-schema-this-build-does-not-know",
      contentLength: "future-bytes".length
    })
  );
  const seen = { calls: 0 };

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.contentSha256, sha256Of("future-bytes"));

  const rewritten = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(
    rewritten.version,
    CURRENT_SIDECAR_VERSION,
    "the record is rewritten in the schema this build understands"
  );
});

test("resolveCachedDownload re-derives the digest from a record written by an older sidecar schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-sidecar-legacy-"));
  const destination = join(root, "legacy-schema.jar");
  const url = "https://repo.example.com/legacy-schema.jar";
  await writeFile(destination, "legacy-schema-bytes");
  // A v1 record: url, digest and size, and nothing tying the digest to the bytes
  // currently on disk. Its digest is stale here precisely because that binding
  // did not exist - which is the whole reason the schema moved on. The upgrade
  // must degrade it to "absent" (re-hash), never read it as this file's identity.
  await writeFile(
    downloadSidecarPath(destination),
    JSON.stringify({
      version: 1,
      url,
      contentSha256: sha256Of("bytes-this-file-no-longer-holds"),
      contentLength: "legacy-schema-bytes".length
    })
  );
  const seen = { calls: 0 };

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0, "an unreadable record is a re-hash, not a re-download");
  assert.equal(result.ok, true);
  assert.equal(
    result.contentSha256,
    sha256Of("legacy-schema-bytes"),
    "an older record must never supply the identity of bytes it was not bound to"
  );

  const rewritten = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(rewritten.version, CURRENT_SIDECAR_VERSION);
  assert.equal(rewritten.contentSha256, sha256Of("legacy-schema-bytes"));
});

test("resolveCachedDownload treats a sidecar as absent once the file it describes has been rewritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-sidecar-mtime-"));
  const destination = join(root, "swapped.jar");
  const url = "https://repo.example.com/swapped.jar";
  await seedCachedDownload(destination, url, "aaaaaaaaaaaaaaaa", { etag: "etag-aaaa" });

  // The replacement a size cross-check alone cannot see: a different jar that
  // happens to be exactly as long as the one it displaced. Without an mtime in
  // the record the resolver keeps publishing the OLD digest as this file's
  // identity, so the artifactId describes content nobody will ever read.
  const stampBefore = (await stat(destination)).mtimeMs;
  await writeFile(destination, "bbbbbbbbbbbbbbbb");
  // A real replacement always moves mtime; pin it explicitly so a coarse
  // filesystem clock cannot turn this into a flaky test.
  await utimes(destination, new Date(), new Date(stampBefore + 2_000));
  const seen = { calls: 0 };

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: forbiddenFetch(seen)
  });

  assert.equal(seen.calls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.contentLength, "bbbbbbbbbbbbbbbb".length, "same length as the record claims");
  assert.equal(
    result.contentSha256,
    sha256Of("bbbbbbbbbbbbbbbb"),
    "the digest must be re-derived from the bytes actually on disk"
  );
  assert.equal(result.etag, undefined, "a rejected record carries no freshness data forward either");

  const rewritten = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(rewritten.contentSha256, sha256Of("bbbbbbbbbbbbbbbb"));
  assert.equal(
    rewritten.contentMtimeMs,
    (await stat(destination)).mtimeMs,
    "and the fresh record is bound to the file it just described"
  );
});

// ---------------------------------------------------------------------------
// Revalidation legs that only appear once the retry loop is involved, or once
// the validator is not a plain strong ETag.
// ---------------------------------------------------------------------------

test("resolveCachedDownload(revalidate) reuses the cached bytes on a 304 that arrives after a 503 retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-503-then-304-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  const sentHeaders: Array<Record<string, string>> = [];
  let calls = 0;
  const fetchFn: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    sentHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    if (calls === 1) {
      return new Response("try again", { status: 503, headers: { "retry-after": "0" } });
    }
    return new Response(null, { status: 304, headers: { etag: "etag-v1" } });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 2,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 2);
  assert.equal(
    sentHeaders[1]?.["If-None-Match"],
    "etag-v1",
    "the retry must still carry the conditional validators, or the retry re-downloads the jar"
  );
  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "revalidated", "a 304 is a confirmation no matter which attempt carried it");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v1"));
  assert.equal(await readFile(destination, "utf8"), "snapshot-bytes-v1");
});

test("resolveCachedDownload(revalidate) round-trips a weak ETag through the sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-weak-etag-"));
  const destination = join(root, "weak.jar");
  const url = "https://repo.example.com/weak.jar";

  const sentHeaders: Array<Record<string, string>> = [];
  let calls = 0;
  const fetchFn: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    sentHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    if (calls === 1) {
      return new Response(Buffer.from("weak-bytes"), {
        status: 200,
        headers: { etag: 'W/"weak-validator"' }
      });
    }
    return new Response(null, { status: 304, headers: { etag: 'W/"weak-validator"' } });
  }) as typeof fetch;

  const downloaded = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });
  assert.equal(downloaded.cacheStatus, "downloaded");
  assert.equal(downloaded.etag, 'W/"weak-validator"');

  const revalidated = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(
    sentHeaders[1]?.["If-None-Match"],
    'W/"weak-validator"',
    "the weak form must go back out verbatim; stripping W/ would make it a strong comparison"
  );
  assert.equal(revalidated.ok, true);
  assert.equal(revalidated.cacheStatus, "revalidated");
  assert.equal(revalidated.contentSha256, sha256Of("weak-bytes"));
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.etag, 'W/"weak-validator"');
});

// ---------------------------------------------------------------------------
// Empty artifacts. A zero-byte jar is not an artifact - it is a failed transfer
// that happened to answer 200 - and recording one under an immutable url would
// hand every later caller bytes that only fail when the decompiler opens them.
// ---------------------------------------------------------------------------

test("resolveCachedDownload refuses to cache a 200 that carried no body", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-empty-200-"));
  const destination = join(root, "empty.jar");
  const url = "https://repo.example.com/empty.jar";

  const fetchFn: typeof fetch = (async () =>
    new Response(null, { status: 200, headers: { etag: "etag-empty" } })) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, false, "an empty body is a failed transfer, not a cached artifact");
  assert.equal(result.contentLength, 0);
  assert.equal(existsSync(destination), false, "and it must not be left behind as a permanent cache entry");
  assert.equal(existsSync(downloadSidecarPath(destination)), false, "nor given an identity record");
});

test("resolveCachedDownload(immutable) re-downloads instead of serving a zero-byte cached file", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-empty-cached-"));
  const destination = join(root, "stale-empty.jar");
  const url = "https://repo.example.com/stale-empty.jar";
  // Left by an older build, an interrupted copy, or a full disk.
  await writeFile(destination, "");

  let calls = 0;
  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    return new Response(Buffer.from("real-bytes"), { status: 200 });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 1, "an empty file is not a cache hit, immutable url or not");
  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "downloaded");
  assert.equal(await readFile(destination, "utf8"), "real-bytes");
});

test("resolveCachedDownload(revalidate) serves the cached bytes as stale instead of destroying them when the repository answers 200 with no body", async () => {
  // Regression: `downloadToCache` used to rename the (empty) temp file onto
  // `destination` unconditionally for any `response.ok` status, before the
  // caller could ever learn the body was empty. That destroyed the previously
  // good cached bytes on disk, and only afterwards reported failure - unlike
  // every sibling failure leg (5xx/429/thrown-error/withdrawn-artifact), none
  // of which lose the cached copy.
  const root = await mkdtemp(join(tmpdir(), "downloader-stale-empty-body-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  const fetchFn: typeof fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, true, "a good cached copy beats failing outright on a transient empty response");
  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v1"));
  assert.equal(
    await readFile(destination, "utf8"),
    "snapshot-bytes-v1",
    "the previously cached bytes must survive an empty-body response, not be overwritten by it"
  );
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.contentSha256, sha256Of("snapshot-bytes-v1"));
});

// ---------------------------------------------------------------------------
// Bytes that disappear under a call already in flight. The downloads cache is
// shared, so a prune or a concurrent resolve of the same coordinate can delete
// or replace a file between the stat that found it and the read that describes
// it - on the cache hit, on the 304, and on the transfer's own bytes. None of it
// reaches the caller as a filesystem error: an entry that is not there is a
// cache miss and the answer to a miss is a transfer, and where there is nothing
// left to transfer into, the answer is an ordinary failure result.
//
// Bytes that are *there* and unreadable are the opposite case and are reported,
// not swallowed - the last test in this section pins that boundary.
// ---------------------------------------------------------------------------

test("resolveCachedDownload(immutable) answers vanished bytes with a transfer or a failure, whichever half of the read finds them gone", async () => {
  // --- The read half, on the cache hit. ---
  const root = await mkdtemp(join(tmpdir(), "downloader-hit-vanished-"));
  const destination = join(root, "vanishing.jar");
  const url = "https://repo.example.com/vanishing.jar";
  // No sidecar, so the immutable hit has to hash the file - and that hash is the
  // window a concurrent eviction lands in.
  await writeFile(destination, "bytes-about-to-vanish");

  let calls = 0;
  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    return new Response(Buffer.from("re-downloaded-bytes"), {
      status: 200,
      headers: { etag: "etag-fresh" }
    });
  }) as typeof fetch;

  // Stages the cross-process race deterministically: the resolver stats the file
  // synchronously and only opens its read stream on the next tick, so a deletion
  // queued here runs first and the *open* is the half that fails. A guard around
  // the stat alone would let this one through.
  process.nextTick(() => {
    rmSync(destination);
  });

  const result = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 1, "bytes that are gone are a cache miss, and a miss is answered by transferring");
  assert.equal(result.ok, true, "a raced eviction must not surface as a raw ENOENT the caller cannot act on");
  assert.equal(result.cacheStatus, "downloaded");
  assert.equal(result.contentSha256, sha256Of("re-downloaded-bytes"));
  assert.equal(await readFile(destination, "utf8"), "re-downloaded-bytes");
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.contentSha256, sha256Of("re-downloaded-bytes"), "and the replacement gets its own record");

  // --- The stat half, on the transfer. ---
  //
  // The cache hit above cannot reach this half: nothing runs between the stat
  // that decides there are cached bytes and the stat inside the hash, they are
  // one synchronous block, so no deletion can land between them in-process. The
  // transfer leg can - and it is the leg that matters, because `downloaded.path`
  // is the destination, not the private temp the transfer streamed into, so a
  // prune reaches the bytes this call has just written. A guard that covers only
  // the stream open fails right here, with the raw ENOENT this whole section
  // exists to keep out of the caller's hands.
  const prunedRoot = await mkdtemp(join(tmpdir(), "downloader-transfer-pruned-"));
  const prunedDestination = join(prunedRoot, "pruned.jar");
  const prunedUrl = "https://repo.example.com/pruned.jar";
  const prunedBytes = "bytes-pruned-before-hashing";

  let prunedCalls = 0;
  const pruningFetch: typeof fetch = (async () => {
    prunedCalls += 1;
    const response = new Response(Buffer.from(prunedBytes), {
      status: 200,
      headers: { etag: "etag-doomed" }
    });
    // Reading a response header is the first thing the transfer does after
    // renaming the bytes into place, and the resolver hashes them immediately
    // after that. Pruning from inside the header read therefore lands squarely
    // in the rename-to-hash window, with no timing assumption to go stale.
    const headerValue = response.headers.get.bind(response.headers);
    let pruned = false;
    Object.defineProperty(response.headers, "get", {
      configurable: true,
      value: (name: string): string | null => {
        if (!pruned) {
          pruned = true;
          rmSync(prunedDestination);
        }
        return headerValue(name);
      }
    });
    return response;
  }) as typeof fetch;

  const prunedResult = await resolveCachedDownload(prunedUrl, prunedDestination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn: pruningFetch
  });

  assert.equal(existsSync(prunedDestination), false, "the prune landed: there are no bytes left to identify");
  assert.equal(
    prunedResult.ok,
    false,
    "no identity to report and nothing on disk to report it for - a failed leg, not a thrown ENOENT"
  );
  assert.equal(prunedResult.statusCode, 200, "the repository answered; it is the bytes that did not survive");
  assert.equal(
    prunedResult.contentLength,
    prunedBytes.length,
    "and the failure still reports what the exchange achieved"
  );
  assert.equal(
    prunedCalls,
    1,
    "one transfer only: re-fetching an artifact something is actively pruning buys another prune"
  );
  assert.equal(
    existsSync(downloadSidecarPath(prunedDestination)),
    false,
    "and no record is left behind describing bytes nobody holds"
  );
});

test("resolveCachedDownload(revalidate) re-downloads when a 304 answers for bytes a concurrent resolve deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-304-vanished-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await seedCachedDownload(destination, url, "snapshot-bytes-v1", { etag: "etag-v1" });

  const sentHeaders: Array<Record<string, string>> = [];
  let calls = 0;
  const fetchFn: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    sentHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    if (calls === 1) {
      // A concurrent eviction (a cache prune, discardCachedDownload) removes the
      // bytes this conditional request is asking about while it is in flight.
      await rm(destination);
      return new Response(null, { status: 304, headers: { etag: "etag-v1" } });
    }
    return new Response(Buffer.from("snapshot-bytes-v2"), {
      status: 200,
      headers: { etag: "etag-v2" }
    });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn,
    // A caller's own headers ride along on both legs. One of them is a
    // conditional validator, written in the casing a caller is free to choose:
    // "unconditional" has to mean unconditional whatever the source, or the
    // retry earns a second 304 and the call ends with no bytes at all.
    requestHeaders: {
      "if-none-match": '"caller-supplied-etag"',
      authorization: "Bearer caller-token"
    }
  });

  assert.equal(calls, 2, "a 304 confirming bytes that are gone confirms nothing - the transfer still has to happen");
  assert.deepEqual(
    conditionalHeadersIn(sentHeaders[0] ?? {}),
    { "If-None-Match": "etag-v1" },
    "the revalidation asks about the bytes this module actually holds, under its own validator and no other"
  );
  assert.deepEqual(
    conditionalHeadersIn(sentHeaders[1] ?? {}),
    {},
    "and the retry carries no validator from any source: they all describe bytes nobody holds any more"
  );
  assert.equal(
    sentHeaders[1]?.["authorization"],
    "Bearer caller-token",
    "while everything else the caller sent survives - only the validators are this module's to decide"
  );
  assert.equal(sentHeaders[0]?.["authorization"], "Bearer caller-token");
  assert.equal(result.ok, true, "a raced eviction must not surface as a raw ENOENT the caller cannot act on");
  assert.equal(result.cacheStatus, "downloaded");
  assert.equal(result.contentSha256, sha256Of("snapshot-bytes-v2"));
  assert.equal(await readFile(destination, "utf8"), "snapshot-bytes-v2");
});

test("resolveCachedDownload(revalidate) leaves a concurrent winner's record alone when the repository refuses the artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-definitive-race-"));
  const destination = join(root, "gone.jar");
  const url = "https://repo.example.com/gone.jar";
  // Byte-identical before and after, deliberately. A winner that changes the
  // bytes is caught by any currency check at all - even one comparing sizes, or
  // digests - so it proves only that *some* check runs. What has to be pinned is
  // the harder case: the winner re-fetched the same bytes and got fresher
  // validators for them (a CDN swap, a snapshot republished unchanged), so the
  // only thing our retired record gets wrong is the freshness data. Restoring it
  // there is a silent downgrade, and nothing in the digest would show it.
  const bytes = "snapshot-bytes-v1";
  await seedCachedDownload(destination, url, bytes, { etag: "etag-v1" });

  const fetchFn: typeof fetch = (async () => {
    // A concurrent resolve of the same mutable coordinate revalidates this url
    // while our request is in flight, and lands its own record. This call
    // retired the v1 record before its own request went out, so what sits on
    // disk now is the winner's, not ours.
    await writeFile(destination, bytes);
    // Pin the mtime instead of trusting two writes to land in different
    // filesystem ticks: mtime is half of what binds a record to a set of bytes,
    // and a race the test cannot reproduce on demand proves nothing.
    const rewrittenAt = new Date(Date.now() + 5_000);
    await utimes(destination, rewrittenAt, rewrittenAt);
    await writeSidecarFor(destination, { url, contentSha256: sha256Of(bytes), etag: "etag-v2" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(result.ok, false, "a definitive rejection is still the failure the caller fails over on");
  assert.equal(result.statusCode, 404);
  // The same property the stale-if-error path already pins, for the branch that
  // was skipping the check: the pre-request record describes a moment that has
  // passed, and putting it back over the winner's replaces confirmed freshness
  // with our own stale copy of it.
  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.etag, "etag-v2", "the winner's fresher validator survives our refusal");
  assert.equal(
    sidecar.contentMtimeMs,
    (await stat(destination)).mtimeMs,
    "and the record on disk still describes the bytes on disk, not the ones we found there"
  );
  assert.equal(sidecar.contentSha256, sha256Of(bytes));
  assert.equal(await readFile(destination, "utf8"), bytes, "the bytes themselves stay put either way");
});

test("resolveCachedDownload(immutable) surfaces an unreadable cache entry instead of transferring around it", async () => {
  const root = await mkdtemp(join(tmpdir(), "downloader-unreadable-"));
  // A directory where the cached jar should be. Whatever put it there - a
  // half-finished manual cleanup, another tool writing into the cache - the read
  // fails with EISDIR, and it will fail that way on every later call too.
  const destination = join(root, "unreadable.jar");
  await mkdir(destination);
  const url = "https://repo.example.com/unreadable.jar";

  const seen = { calls: 0 };
  await assert.rejects(
    resolveCachedDownload(url, destination, {
      freshness: "immutable",
      retries: 0,
      timeoutMs: 2_000,
      fetchFn: forbiddenFetch(seen)
    }),
    (error: NodeJS.ErrnoException) => error.code === "EISDIR",
    "an entry that is there and unreadable is an error to report, not a digest to shrug off"
  );
  assert.equal(
    seen.calls,
    0,
    "and never a cache miss: reported as one, this url would transfer on every call forever while the one actionable error stayed hidden behind whatever the network did next"
  );
});

test("isDownloadSidecarPath recognises the leftover of an interrupted sidecar write", async () => {
  const jarPath = "/cache/downloads/abc123.jar";
  const sidecarPath = downloadSidecarPath(jarPath);

  assert.equal(isDownloadSidecarPath(sidecarPath), true);
  // What a process killed inside the sidecar's temp-file-plus-rename leaves.
  assert.equal(isDownloadSidecarPath(`${sidecarPath}.1a2b3c4d.tmp`), true);
  // A jar temp is a truncated artifact, not a description of one: it has always
  // been inventoried as a downloads entry and stays that way.
  assert.equal(isDownloadSidecarPath(`${jarPath}.1a2b3c4d.tmp`), false);
  assert.equal(isDownloadSidecarPath(jarPath), false);
});
