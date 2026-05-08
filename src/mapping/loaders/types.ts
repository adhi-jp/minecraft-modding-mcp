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
};
