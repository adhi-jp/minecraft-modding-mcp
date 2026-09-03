import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../../src/errors.ts";
import { defaultDownloadPath } from "../../src/repo-downloader.ts";
import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { mapErrorToProblem } from "../../src/tool-guidance.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

const REPO = "https://repo.example.test";

/** Run `body` with GRADLE_USER_HOME pinned so no real user cache leaks into the test. */
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

async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("resolveSourceTarget names an unreadable download-cache entry in the terminal error's hints", async () => {
  // The downloader deliberately propagates a cache entry that is PRESENT and
  // unreadable rather than laundering it into a miss. On the way out through
  // the repository loop that throw used to lose everything but its message:
  // the caller was told their repositories were unstable, which is exactly
  // wrong - nothing is wrong with the repository, and the one file standing in
  // the way was never named.
  const root = await mkdtemp(join(tmpdir(), "review-a1-unreadable-cache-"));
  const gradleUserHome = join(root, "gradle-home");
  await mkdir(gradleUserHome, { recursive: true });

  const coordinate = "com.example:blocked-cache:1.0";
  const sourceUrl = `${REPO}/com/example/blocked-cache/1.0/blocked-cache-1.0-sources.jar`;
  const config = buildTestConfig(root, { sourceRepos: [REPO] });

  // A DIRECTORY where the url-keyed cache entry belongs. It is present, it is
  // not empty, and reading it raises EISDIR - the shape a botched `cp -r` or an
  // interrupted archive extraction leaves behind.
  const cacheSlot = defaultDownloadPath(config.cacheDir, sourceUrl);
  await mkdir(cacheSlot, { recursive: true });
  await writeFile(join(cacheSlot, "stray-entry"), "not the jar you cached");

  const fetchStub: typeof fetch = (async () =>
    new Response("not found", { status: 404 })) as typeof fetch;

  const caught = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, async () => {
      try {
        await resolveSourceTarget(
          { kind: "coordinate", value: coordinate },
          { allowDecompile: true },
          config
        );
        return undefined;
      } catch (error) {
        return error;
      }
    })
  );

  assert.ok(caught, "an unreadable cache entry must not resolve to an artifact");
  assert.ok(isAppError(caught));
  assert.equal(caught.code, ERROR_CODES.REPO_FETCH_FAILED);

  // THROUGH THE PUBLIC MAPPING: `ProblemDetails` has no `details` passthrough,
  // so an assertion on `caught.details` alone proves nothing about what the
  // caller actually receives.
  const problem = mapErrorToProblem(caught, "req-unreadable-cache");
  assert.ok(problem.hints, "the terminal error must publish hints at all");
  assert.ok(
    problem.hints.some((hint) => hint.includes(cacheSlot)),
    `the unreadable cache entry must be named; hints were ${JSON.stringify(problem.hints)}`
  );
  assert.ok(
    problem.hints.some((hint) => hint.includes("EISDIR")),
    `the errno that explains the refusal must reach the caller; hints were ${JSON.stringify(problem.hints)}`
  );
});
