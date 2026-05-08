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
