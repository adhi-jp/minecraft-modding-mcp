import { DETAIL_LEVELS, type DetailLevel } from "./schemas.js";
import type { CatalogDetailProjection } from "./types.js";

function rank(level: DetailLevel): number {
  return DETAIL_LEVELS.indexOf(level);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectRecord(
  record: Record<string, unknown>,
  projection: CatalogDetailProjection,
  level: DetailLevel
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const minimum = projection.minimumLevel[key];
    if (key !== "status" && minimum !== undefined && rank(level) < rank(minimum)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * The `result` with its primary payload projected for `level`: an object
 * payload loses the fields the projection reserves for higher levels, a list
 * payload loses them on each item. The payload key and `status` always stay.
 */
export function projectResultForDetail(
  result: Record<string, unknown>,
  primaryKey: string,
  projection: CatalogDetailProjection,
  level: DetailLevel
): Record<string, unknown> {
  const payload = result[primaryKey];
  if (Array.isArray(payload)) {
    return {
      ...result,
      [primaryKey]: payload.map((item) => (isPlainRecord(item) ? projectRecord(item, projection, level) : item))
    };
  }
  if (isPlainRecord(payload)) {
    return { ...result, [primaryKey]: projectRecord(payload, projection, level) };
  }
  return result;
}

/** The detail level of a parsed request, falling back to the projection's default. */
export function requestedDetail(input: unknown, projection: CatalogDetailProjection): DetailLevel {
  const detail = isPlainRecord(input) ? input.detail : undefined;
  return typeof detail === "string" && (DETAIL_LEVELS as readonly string[]).includes(detail)
    ? (detail as DetailLevel)
    : projection.default;
}
