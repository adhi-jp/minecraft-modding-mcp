import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import fastGlob from "fast-glob";

import { buildVersionSourceSearchRoots } from "../../gradle-paths.js";
import type { DirectionIndex, PairKey } from "../internal-types.js";
import { effectiveLoomSearchProjectPath } from "../lookup.js";
import { parseTinyMappingsInto } from "../parsers/tiny.js";
import { resolveTinyIndexEntryBudget, selectTinyFiles } from "./tiny-loom-selection.js";
import type { MappingLoaderResult } from "./types.js";

const GLOB_SPECIAL_CHARS = /[\\!*+?()[\]{}@|]/g;

export async function loadTinyPairsFromLoom(
  version: string,
  projectPath?: string,
  gradleUserHome?: string
): Promise<MappingLoaderResult> {
  const searchRoots = buildVersionSourceSearchRoots({
    projectPath: effectiveLoomSearchProjectPath(projectPath),
    gradleUserHome
  });
  const discoveredPaths = new Set<string>();

  for (const root of searchRoots) {
    let discovered: string[] = [];
    const versionRoot = join(root, version);
    try {
      discovered = existsSync(versionRoot)
        ? await fastGlob.glob(["**/*.tiny", "**/*.tinyv2"], {
            cwd: versionRoot,
            absolute: true,
            onlyFiles: true
          })
        : await fastGlob.glob([`${version.replace(GLOB_SPECIAL_CHARS, "\\$&")}/**/*.tiny`, `${version.replace(GLOB_SPECIAL_CHARS, "\\$&")}/**/*.tinyv2`], {
            cwd: root,
            absolute: true,
            onlyFiles: true
          });
    } catch {
      continue;
    }
    for (const path of discovered) {
      if (path.replaceAll("\\", "/").includes(`/${version}/`)) {
        discoveredPaths.add(path);
      }
    }
  }

  const orderedPaths = [...discoveredPaths].sort((left, right) => left.localeCompare(right));
  if (orderedPaths.length === 0) {
    return {
      pairs: new Map(),
      warnings: [`No Loom tiny mapping files matched version "${version}".`],
      mappingArtifact: "loom-cache:none"
    };
  }

  // Read headers only, then drop byte-identical copies and descriptor-namespace
  // conflicts before any file body is loaded. See tiny-loom-selection.ts.
  const selection = await selectTinyFiles(orderedPaths);
  const warnings: string[] = [];
  const merged = new Map<PairKey, DirectionIndex>();
  const maxIndexEntries = resolveTinyIndexEntryBudget();
  const mergedPaths: string[] = [];
  let truncatedAt: string | undefined;

  for (const candidate of selection.selected) {
    if (truncatedAt) {
      break;
    }
    try {
      const content = await readFile(candidate.path, "utf8");
      const result = parseTinyMappingsInto(merged, content, { maxIndexEntries });
      if (result.parsed) {
        mergedPaths.push(candidate.path);
      }
      if (result.truncated) {
        truncatedAt = candidate.path;
      }
    } catch {
      // best effort: skip unreadable or invalid files
    }
  }

  if (truncatedAt) {
    const skipped = selection.selected.length - mergedPaths.length;
    warnings.push(
      `Loom tiny mappings for "${version}" hit the ${maxIndexEntries}-entry index budget while reading "${truncatedAt}"; ` +
        `${skipped} of ${selection.selected.length} selected file(s) were left unread and some symbols may be missing. ` +
        `Raise MCP_LOOM_TINY_MAX_INDEX_ENTRIES or start the server with a larger --max-old-space-size.`
    );
  }

  return {
    pairs: merged,
    warnings,
    // The richest merged file, not merely the alphabetically first discovered one.
    mappingArtifact: mergedPaths[0] ?? orderedPaths[0]!
  };
}
