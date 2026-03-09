import { z } from "zod";

import { CANONICAL_INCLUDE_GROUPS, DETAIL_LEVELS } from "./response-contract.js";

export const detailSchema = z.enum(DETAIL_LEVELS);
export const includeGroupSchema = z.enum(CANONICAL_INCLUDE_GROUPS);
export const executionModeSchema = z.enum(["preview", "apply"]);
export const positiveIntSchema = z.number().int().positive();

export function buildIncludeSchema(allowed: readonly string[]) {
  return z.array(z.enum(allowed as [string, ...string[]])).optional();
}
