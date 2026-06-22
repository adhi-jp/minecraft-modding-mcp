import { defaultDownloadPath, downloadToCache } from "../../repo-downloader.js";
import { collectMatchedJarEntriesAsUtf8 } from "../../source-jar-reader.js";
import type { DirectionIndex, PairKey } from "../internal-types.js";
import { mergeDirectionIndexes } from "../parsers/symbol-records.js";
import { parseTinyMappings } from "../parsers/tiny.js";
import type { MappingLoaderDeps, MappingLoaderResult } from "./types.js";

async function fetchYarnCoordinates(
  fetchFn: typeof fetch,
  repoBase: string,
  version: string
): Promise<string[]> {
  const metadataUrl = `${repoBase}/net/fabricmc/yarn/maven-metadata.xml`;
  try {
    const response = await fetchFn(metadataUrl);
    if (!response.ok) {
      return [];
    }
    const xml = await response.text();
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((match) => match[1]?.trim() ?? "")
      .filter((value) => value.startsWith(`${version}+build.`));

    const sorted = versions.sort((left, right) => {
      const leftBuild = Number.parseInt(left.split("+build.")[1] ?? "0", 10);
      const rightBuild = Number.parseInt(right.split("+build.")[1] ?? "0", 10);
      return rightBuild - leftBuild;
    });

    if (sorted.length > 0) {
      return sorted.slice(0, 3);
    }
    return [version];
  } catch {
    return [version];
  }
}

async function parseTinyFromJar(jarPath: string): Promise<Map<PairKey, DirectionIndex>> {
  const tinyEntries = (await collectMatchedJarEntriesAsUtf8(
    jarPath,
    (entry) => entry.toLowerCase().endsWith(".tiny") || entry.toLowerCase().endsWith(".tinyv2"),
    { continueOnError: true }
  )).sort((left, right) => left.filePath.localeCompare(right.filePath));

  const merged = new Map<PairKey, DirectionIndex>();
  for (const entry of tinyEntries) {
    try {
      const parsed = parseTinyMappings(entry.content);
      for (const [key, index] of parsed.entries()) {
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, index);
        } else {
          mergeDirectionIndexes(existing, index);
        }
      }
    } catch {
      // skip malformed tiny entries
    }
  }

  return merged;
}

export async function loadTinyPairsFromMaven(
  deps: MappingLoaderDeps,
  version: string
): Promise<MappingLoaderResult> {
  const warnings: string[] = [];
  const merged = new Map<PairKey, DirectionIndex>();

  const repos = deps.config.sourceRepos;
  const attemptedUrls: string[] = [];

  const repoBases = repos.map((repo) => repo.replace(/\/+$/, ""));
  const yarnCoordinatesByRepo = await Promise.all(
    repoBases.map(async (base) => ({
      base,
      yarnCoordinates: await fetchYarnCoordinates(deps.fetchFn, base, version)
    }))
  );

  const tryUrls = async (urls: string[]): Promise<Map<PairKey, DirectionIndex> | undefined> => {
    for (const url of urls) {
      attemptedUrls.push(url);
      try {
        const downloaded = await downloadToCache(url, defaultDownloadPath(deps.config.cacheDir, url), {
          fetchFn: deps.fetchFn,
          retries: deps.config.fetchRetries,
          timeoutMs: deps.config.fetchTimeoutMs
        });
        if (!downloaded.ok || !downloaded.path) {
          continue;
        }
        const parsed = await parseTinyFromJar(downloaded.path);
        if (parsed.size > 0) {
          return parsed;
        }
      } catch {
        // try the next candidate URL
      }
    }
    return undefined;
  };

  let intermediaryParsed: Map<PairKey, DirectionIndex> | undefined;
  let yarnParsed: Map<PairKey, DirectionIndex> | undefined;
  for (const { base, yarnCoordinates } of yarnCoordinatesByRepo) {
    if (!intermediaryParsed) {
      intermediaryParsed = await tryUrls([
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}-v2.jar`,
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}.jar`
      ]);
    }

    for (const coordinate of yarnCoordinates) {
      if (yarnParsed) {
        break;
      }
      yarnParsed = await tryUrls([
        `${base}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}-v2.jar`,
        `${base}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}.jar`
      ]);
    }

    if (intermediaryParsed && yarnParsed) {
      break;
    }
  }

  for (const parsed of [intermediaryParsed, yarnParsed]) {
    if (!parsed) {
      continue;
    }
    for (const [key, index] of parsed.entries()) {
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, index);
      } else {
        mergeDirectionIndexes(existing, index);
      }
    }
  }

  if (merged.size === 0) {
    warnings.push(`No Maven tiny mappings could be loaded for "${version}".`);
  }

  return {
    pairs: merged,
    warnings,
    mappingArtifact: attemptedUrls[0] ?? "maven:none"
  };
}
