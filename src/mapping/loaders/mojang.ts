import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { downloadToCache } from "../../repo-downloader.js";
import type { ResolvedVersionMappings } from "../../version-service.js";
import { parseClientMappings } from "../parsers/proguard.js";
import type { MappingLoaderDeps, MappingLoaderResult } from "./types.js";

export async function loadMojangPairs(
  deps: MappingLoaderDeps,
  version: string
): Promise<MappingLoaderResult> {
  const warnings: string[] = [];
  let metadata: ResolvedVersionMappings;
  try {
    metadata = await deps.versionService.resolveVersionMappings(version);
  } catch (caughtError) {
    return {
      pairs: new Map(),
      warnings: [
        `Failed to resolve version metadata for "${version}": ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`
      ],
      mappingArtifact: `version:${version}`
    };
  }

  const clientMappingsUrl = metadata.clientMappingsUrl ?? metadata.mappingsUrl;
  if (!clientMappingsUrl) {
    warnings.push(`Minecraft version "${version}" does not expose client mappings URL.`);
    return {
      pairs: new Map(),
      warnings,
      mappingArtifact: metadata.versionDetailUrl
    };
  }

  const mappingsPath = join(deps.config.cacheDir, "mappings", version, "client_mappings.txt");
  if (!existsSync(mappingsPath)) {
    await mkdir(dirname(mappingsPath), { recursive: true });
    const downloaded = await downloadToCache(clientMappingsUrl, mappingsPath, {
      fetchFn: deps.fetchFn,
      retries: deps.config.fetchRetries,
      timeoutMs: deps.config.fetchTimeoutMs
    });
    if (!downloaded.ok || !downloaded.path) {
      warnings.push(
        `Failed to download client mappings from "${clientMappingsUrl}" (status: ${downloaded.statusCode ?? "unknown"}).`
      );
      return {
        pairs: new Map(),
        warnings,
        mappingArtifact: clientMappingsUrl
      };
    }
  }

  try {
    const content = await readFile(mappingsPath, "utf8");
    return {
      pairs: parseClientMappings(content),
      warnings,
      mappingArtifact: clientMappingsUrl
    };
  } catch (caughtError) {
    warnings.push(
      `Failed to parse client mappings for "${version}": ${
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      }`
    );
    return {
      pairs: new Map(),
      warnings,
      mappingArtifact: clientMappingsUrl
    };
  }
}
