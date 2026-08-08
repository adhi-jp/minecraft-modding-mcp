import type { CacheHint } from "@modelcontextprotocol/server";

/**
 * Adopted cache-hint policy for the 2026-07-28 protocol revision (approved
 * values; single source of truth for every configured `ttlMs`/`cacheScope`).
 *
 * Everything is cacheScope "private": every result reflects this server
 * process's local caches, workspace, and feature-flag configuration, so no
 * shared cache may ever serve it across clients.
 *
 * ttlMs by surface, with the rationale each row stands on:
 *  - tools/list and server/discover: 0 — the SDK default; deliberately NOT
 *    configured. The advertised tool set depends on process feature flags
 *    (BATCH_TOOLS_OFF, VERIFY_MIXIN_TARGET_OFF), so caching would risk
 *    serving a stale flag-dependent tool set across a reconfiguration.
 *  - resources/list and resources/templates/list: 1 hour. The resource
 *    registry is process-stable registration metadata (fixed 2+7 set); a
 *    cached copy may briefly outlive a changed configuration, which is
 *    acceptable for pure discovery metadata.
 *  - resources/read of mc://versions/list: 5 minutes — permits up to five
 *    minutes of staleness against the upstream Mojang version manifest.
 *  - resources/read of mc://metrics: 0 — live runtime counters, never cache
 *    (default value, configured explicitly for self-documentation).
 *  - resources/read of the seven template resources (class-source,
 *    class-source-json, artifact-file, find-mapping, find-member-mapping,
 *    class-members, artifact-metadata): 1 minute — short-lived reuse of
 *    locally indexed data; local changes (re-index, re-resolve, remap) may
 *    be served stale for up to one minute.
 *  - ANY successful resource read whose content is a ProblemDetails envelope:
 *    0, with UNCONDITIONAL precedence over the resource's class row —
 *    transient failures represented as successful reads must never be
 *    cached, or a recovered resource would keep serving its old error. The
 *    override is identified STRUCTURALLY on the errorResource(...) build
 *    path (never re-inferred from serialized text) and is emitted as
 *    handler-returned result fields, which the SDK's encode seam ranks above
 *    configured hints. Because the 2025-era codec serializes
 *    handler-returned fields verbatim, the override is era-gated in
 *    errorResource() — legacy results never carry cache fields.
 *
 * Configured hints ride the SDK's symbol-keyed carrier (never serialized), so
 * none of the values below can ever surface on a 2025-era response.
 */

/** cacheScope for every surface this server emits cache hints for. */
export const APP_CACHE_SCOPE = "private" as const;

/** resources/list and resources/templates/list: 1 hour. */
export const RESOURCE_LISTS_TTL_MS = 3_600_000;

/** resources/read of mc://versions/list: 5 minutes. */
export const VERSIONS_LIST_READ_TTL_MS = 300_000;

/** resources/read of mc://metrics: live counters, never cache. */
export const METRICS_READ_TTL_MS = 0;

/** resources/read of the seven template resources (class-source, class-source-json, artifact-file, find-mapping, find-member-mapping, class-members, artifact-metadata): 1 minute. */
export const RESOURCE_READ_TTL_MS = 60_000;

/** ProblemDetails resource reads: never cache, regardless of the class row. */
export const PROBLEM_DETAILS_READ_TTL_MS = 0;

/** Per-operation hints handed to the McpServer constructor (`cacheHints`). */
export const RESOURCE_LISTS_CACHE_HINT: Readonly<CacheHint> = Object.freeze({
  ttlMs: RESOURCE_LISTS_TTL_MS,
  cacheScope: APP_CACHE_SCOPE
});

/** Per-registration hint for the mc://versions/list fixed resource. */
export const VERSIONS_LIST_READ_CACHE_HINT: Readonly<CacheHint> = Object.freeze({
  ttlMs: VERSIONS_LIST_READ_TTL_MS,
  cacheScope: APP_CACHE_SCOPE
});

/** Per-registration hint for the mc://metrics fixed resource (explicit default). */
export const METRICS_READ_CACHE_HINT: Readonly<CacheHint> = Object.freeze({
  ttlMs: METRICS_READ_TTL_MS,
  cacheScope: APP_CACHE_SCOPE
});

/** Per-registration hint for every template resource. */
export const RESOURCE_READ_CACHE_HINT: Readonly<CacheHint> = Object.freeze({
  ttlMs: RESOURCE_READ_TTL_MS,
  cacheScope: APP_CACHE_SCOPE
});

/**
 * Handler-returned result fields for the ProblemDetails-read override
 * (precedence rank 1 at the SDK encode seam — beats the class row's
 * configured hint). Spread onto the errorResource result ONLY on modern-era
 * requests; see errorResource() for the era gate.
 */
export const PROBLEM_DETAILS_READ_CACHE_FIELDS: Readonly<{
  ttlMs: number;
  cacheScope: typeof APP_CACHE_SCOPE;
}> = Object.freeze({
  ttlMs: PROBLEM_DETAILS_READ_TTL_MS,
  cacheScope: APP_CACHE_SCOPE
});
