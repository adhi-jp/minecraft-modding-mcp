import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearRememberedRejections,
  resolveCachedDownload
} from "../../src/repo-downloader.ts";
import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * The whole point of this file is a module-level record set, so every test has
 * to start from an empty one: two tests in this process that name the same url
 * would otherwise read each other's verdicts.
 */
function isolateRememberedRejections(): void {
  clearRememberedRejections();
}

/** A counting fetch stub. `answer` returns the Response for one url. */
function countingFetch(answer: (url: string) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    return await answer(url);
  }) as typeof fetch;
  return { fetchFn, urls };
}

/** Run `body` with GRADLE_USER_HOME pinned so no real user cache leaks in. */
async function withGradleHome<T>(gradleUserHome: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = gradleUserHome;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previous;
    }
  }
}

/** Run `body` with `globalThis.fetch` replaced, restoring it afterwards. */
async function withGlobalFetch<T>(fetchFn: typeof fetch, body: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    return await body();
  } finally {
    globalThis.fetch = previous;
  }
}

// ---------------------------------------------------------------------------
// The record itself.
// ---------------------------------------------------------------------------

test("resolveCachedDownload(immutable) answers a second call from the remembered 404 without a request", async () => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "remembered-rejection-hit-"));
  const url = "https://repo.example.test/com/example/absent/1.0.0/absent-1.0.0-sources.jar";
  const destination = join(root, "absent-sources.jar");
  const { fetchFn, urls } = countingFetch(() => new Response("not found", { status: 404 }));

  const first = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });
  const second = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });

  assert.equal(urls.length, 1, "the second call must not reach the repository at all");
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.deepEqual(second, first, "the remembered answer must be the answer that was recorded");
});

test("resolveCachedDownload(immutable) asks again once the remembered 404 has expired", async (t) => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "remembered-rejection-expiry-"));
  const url = "https://repo.example.test/com/example/late/1.0.0/late-1.0.0-sources.jar";
  const destination = join(root, "late-sources.jar");
  const { fetchFn, urls } = countingFetch(() => new Response("not found", { status: 404 }));

  // Only Date is mocked: the abort timer inside the transfer stays real.
  t.mock.timers.enable({ apis: ["Date"] });

  await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });
  await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });
  assert.equal(urls.length, 1, "inside the window the record answers");

  // Past the five-minute window the module documents.
  t.mock.timers.tick(5 * 60_000 + 1);

  await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });
  assert.equal(urls.length, 2, "an expired record must not keep answering");
});

test("resolveCachedDownload(immutable) never remembers a repository that answered 5xx", async () => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "remembered-rejection-5xx-"));
  const url = "https://repo.example.test/com/example/flaky/1.0.0/flaky-1.0.0-sources.jar";
  const destination = join(root, "flaky-sources.jar");
  const payload = Buffer.from("real-bytes");
  let answered = 0;
  const { fetchFn, urls } = countingFetch(() => {
    answered += 1;
    return answered === 1
      ? new Response("upstream is unwell", { status: 503 })
      : new Response(payload, { status: 200 });
  });

  const first = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });
  const second = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });

  assert.equal(first.ok, false);
  assert.equal(urls.length, 2, "a transient failure must cost one more request, not a lockout");
  assert.equal(second.ok, true, "the artifact must be reachable on the very next call");
});

test("resolveCachedDownload(immutable) never remembers a request that threw", async () => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "remembered-rejection-throw-"));
  const url = "https://repo.example.test/com/example/blip/1.0.0/blip-1.0.0-sources.jar";
  const destination = join(root, "blip-sources.jar");
  const payload = Buffer.from("real-bytes");
  let answered = 0;
  const { fetchFn, urls } = countingFetch(() => {
    answered += 1;
    if (answered === 1) {
      throw new Error("ECONNRESET");
    }
    return new Response(payload, { status: 200 });
  });

  await assert.rejects(
    resolveCachedDownload(url, destination, {
      freshness: "immutable",
      retries: 0,
      timeoutMs: 1_000,
      fetchFn
    })
  );
  const second = await resolveCachedDownload(url, destination, {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });

  assert.equal(urls.length, 2, "a network blip must be retried on the next call");
  assert.equal(second.ok, true);
});

test("resolveCachedDownload(revalidate) never remembers a rejection, because a -SNAPSHOT is republished", async () => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "remembered-rejection-snapshot-"));
  const url =
    "https://repo.example.test/com/example/mod/1.0.0-SNAPSHOT/mod-1.0.0-SNAPSHOT-sources.jar";
  const destination = join(root, "snapshot-sources.jar");
  const payload = Buffer.from("published-at-last");
  let answered = 0;
  const { fetchFn, urls } = countingFetch(() => {
    answered += 1;
    return answered === 1
      ? new Response("not found", { status: 404 })
      : new Response(payload, { status: 200 });
  });

  const first = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });
  const second = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });

  assert.equal(first.ok, false);
  assert.equal(urls.length, 2, "a mutable coordinate must be asked about every time");
  assert.equal(second.ok, true);
});

