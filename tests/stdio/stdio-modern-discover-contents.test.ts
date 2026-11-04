import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";

import { SERVER_IDENTITY } from "../../src/server-identity.ts";
import { MODERN_META, legacyHandshake, startInProcessSession, type InProcessSession } from "./inprocess-era-serve.ts";

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
 *  - `instructions`: the primer for AI agents, the same text the legacy
 *    `initialize` result carries; with the 8.x aliases served (the default)
 *    it ends with the sentence naming them as deprecated aliases (the
 *    switched-off text is pinned in tests/aliases/alias-toggle-off.test.ts);
 *  - resultType "complete";
 *  - adopted cache row: ttlMs 0, cacheScope "private".
 */

/** The primer's last sentence while the 8.x aliases are served. */
const ALIAS_SENTENCE =
  /The 8\.x tools listed after them are deprecated aliases, removed in 10\.0\.0; their replies name the catalog tools to use in `meta\.deprecated\.replacedBy`\.$/;

const root = mkdtempSync(join(tmpdir(), "p3-discover-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

let modern: InProcessSession;
let legacy: InProcessSession;

before(async () => {
  modern = await startInProcessSession();
  legacy = await startInProcessSession();
});

after(async () => {
  await modern?.close();
  await legacy?.close();
});

test("server/discover advertises the complete approved contents (versions, capabilities, instructions, identity, resultType, cache row)", async () => {
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

  const { serverInstructions } = await import("../../src/index.ts");
  assert.equal(result.instructions, serverInstructions(true), "discover carries the primer for a server that serves the 8.x aliases");
  assert.match(String(result.instructions), ALIAS_SENTENCE, "the primer ends with the deprecated-alias sentence");
  assert.ok(String(result.instructions).length <= 700, "the primer stays short");

  assert.equal(result.resultType, "complete");
  assert.equal(result.ttlMs, 0, "adopted cache row: server/discover ttlMs 0");
  assert.equal(result.cacheScope, "private", "adopted cache row: server/discover cacheScope private");

  assert.deepEqual(
    Object.keys(result).sort(),
    ["_meta", "cacheScope", "capabilities", "instructions", "resultType", "supportedVersions", "ttlMs"],
    "the discover result top-level key set is closed"
  );
});

test("the legacy initialize result carries the same instructions primer as server/discover", async () => {
  const init = await legacyHandshake(legacy, "2025-06-18", "discover-contents-legacy-init");
  assert.equal(init.error, undefined, "the legacy initialize must be served");
  const { serverInstructions } = await import("../../src/index.ts");
  assert.equal(init.result?.instructions, serverInstructions(true));
  assert.match(String(init.result?.instructions), ALIAS_SENTENCE);
  assert.deepEqual(
    Object.keys(init.result ?? {}),
    ["protocolVersion", "capabilities", "serverInfo", "instructions"],
    "the initialize result adds instructions after serverInfo"
  );
});
