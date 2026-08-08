import { z } from "zod";

import { CANONICAL_INCLUDE_GROUPS, DETAIL_LEVELS } from "./response-contract.js";
import { zod3ParityIntCheck } from "../tool-schemas.js";

export const detailSchema = z.enum(DETAIL_LEVELS);
export const includeGroupSchema = z.enum(CANONICAL_INCLUDE_GROUPS);
export const executionModeSchema = z.enum(["preview", "apply"]);
// zod3-parity: same acceptance/error contract as tool-schemas' optionalPositiveInt
// (zod4's .int() rejects unsafe integers and reworded the float error).
export const positiveIntSchema = z.number().check(zod3ParityIntCheck).positive();

export function buildIncludeSchema(allowed: readonly string[]) {
  return z.array(z.enum(allowed as [string, ...string[]])).optional();
}
