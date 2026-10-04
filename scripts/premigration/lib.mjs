/**
 * Normalization used when comparing live server output against the frozen
 * pre-migration fixtures under tests/fixtures/premigration/.
 *
 * The original capture harness that produced those fixtures is no longer in
 * the tree (see tests/fixtures/premigration/README.md); only the
 * normalization the comparison tests import is kept here.
 *
 * NORMALIZATION RULES (applied by normalizeCaptured; also documented in
 * tests/fixtures/premigration/README.md — keep in sync):
 *  N1. JSON object keys are sorted recursively (stable byte order), EXCEPT
 *      subtrees explicitly marked verbatim (tool-contract `inputSchema`
 *      subtrees keep wire property order for legacy byte comparison).
 *  N2. Machine-specific path prefixes in strings are replaced: repo root ->
 *      "<REPO>", the harness scratch directory -> "<SCRATCH>", the user home
 *      directory -> "<HOME>".
 *  N3. Non-deterministic values are replaced by key name:
 *        requestId                    -> "<REQUEST_ID>"   (server-random id)
 *        durationMs, lastStageElapsedMs, elapsedMs -> "<DURATION_MS>"
 *        startedAt, lastStageStartedAt -> "<TIMESTAMP>"
 *        pid                          -> "<PID>"
 *      plus `instance` values matching the server's random request-id pattern
 *      /^[0-9a-z]+-[0-9a-z]{8}$/ -> "<REQUEST_ID>". `instance` values of the
 *      form urn:mcp:request:<n> are NOT replaced: the harness uses fixed
 *      sequential JSON-RPC ids, so they are deterministic.
 *  N4. `content[*].text` strings that parse as JSON are replaced by
 *      {"__normalizedJson": <parsed-and-normalized value>} so the text blob
 *      and structuredContent normalize identically (the live server emits
 *      text === JSON.stringify(structuredContent)).
 *  N5. Every fixture records the environment variables that select behavior
 *      (`env` field), with scratch paths normalized per N2. Fixtures contain
 *      no capture timestamps; the capture date/commit live in the README.
 *      (Recorded at capture time; not applied by this module.)
 */

import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Scratch root recorded in the frozen fixtures as <SCRATCH>. */
export const SCRATCH_ROOT =
  process.env.PREMIGRATION_SCRATCH ?? join(tmpdir(), "premigration-p1-0");

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const DURATION_KEYS = new Set([
  "durationMs",
  "lastStageElapsedMs",
  "elapsedMs",
  // runtime-metrics latency aggregates (wall-clock dependent)
  "avgMs",
  "lastMs",
  "minMs",
  "maxMs",
  "p95Ms",
  "p99Ms",
  "totalMs"
]);
const TIMESTAMP_KEYS = new Set(["startedAt", "lastStageStartedAt"]);
const RANDOM_REQUEST_ID_RE = /^[0-9a-z]+-[0-9a-z]{8}$/;

function normalizeString(value, ctx) {
  let out = value;
  // Longest prefix first so <SCRATCH> under the home dir wins over <HOME>.
  for (const [prefix, placeholder] of ctx.pathReplacements) {
    out = out.split(prefix).join(placeholder);
  }
  return out;
}

/**
 * Recursively normalize a captured JSON value per rules N1-N4.
 * `verbatimKeys`: object keys whose subtree keeps property order and raw
 * strings (rule N1 exception; used for advertised inputSchema bytes).
 */
export function normalizeCaptured(value, options = {}) {
  const ctx = {
    pathReplacements: options.pathReplacements ?? defaultPathReplacements(),
    verbatimKeys: new Set(options.verbatimKeys ?? [])
  };
  return normalizeNode(value, ctx, undefined, false);
}

function normalizeNode(value, ctx, keyName, verbatim) {
  if (typeof value === "string") {
    if (!verbatim) {
      if (keyName === "requestId" && RANDOM_REQUEST_ID_RE.test(value)) return "<REQUEST_ID>";
      if (keyName === "instance" && RANDOM_REQUEST_ID_RE.test(value)) return "<REQUEST_ID>";
      if (keyName === "text") {
        const parsed = tryParseJson(value);
        if (parsed !== undefined) {
          return { __normalizedJson: normalizeNode(parsed, ctx, undefined, false) };
        }
      }
    }
    return normalizeString(value, ctx);
  }
  if (typeof value === "number") {
    if (!verbatim) {
      if (keyName !== undefined && DURATION_KEYS.has(keyName)) return "<DURATION_MS>";
      if (keyName !== undefined && TIMESTAMP_KEYS.has(keyName)) return "<TIMESTAMP>";
      if (keyName === "pid") return "<PID>";
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeNode(entry, ctx, undefined, verbatim));
  }
  const keys = verbatim ? Object.keys(value) : Object.keys(value).sort();
  const result = {};
  for (const key of keys) {
    const childVerbatim = verbatim || ctx.verbatimKeys.has(key);
    result[key] = normalizeNode(value[key], ctx, key, childVerbatim);
  }
  return result;
}

function tryParseJson(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function defaultPathReplacements() {
  // Order matters: longest / most specific prefixes first (rule N2).
  const entries = [
    [SCRATCH_ROOT, "<SCRATCH>"],
    [REPO_ROOT, "<REPO>"],
    [homedir(), "<HOME>"]
  ];
  return entries.sort((a, b) => b[0].length - a[0].length);
}
