import { access } from "node:fs/promises";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { ERROR_CODES, createError } from "../errors.js";
import type { SourceMapping } from "../types.js";

export function normalizePathStyle(path: string): string {
  return path.replaceAll("\\", "/");
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeMapping(mapping: SourceMapping | undefined): SourceMapping {
  if (mapping == null) {
    return "obfuscated";
  }
  if (
    mapping === "obfuscated" ||
    mapping === "mojang" ||
    mapping === "intermediary" ||
    mapping === "yarn"
  ) {
    return mapping;
  }
  throw createError({
    code: ERROR_CODES.MAPPING_UNAVAILABLE,
    message: `Unsupported mapping "${mapping}".`,
    details: {
      mapping,
      nextAction: "Try mapping=obfuscated which is always available.",
      ...buildSuggestedCall({ tool: "resolve-artifact", params: { mapping: "obfuscated" } })
    }
  });
}

/**
 * The mapping an artifact-targeted call runs in when the caller left `mapping`
 * out.
 *
 * A stored artifact already carries the namespace it was resolved into, so a
 * follow-up call that names it by `artifactId` must inherit that namespace
 * instead of falling back to the version-target default ("obfuscated").
 * Without this, `find-class` -> `get-class-source` -> `get-class-members`
 * split across two namespaces: source came back in mojang names while members
 * came back obfuscated (`ownerFqn: "dlp"`), for the same artifact and the same
 * absent `mapping` argument.
 *
 * `requestedMapping` wins over `mappingApplied` so the echoed request keeps
 * meaning "what was asked for" even on artifacts where the mapping could not
 * be applied; `mappingApplied` is the fallback for rows stored before the
 * requested namespace was persisted.
 */
export function inheritArtifactMapping(
  inputMapping: SourceMapping | undefined,
  artifact: { requestedMapping?: SourceMapping; mappingApplied?: SourceMapping }
): SourceMapping {
  if (inputMapping != null) {
    return normalizeMapping(inputMapping);
  }
  return artifact.requestedMapping ?? artifact.mappingApplied ?? normalizeMapping(undefined);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function dedupeQualityFlags(qualityFlags: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const qualityFlag of qualityFlags) {
    if (seen.has(qualityFlag)) {
      continue;
    }
    seen.add(qualityFlag);
    deduped.push(qualityFlag);
  }
  return deduped;
}
