import type { Config } from "../../types.js";
import type { VersionService } from "../../version-service.js";
import type { DirectionIndex, PairKey } from "../internal-types.js";

export type VersionMappingsResolver = Pick<VersionService, "resolveVersionMappings">;

export type MappingLoaderDeps = {
  config: Config;
  fetchFn: typeof fetch;
  versionService: VersionMappingsResolver;
};

export type MappingLoaderResult = {
  pairs: Map<PairKey, DirectionIndex>;
  warnings: string[];
  mappingArtifact: string;
  /**
   * True when the source failed in a way a later attempt may not repeat (a
   * network fault, a 5xx or 429 answer), so the result must not be cached.
   */
  transient?: boolean;
};
