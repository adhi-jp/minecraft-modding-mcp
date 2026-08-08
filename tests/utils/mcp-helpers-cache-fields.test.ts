import assert from "node:assert/strict";
import test from "node:test";

import { errorResource } from "../../src/mcp-helpers.ts";

/**
 * ProblemDetails-read cache override (adopted cache policy): a resource read
 * whose content is a ProblemDetails envelope must answer ttlMs 0 /
 * cacheScope "private" on the MODERN era regardless of its resource's class
 * row — and must stay byte-identical (no cache fields at all) toward the
 * legacy era, because the 2025 codec never strips handler-returned fields.
 *
 * Identification is STRUCTURAL: the override rides the errorResource(...)
 * construction path itself (the registration code knows when it emits an
 * error resource); the era gate is the modern per-request envelope claim on
 * the ServerContext (`_meta["io.modelcontextprotocol/protocolVersion"]`,
 * lifted to ctx.mcpReq.envelope), which the 2026 codec enforces pre-handler
 * and which era-conflict admission keeps off every legacy connection.
 */

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

type LooseErrorResource = (
  uri: string,
  error: string | { message: string },
  ctx?: unknown
) => Record<string, unknown>;
const errorResourceWithCtx = errorResource as unknown as LooseErrorResource;

function ctxWithEnvelope(envelope?: Record<string, unknown>): Record<string, unknown> {
  return {
    mcpReq: {
      id: 1,
      method: "resources/read",
      ...(envelope !== undefined ? { envelope } : {})
    }
  };
}

test("errorResource on a modern-era request carries the ProblemDetails cache override (ttlMs 0, cacheScope private) at result top level", () => {
  const result = errorResourceWithCtx(
    "mc://artifact/missing-p3",
    "Artifact not found.",
    ctxWithEnvelope({ [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} })
  );

  assert.equal(result.ttlMs, 0, "modern ProblemDetails reads must pin ttlMs 0 over any class-row hint");
  assert.equal(result.cacheScope, "private", "modern ProblemDetails reads must pin cacheScope private");
  // The override must not disturb the envelope itself.
  const contents = result.contents as Array<{ text: string }>;
  const payload = JSON.parse(contents[0]!.text) as { error?: { type?: string } };
  assert.equal(payload.error?.type, "https://minecraft-modding-mcp.dev/problems/resource");
});

test("errorResource without a request context stays legacy-shaped (no cache fields)", () => {
  const result = errorResourceWithCtx("mc://artifact/missing-p3", "Artifact not found.");

  assert.equal("ttlMs" in result, false, "ctx-less errorResource must not grow cache fields");
  assert.equal("cacheScope" in result, false, "ctx-less errorResource must not grow cache fields");
});

test("errorResource on a request without the modern envelope claim carries no cache fields", () => {
  for (const envelope of [
    undefined,
    // Reserved keys other than the full modern claim are NOT a modern
    // signal: a legacy peer stuffing clientInfo into _meta must not flip the
    // gate (the 2025 codec would serialize any attached field verbatim).
    { [CLIENT_INFO_KEY]: { name: "legacy-peer", version: "1.0.0" } },
    // A non-string protocol-version value is not a valid claim either.
    { [PROTOCOL_VERSION_KEY]: 20260728 },
    // Claim-shaped-INVALID envelopes (the R1 rows): the gate must mirror the
    // FULL shallow modern-signal check — a protocolVersion string WITHOUT a
    // plain-object clientCapabilities is legacy-permissively forwarded on a
    // legacy-locked connection and its reply is legacy-encoded, so it must
    // never gain cache fields.
    { [PROTOCOL_VERSION_KEY]: "2026-07-28" },
    { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: [] },
    { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: null },
    { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: "caps" },
    { [CLIENT_CAPABILITIES_KEY]: {} }
  ]) {
    const result = errorResourceWithCtx(
      "mc://artifact/missing-p3",
      "Artifact not found.",
      ctxWithEnvelope(envelope as Record<string, unknown> | undefined)
    );
    assert.equal("ttlMs" in result, false, `legacy-shaped ctx must not gain ttlMs (envelope: ${JSON.stringify(envelope)})`);
    assert.equal("cacheScope" in result, false, `legacy-shaped ctx must not gain cacheScope (envelope: ${JSON.stringify(envelope)})`);
  }
});
