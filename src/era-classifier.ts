import type { JSONRPCResponse } from "@modelcontextprotocol/server";

/**
 * Era classification for the dual-era stdio supervisor.
 *
 * The process serves TWO protocol eras: the legacy
 * initialize/notifications/initialized handshake (five protocol versions) and
 * the modern stateless era (protocol revision 2026-07-28) whose requests carry
 * a per-request `_meta` envelope. The SUPERVISOR is the sole era gatekeeper at
 * admission — the worker's own era classification is unreliable for gating (a
 * claim-less frame silently pins the worker connection legacy) — so the
 * shallow envelope check, the era types, and the machine-readable rejection
 * builders live here.
 */

/** Reserved `_meta` key carrying the per-request protocol version claim. */
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
/** Reserved `_meta` key carrying the per-request client capabilities. */
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** The five legacy handshake protocol versions the worker supports. */
export const LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
] as const;

/** The modern per-request `_meta` protocol revision. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** All protocol versions this process serves, across both eras. */
export const ERA_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION
];

/** Process-lifetime era state. The lock is one-way and survives worker restarts. */
export type Era = "unselected" | "legacy" | "modern";

export type EraSignalClassification = "modern-signal" | "claim-less" | "claim-shaped-invalid";

export type EraSignal = {
  classification: EraSignalClassification;
  /** Absent required io.modelcontextprotocol/* keys. */
  missing: string[];
  /** Present-but-wrong-shallow-type required io.modelcontextprotocol/* keys. */
  invalid: string[];
};

type RequestId = string | number;

const REQUIRED_META_KEYS = [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shallow era-signal classification of a request's (or notification's)
 * params. Mirrors the SDK RequestMetaEnvelopeSchema's REQUIREDNESS without
 * deep value validation: `params._meta` must be an object carrying a string
 * `io.modelcontextprotocol/protocolVersion` and a non-null non-array object
 * `io.modelcontextprotocol/clientCapabilities`. `io.modelcontextprotocol/clientInfo`
 * is optional and NOT part of the check.
 *
 * A shallow-VALID envelope is the modern era signal even when the version
 * VALUE is unsupported (e.g. "2027-01-01") — deep value validation belongs to
 * the worker, which answers -32022 with {supported, requested}.
 *
 * claim-less: params/_meta missing, `_meta` not a plain object, or `_meta`
 * carrying NEITHER required key. claim-shaped-invalid: at least one required
 * key present but the shallow check fails (`missing` = absent required keys,
 * `invalid` = present-but-wrong-shallow-type keys).
 */
export function classifyEraSignal(params: unknown): EraSignal {
  const meta = isPlainObject(params) ? (params as { _meta?: unknown })._meta : undefined;
  if (!isPlainObject(meta)) {
    return { classification: "claim-less", missing: [...REQUIRED_META_KEYS], invalid: [] };
  }
  const versionPresent = PROTOCOL_VERSION_META_KEY in meta;
  const capabilitiesPresent = CLIENT_CAPABILITIES_META_KEY in meta;
  if (!versionPresent && !capabilitiesPresent) {
    return { classification: "claim-less", missing: [...REQUIRED_META_KEYS], invalid: [] };
  }
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!versionPresent) {
    missing.push(PROTOCOL_VERSION_META_KEY);
  } else if (typeof meta[PROTOCOL_VERSION_META_KEY] !== "string") {
    invalid.push(PROTOCOL_VERSION_META_KEY);
  }
  if (!capabilitiesPresent) {
    missing.push(CLIENT_CAPABILITIES_META_KEY);
  } else if (!isPlainObject(meta[CLIENT_CAPABILITIES_META_KEY])) {
    invalid.push(CLIENT_CAPABILITIES_META_KEY);
  }
  if (missing.length === 0 && invalid.length === 0) {
    return { classification: "modern-signal", missing, invalid };
  }
  return { classification: "claim-shaped-invalid", missing, invalid };
}

const SUPPORTED_VERSIONS_SENTENCE =
  `Supported protocol versions: ${LEGACY_PROTOCOL_VERSIONS.join(", ")} (legacy initialize handshake) ` +
  `and ${MODERN_PROTOCOL_VERSION} (modern per-request _meta).`;

