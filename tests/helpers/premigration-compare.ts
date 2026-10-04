import { homedir } from "node:os";

/**
 * Shared comparison plumbing for the premigration fixture gates (ProblemDetails
 * envelope goldens and per-tool contract snapshots). Both gates must apply the
 * same normalization rule and report differences the same way, so the rule
 * and the comparator live here once.
 */

type Normalize = (value: unknown, options?: { pathReplacements?: [string, string][] }) => unknown;

/**
 * Builds the live-message normalizer: the SAME lib the capture used
 * (scripts/premigration/lib.mjs normalizeCaptured), with THIS session's paths.
 */
export async function createPremigrationNormalizer(root: string): Promise<(message: unknown) => unknown> {
  const lib = (await import("../../scripts/premigration/lib.mjs")) as {
    normalizeCaptured: Normalize;
    REPO_ROOT: string;
  };
  // defaultPathReplacements() is bound to the CAPTURE-time scratch root, so
  // substitute this session's own scratch root (rule N2, longest-first).
  const pathReplacements: [string, string][] = (
    [
      [root, "<SCRATCH>"],
      [lib.REPO_ROOT, "<REPO>"],
      [homedir(), "<HOME>"]
    ] as [string, string][]
  ).sort((left, right) => right[0].length - left[0].length);
  return (message) =>
    // JSON round-trip first: the in-process transport hands over the raw
    // result object, whose undefined-valued own-properties real stdio
    // serialization drops; normalize the WIRE-equivalent message, as the
    // capture did.
    lib.normalizeCaptured(JSON.parse(JSON.stringify(message)), { pathReplacements });
}

/** First structural difference between two JSON values, or null; deterministic key order. */
export function firstDifference(expected: unknown, actual: unknown, path: string): string | null {
  if (Object.is(expected, actual)) return null;
  const bothObjects =
    typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null;
  if (!bothObjects) {
    return `${path}: fixture ${JSON.stringify(expected)} !== live ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return `${path}: fixture is ${Array.isArray(expected) ? "array" : "object"}, live is ${
      Array.isArray(actual) ? "array" : "object"
    }`;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}.length: fixture ${expected.length} !== live ${actual.length}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const diff = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (diff !== null) return diff;
    }
    return null;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
  for (const key of keys) {
    if (!(key in actualRecord)) return `${path}.${key}: present in fixture, missing in live value`;
    if (!(key in expectedRecord)) return `${path}.${key}: missing in fixture, present in live value`;
    const diff = firstDifference(expectedRecord[key], actualRecord[key], `${path}.${key}`);
    if (diff !== null) return diff;
  }
  return null;
}
