import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import fastGlob from "fast-glob";

import { buildVersionSourceSearchRoots } from "../../gradle-paths.js";
import type { DirectionIndex, PairKey } from "../internal-types.js";
import { effectiveLoomSearchProjectPath } from "../lookup.js";
import { mergeDirectionIndexes } from "../parsers/symbol-records.js";
import { parseTinyMappings } from "../parsers/tiny.js";
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
  const merged = new Map<PairKey, DirectionIndex>();
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
    const byVersion = discovered
      .filter((path) => path.replaceAll("\\", "/").includes(`/${version}/`))
      .sort((left, right) => left.localeCompare(right));
    if (byVersion.length === 0) {
      continue;
    }

    for (const path of byVersion) {
      discoveredPaths.add(path);
      try {
        const content = await readFile(path, "utf8");
        const parsed = parseTinyMappings(content);
        for (const [key, index] of parsed.entries()) {
          const existing = merged.get(key);
          if (!existing) {
            merged.set(key, index);
          } else {
            mergeDirectionIndexes(existing, index);
          }
        }
      } catch {
        // best effort: skip unreadable or invalid files
      }
    }
  }

  const orderedPaths = [...discoveredPaths].sort((left, right) => left.localeCompare(right));
  if (orderedPaths.length > 0) {
    return {
      pairs: merged,
      warnings: [],
      mappingArtifact: orderedPaths[0]!
    };
  }

  return {
    pairs: new Map(),
    warnings: [`No Loom tiny mapping files matched version "${version}".`],
    mappingArtifact: "loom-cache:none"
  };
}