test("resolveCachedDownload keeps a remembered rejection to the cache slot that earned it", async () => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "remembered-rejection-slot-"));
  const url = "https://repo.example.test/com/example/shared/1.0.0/shared-1.0.0-sources.jar";
  const { fetchFn, urls } = countingFetch(() => new Response("not found", { status: 404 }));

  await resolveCachedDownload(url, join(root, "cache-a", "shared-sources.jar"), {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });
  await resolveCachedDownload(url, join(root, "cache-b", "shared-sources.jar"), {
    freshness: "immutable",
    retries: 0,
    timeoutMs: 1_000,
    fetchFn
  });

  assert.equal(urls.length, 2, "a second cache directory must not inherit the first's verdict");
});

// ---------------------------------------------------------------------------
// What it buys the repository sweep.
// ---------------------------------------------------------------------------

test("resolveSourceTarget(targetKind=coordinate) repeats a binary-only resolve without re-sweeping the repositories", async () => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "sweep-retry-binary-only-"));
  const localBinaryJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "binary-only",
    "1.0.0",
    "binary-only-1.0.0.jar"
  );
  await createJar(localBinaryJarPath, {
    "com/example/BinaryOnly.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const { fetchFn, urls } = countingFetch(() => new Response("not found", { status: 404 }));
  const config = buildTestConfig(root, {
    sourceRepos: ["https://repo-one.example.test", "https://repo-two.example.test"]
  });
  const target = { kind: "coordinate", value: "com.example:binary-only:1.0.0" } as const;

  await withGradleHome(join(root, "gradle-home"), async () => {
    await withGlobalFetch(fetchFn, async () => {
      const first = await resolveSourceTarget(target, { allowDecompile: true }, config);
      const sweptOnFirstCall = urls.length;
      const second = await resolveSourceTarget(target, { allowDecompile: true }, config);

      assert.equal(
        sweptOnFirstCall,
        2,
        "the first call asks both repositories for the sources jar that does not exist"
      );
      assert.equal(
        urls.length,
        sweptOnFirstCall,
        "the repeat call must not re-ask a repository that already said no"
      );

      // The repeat still resolves to the same artifact, which is what lets the
      // ingest that follows it recognise the index it already built.
      assert.equal(first.origin, "local-m2");
      assert.equal(first.isDecompiled, true);
      assert.equal(first.binaryJarPath, localBinaryJarPath);
      assert.equal(second.artifactId, first.artifactId);
      assert.equal(second.artifactSignature, first.artifactSignature);
      assert.equal(second.binaryJarPath, first.binaryJarPath);
      assert.equal(second.origin, first.origin);
      assert.equal(second.isDecompiled, first.isDecompiled);
    });
  });
});

test("resolveSourceTarget(targetKind=coordinate) still prefers published sources after a transient sources failure", async () => {
  isolateRememberedRejections();
  const root = await mkdtemp(join(tmpdir(), "sweep-retry-transient-"));
  const localBinaryJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "flaky-sources",
    "2.0.0",
    "flaky-sources-2.0.0.jar"
  );
  await createJar(localBinaryJarPath, {
    "com/example/FlakySources.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const sourcesFixture = join(root, "published-sources.jar");
  await createJar(sourcesFixture, {
    "com/example/FlakySources.java": ["package com.example;", "public class FlakySources {}"].join(
      "\n"
    )
  });
  const sourcesBytes = await readFile(sourcesFixture);

  let sourceRequests = 0;
  const { fetchFn } = countingFetch((url) => {
    if (!url.endsWith("-sources.jar")) {
      return new Response("not found", { status: 404 });
    }
    sourceRequests += 1;
    return sourceRequests === 1
      ? new Response("upstream is unwell", { status: 503 })
      : new Response(sourcesBytes, { status: 200 });
  });

  const config = buildTestConfig(root, { sourceRepos: ["https://repo-one.example.test"] });
  const target = { kind: "coordinate", value: "com.example:flaky-sources:2.0.0" } as const;

  await withGradleHome(join(root, "gradle-home"), async () => {
    await withGlobalFetch(fetchFn, async () => {
      const first = await resolveSourceTarget(target, { allowDecompile: true }, config);
      const second = await resolveSourceTarget(target, { allowDecompile: true }, config);

      // The transient failure sent the first call to the local binary, which is
      // the decompile fallback the cascade keeps behind the sources legs.
      assert.equal(first.origin, "local-m2");
      assert.equal(first.isDecompiled, true);

      // And the very next call gets the real published sources: a 503 is never
      // remembered, so the repository is asked again.
      assert.equal(sourceRequests, 2);
      assert.equal(second.origin, "remote-repo");
      assert.equal(second.isDecompiled, false);
      assert.ok(second.sourceJarPath);
    });
  });
});
