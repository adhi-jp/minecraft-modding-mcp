import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../../src/errors.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { VersionService } from "../../src/version-service.ts";

const DEFAULT_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/**
 * A fetch that fails the way the runtime actually fails a transport error:
 * `TypeError: fetch failed`, with the real cause (DNS, connection refused, TLS)
 * buried in `cause`. Nothing about it is an HTTP status, so none of the typed
 * arms inside fetchJson see it.
 */
function throwingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as typeof fetch;
}

test("listVersions types a transport-level fetch failure as a repository fetch error", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-b-vs-transport-"));
  const svc = new VersionService(
    buildTestConfig(root, { fetchTimeoutMs: 2_000 }),
    throwingFetch(new TypeError("fetch failed"))
  );

  await assert.rejects(
    () => svc.listVersions(),
    (error: unknown) => {
      // A non-OK status, an unparsable body and a timeout are all already typed
      // ERR_REPO_FETCH_FAILED. A DNS failure is the same class of answer - the
      // repository could not be read - and escaping raw made the tool boundary
      // classify it ERR_INTERNAL, which tells the caller this server has a bug
      // rather than that the network is down.
      assert.ok(isAppError(error), "a transport failure must not escape untyped");
      assert.equal(error.code, ERROR_CODES.REPO_FETCH_FAILED);
      assert.match(error.message, /fetch failed/);
      assert.equal(error.details?.url, DEFAULT_MANIFEST_URL);
      assert.equal(error.details?.cause, "fetch failed");
      return true;
    }
  );
});

test("resolveVersionMappings keeps a typed detail-fetch error rather than rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-b-vs-typed-"));
  const detailUrl = "https://example.invalid/detail.json";
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === DEFAULT_MANIFEST_URL) {
      return new Response(
        JSON.stringify({
          latest: { release: "1.21.4" },
          versions: [{ id: "1.21.4", type: "release", url: detailUrl }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("gone", { status: 503 });
  }) as typeof fetch;
  const svc = new VersionService(buildTestConfig(root, { fetchTimeoutMs: 2_000 }), fetchFn);

  await assert.rejects(
    () => svc.resolveVersionMappings("1.21.4"),
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.code, ERROR_CODES.REPO_FETCH_FAILED);
      // The status arm's own message and details survive: the transport mapping
      // must never be layered over an error that already says more.
      assert.match(error.message, /with status 503/);
      assert.equal(error.details?.statusCode, 503);
      assert.equal(error.details?.cause, undefined);
      return true;
    }
  );
});
