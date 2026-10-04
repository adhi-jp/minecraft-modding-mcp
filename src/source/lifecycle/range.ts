import { buildSuggestedCall } from "../../build-suggested-call.js";
import { ERROR_CODES, createError } from "../../errors.js";
import type { SourceService } from "../../source-service.js";

export type ManifestRange = {
  /** Manifest version ids, oldest first. */
  chronological: string[];
  fromVersion: string;
  toVersion: string;
  fromIndex: number;
  toIndex: number;
};

/**
 * Locates a from/to version pair in the manifest, oldest first. An omitted
 * endpoint defaults to the oldest (from) or newest (to) manifest entry. Throws
 * VERSION_NOT_FOUND for an empty manifest or an unknown endpoint, and
 * INVALID_INPUT when fromVersion is newer than toVersion.
 */
export async function resolveManifestRange(
  svc: SourceService,
  input: { fromVersion?: string; toVersion?: string; includeSnapshots?: boolean }
): Promise<ManifestRange> {
  const { includeSnapshots } = input;
  const manifestOrder = includeSnapshots === undefined
    ? await svc.versionService.listVersionIds()
    : await svc.versionService.listVersionIds({ includeSnapshots });
  if (manifestOrder.length === 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: "No Minecraft versions were returned by manifest.",
      details: {
        ...(includeSnapshots === undefined ? {} : { includeSnapshots }),
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }

  const chronological = [...manifestOrder].reverse();
  const fromVersion = input.fromVersion ?? chronological[0];
  const toVersion = input.toVersion ?? chronological[chronological.length - 1];
  const fromIndex = chronological.indexOf(fromVersion);
  const toIndex = chronological.indexOf(toVersion);

  if (fromIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `fromVersion "${fromVersion}" was not found in manifest.`,
      details: {
        fromVersion,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (toIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `toVersion "${toVersion}" was not found in manifest.`,
      details: {
        toVersion,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (fromIndex > toIndex) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "fromVersion must be older than or equal to toVersion.",
      details: { fromVersion, toVersion }
    });
  }

  return { chronological, fromVersion, toVersion, fromIndex, toIndex };
}
