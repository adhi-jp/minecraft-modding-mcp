import { retryClassForErrorCode } from "../../error-mapping.js";
import { isAppError } from "../../errors.js";
import {
  defaultDownloadPath,
  downloadToCache,
  isDefinitiveRejection,
  type DownloadResult
} from "../../repo-downloader.js";
import { loadMaxNestedJarEntryBytes } from "../../source/nested-jars.js";
import { collectMatchedJarEntriesAsUtf8 } from "../../source-jar-reader.js";
import type { DirectionIndex, PairKey } from "../internal-types.js";
import { mergeDirectionIndexes } from "../parsers/symbol-records.js";
import { parseTinyMappingsInto } from "../parsers/tiny.js";
import type { MappingLoaderDeps, MappingLoaderResult } from "./types.js";

type YarnCoordinatesOutcome = {
  coordinates: string[];
  /** True when the build list could not be read for a reason a later attempt may not repeat. */
  transient: boolean;
};

async function fetchYarnCoordinatesOutcome(
  fetchFn: typeof fetch,
  repoBase: string,
  version: string,
  fallback: string[],
  timeoutMs: number
): Promise<YarnCoordinatesOutcome> {
  const metadataUrl = `${repoBase}/net/fabricmc/yarn/maven-metadata.xml`;
  // One signal bounds both the response and reading its body.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const response = await fetchFn(metadataUrl, { signal: timeout.signal });
    if (!response.ok) {
      return { coordinates: [], transient: !isDefinitiveRejection(response.status) };
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
      return { coordinates: sorted.slice(0, 3), transient: false };
    }
    return { coordinates: fallback, transient: false };
  } catch {
    return { coordinates: fallback, transient: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchYarnCoordinates(
  fetchFn: typeof fetch,
  repoBase: string,
  version: string,
  fallback: string[],
  timeoutMs: number
): Promise<string[]> {
  return (await fetchYarnCoordinatesOutcome(fetchFn, repoBase, version, fallback, timeoutMs)).coordinates;
}

/**
 * `maxEntryBytes` reuses the same ceiling as nested-jar extraction
 * ({@link loadMaxNestedJarEntryBytes}): the downloaded jar is itself
 * download-size-capped, but a single `.tiny`/`.tinyv2` entry inside it is
 * decompressed in full before parsing, so an entry with a small compressed
 * size and a huge inflated size (zip-bomb style) must still be bounded here.
 */
export async function parseTinyFromJar(
  jarPath: string,
  maxEntryBytes: number = loadMaxNestedJarEntryBytes()
): Promise<Map<PairKey, DirectionIndex>> {
  const tinyEntries = (await collectMatchedJarEntriesAsUtf8(
    jarPath,
    (entry) => entry.toLowerCase().endsWith(".tiny") || entry.toLowerCase().endsWith(".tinyv2"),
    { continueOnError: true, maxBytes: maxEntryBytes }
  )).sort((left, right) => left.filePath.localeCompare(right.filePath));

  // Parsed straight into the shared accumulator: a parse-then-merge loop would
  // hold each entry's full index alongside the accumulated one. `ensurePairIndex`
  // + `addLookupEntries` union into what is already there, matching what
  // `mergeDirectionIndexes` did.
  const merged = new Map<PairKey, DirectionIndex>();
  for (const entry of tinyEntries) {
    try {
      parseTinyMappingsInto(merged, entry.content);
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
      outcome: await fetchYarnCoordinatesOutcome(
        deps.fetchFn,
        base,
        version,
        [version],
        deps.config.fetchTimeoutMs
      )
    }))
  );

  // Only a download can fail transiently: a jar that downloaded but yields no
  // pairs gives the same result on every attempt.
  const transientArtifacts = new Set<"intermediary" | "yarn">();
  const tryUrls = async (
    artifact: "intermediary" | "yarn",
    urls: string[]
  ): Promise<Map<PairKey, DirectionIndex> | undefined> => {
    for (const url of urls) {
      attemptedUrls.push(url);
      let downloaded: DownloadResult;
      try {
        downloaded = await downloadToCache(url, defaultDownloadPath(deps.config.cacheDir, url), {
          fetchFn: deps.fetchFn,
          retries: deps.config.fetchRetries,
          timeoutMs: deps.config.fetchTimeoutMs
        });
      } catch (caughtError) {
        if (!isAppError(caughtError) || retryClassForErrorCode(caughtError.code) === "transient") {
          transientArtifacts.add(artifact);
        }
        continue;
      }
      if (!downloaded.ok || !downloaded.path) {
        if (!isDefinitiveRejection(downloaded.statusCode)) {
          transientArtifacts.add(artifact);
        }
        continue;
      }
      try {
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
  for (const { base, outcome } of yarnCoordinatesByRepo) {
    if (!intermediaryParsed) {
      intermediaryParsed = await tryUrls("intermediary", [
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}-v2.jar`,
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}.jar`
      ]);
    }

    for (const coordinate of outcome.coordinates) {
      if (yarnParsed) {
        break;
      }
      yarnParsed = await tryUrls("yarn", [
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

  const yarnMetadataTransient = yarnCoordinatesByRepo.some(({ outcome }) => outcome.transient);
  return {
    pairs: merged,
    warnings,
    mappingArtifact: attemptedUrls[0] ?? "maven:none",
    transient:
      (!intermediaryParsed && transientArtifacts.has("intermediary")) ||
      (!yarnParsed && (transientArtifacts.has("yarn") || yarnMetadataTransient))
  };
}
