import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import type { JSONRPCResponse } from "@modelcontextprotocol/server";

import type { Era } from "./era-classifier.js";
import { serverIdentitySnapshot } from "./server-identity.js";

/**
 * Centralized modern-era decoration for supervisor-synthesized replies.
 *
 * Contract:
 *  - Decorates ONLY when the originating request's snapshot era is "modern"
 *    (the era captured at admission; it is the ONLY captured-context field
 *    synthetic decoration may read — protocolVersion/clientCapabilities/
 *    clientInfo stay unread, and the identity comes from the canonical
 *    src/server-identity.ts module, never from request context).
 *  - Modern-era RESULT envelopes gain the modern public fields the SDK stamps
 *    on every result it encodes: top-level `resultType: "complete"` (every
 *    result this server emits is complete — synthetic results are all
 *    tools/call-shaped, where "complete" is always correct) and
 *    `_meta[SERVER_INFO_META_KEY]` carrying the canonical identity.
 *  - Raw JSON-RPC ERROR envelopes and non-modern eras pass through UNCHANGED
 *    (same reference), keeping the legacy synthetic shapes byte-identical to
 *    the premigration fixtures (pinned by the synthetic-inventory suite).
 *  - Cache fields (ttlMs/cacheScope) are NEVER added: they belong only to the
 *    six cacheable list/read/discover methods, none of which has a structured
 *    synthetic path.
 */
export function decorateSyntheticReply(reply: JSONRPCResponse, era: Era | undefined): JSONRPCResponse {
  if (era !== "modern") {
    return reply;
  }
  const asRecord = reply as unknown as Record<string, unknown>;
  if ("error" in asRecord || !("result" in asRecord)) {
    return reply;
  }
  const result = asRecord.result as Record<string, unknown>;
  const existingMeta =
    result._meta !== null && typeof result._meta === "object" && !Array.isArray(result._meta)
      ? (result._meta as Record<string, unknown>)
      : {};
  return {
    ...asRecord,
    result: {
      ...result,
      resultType: "complete",
      _meta: {
        ...existingMeta,
        [SERVER_INFO_META_KEY]: serverIdentitySnapshot()
      }
    }
  } as unknown as JSONRPCResponse;
}