/** Launcher-neutral fresh-process recovery preamble shared by both era-conflict messages. */
const FRESH_PROCESS_RECOVERY =
  "start a fresh process: close this transport, terminate and respawn the configured server command " +
  "as a fresh stdio process, discard or re-issue any pending request ids, then";

export const ERA_CONFLICT_MODERN_MESSAGE =
  `initialize rejected: this server process is era-locked to protocol revision ${MODERN_PROTOCOL_VERSION} ` +
  "(modern per-request _meta era), so the legacy initialize handshake can no longer be accepted. " +
  `${SUPPORTED_VERSIONS_SENTENCE} ` +
  `To use the legacy handshake, ${FRESH_PROCESS_RECOVERY} send initialize followed by notifications/initialized.`;

// Claim-agnostic wording: ANY string protocolVersion value classifies as the
// modern signal, so the message names the envelope, not a specific revision.
export const ERA_CONFLICT_LEGACY_MESSAGE =
  "Modern per-request _meta request rejected: this server process is era-locked to the legacy initialize handshake, " +
  "so requests carrying the modern per-request _meta envelope can no longer be accepted. " +
  `${SUPPORTED_VERSIONS_SENTENCE} ` +
  `To use the modern era, ${FRESH_PROCESS_RECOVERY} send a request carrying the required io.modelcontextprotocol/* _meta envelope.`;

const REQUIRED_KEYS_SENTENCE =
  `the required io.modelcontextprotocol/* keys (${PROTOCOL_VERSION_META_KEY} and ${CLIENT_CAPABILITIES_META_KEY}) in params._meta`;

export const MISSING_META_UNSELECTED_MESSAGE =
  "Request rejected: no protocol era is selected yet and this request carries no valid era signal. " +
  "Either send initialize followed by notifications/initialized to select the legacy handshake, " +
  `or include ${REQUIRED_KEYS_SENTENCE} to select protocol revision ${MODERN_PROTOCOL_VERSION}.`;

export const MISSING_META_MODERN_MESSAGE =
  `Request rejected: this server process is era-locked to protocol revision ${MODERN_PROTOCOL_VERSION} ` +
  "and the request lacks the required per-request _meta envelope. " +
  `Include ${REQUIRED_KEYS_SENTENCE}.`;

/**
 * One-way era conflict rejection. selectedEra "modern" rejects a legacy
 * initialize with -32601; selectedEra "legacy" rejects a modern-signal
 * request with -32600. Machine-readable discrimination is by code +
 * data.kind/selectedEra/requestedEra/supported only.
 */
export function buildEraConflictRejection(
  id: RequestId,
  selectedEra: "legacy" | "modern"
): JSONRPCResponse {
  const modernSelected = selectedEra === "modern";
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: modernSelected ? -32601 : -32600,
      message: modernSelected ? ERA_CONFLICT_MODERN_MESSAGE : ERA_CONFLICT_LEGACY_MESSAGE,
      data: {
        kind: "era_conflict",
        selectedEra,
        requestedEra: modernSelected ? "legacy" : "modern",
        supported: [...ERA_SUPPORTED_PROTOCOL_VERSIONS]
      }
    }
  } as JSONRPCResponse;
}

/**
 * Rejection for a request carrying no valid era signal: in the unselected
 * state (era stays UNSELECTED; the message names both recovery paths) or in
 * the modern era (the message names the required envelope). `invalid` is
 * included only when non-empty; `missing` is always present.
 */
export function buildMissingMetaRejection(
  id: RequestId,
  signal: EraSignal,
  era: "unselected" | "modern"
): JSONRPCResponse {
  const data: Record<string, unknown> = { kind: "missing_meta", missing: [...signal.missing] };
  if (signal.invalid.length > 0) {
    data.invalid = [...signal.invalid];
  }
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32602,
      message: era === "modern" ? MISSING_META_MODERN_MESSAGE : MISSING_META_UNSELECTED_MESSAGE,
      data
    }
  } as JSONRPCResponse;
}

/**
 * Plain -32601 admission rejection for subscriptions/listen in the modern era
 * (no data.kind — deliberately indistinguishable from an ordinary unknown
 * method). Defense in depth: if admission were ever bypassed, the worker
 * (maxSubscriptions: 0) would answer -32603 "Subscription limit reached";
 * intercepting at admission keeps that internal detail off the wire.
 */
export function buildMethodNotFoundRejection(id: RequestId): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" }
  } as JSONRPCResponse;
}
