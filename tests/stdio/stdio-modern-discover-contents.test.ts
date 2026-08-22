import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";

import { SERVER_IDENTITY } from "../../src/server-identity.ts";
import { MODERN_META, startInProcessSession, type InProcessSession } from "./inprocess-era-serve.ts";

/**
 * Full server/discover contents (approved policy). The committed drift test
 * (tests/stdio/stdio-supervisor-synthetic-drift.test.ts) pins the identity
 * half over the real supervisor wire; this suite pins the COMPLETE result:
 *  - supportedVersions === ["2026-07-28"] EXACTLY (the legacy initialize
 *    matrix is intentionally NOT advertised here — it surfaces via
 *    initialize negotiation, see stdio-legacy-negotiation-matrix.test.ts);
 *  - capabilities reflect the advertised server capabilities: tools and
 *    resources — both with `listChanged: false` — and NOTHING else: no prompts
 *    capability while none are registered, no subscriptions, no logging. The
 *    `false` is a deliberate suppression, not an SDK default (the SDK defaults
 *    both flags to `true` on first registration; buildServer() passes an
 *    explicit `capabilities` option to override it). The server never emits
 *    `notifications/tools/list_changed` or
 *    `notifications/resources/list_changed`, and `subscriptions/listen`
 *    answers -32601, so a `true` would advertise an unreachable stream. The
 *    suppression is not era-gated — the legacy `initialize` payload is pinned
 *    to the same value in
 *    tests/stdio/stdio-dependency-method-inventory.test.ts;
 *  - identity in result._meta[SERVER_INFO_META_KEY], never a body field;
 *  - resultType "complete";
 *  - adopted cache row: ttlMs 0, cacheScope "private".
 */

const root = mkdtempSync(join(tmpdir(), "p3-discover-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

let modern: InProcessSession;

before(async () => {
  modern = await startInProcessSession();
});

after(async () => {
  await modern?.close();
});

test("server/discover advertises the complete approved contents (versions, capabilities, identity, resultType, cache row)", async () => {
  const frame = await modern.request({
    jsonrpc: "2.0",
    id: "discover-contents",
    method: "server/discover",
    params: { _meta: MODERN_META }
  });
  assert.equal(frame.error, undefined, "the modern discover must be served");
  const result = frame.result;
  assert.ok(result, "the discover must carry a result");

  assert.deepEqual(result.supportedVersions, ["2026-07-28"], "discover advertises EXACTLY the modern revision");
  assert.deepEqual(
    result.capabilities,
    { resources: { listChanged: false }, tools: { listChanged: false } },
    "capabilities must be exactly tools+resources with listChanged suppressed (no prompts while none registered, no subscriptions, no logging)"
  );
  assert.deepEqual(
    Object.keys(result.capabilities as Record<string, unknown>),
    ["resources", "tools"],
    "the discover capability key order is frozen wire: resources before tools"
  );

  const meta = result._meta as Record<string, unknown> | undefined;
  assert.ok(meta, "the discover result must carry _meta");
  assert.deepEqual(
    meta[SERVER_INFO_META_KEY],
    { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version },
    "the discover identity must deep-equal the canonical identity module's value"
  );
  assert.equal("serverInfo" in result, false, "identity lives in _meta, never in a result body field");

  assert.equal(result.resultType, "complete");
  assert.equal(result.ttlMs, 0, "adopted cache row: server/discover ttlMs 0");
  assert.equal(result.cacheScope, "private", "adopted cache row: server/discover cacheScope private");

  assert.deepEqual(
    Object.keys(result).sort(),
    ["_meta", "cacheScope", "capabilities", "resultType", "supportedVersions", "ttlMs"],
    "the discover result top-level key set is closed"
  );
});
