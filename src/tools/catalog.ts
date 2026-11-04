import { COMPARISON_TOOL_SPECS } from "./families/comparison.js";
import { MOD_TOOL_SPECS } from "./families/mod.js";
import { NBT_TOOL_SPECS } from "./families/nbt.js";
import { OPERATIONS_TOOL_SPECS } from "./families/operations.js";
import { RESOLUTION_TOOL_SPECS } from "./families/resolution.js";
import { SEARCH_TOOL_SPECS } from "./families/search.js";
import { SOURCE_TOOL_SPECS } from "./families/source.js";
import { SYMBOL_TOOL_SPECS } from "./families/symbol.js";
import { VALIDATION_TOOL_SPECS } from "./families/validation.js";
import type { CatalogToolSpec } from "./types.js";

/**
 * The catalog tool specs, registered ahead of the deprecated 8.x tools. The
 * names here equal the catalog names in `inventory.ts`, in the same order.
 */
export const CATALOG_TOOL_SPECS: readonly CatalogToolSpec[] = [
  ...RESOLUTION_TOOL_SPECS,
  ...SOURCE_TOOL_SPECS,
  ...SEARCH_TOOL_SPECS,
  ...SYMBOL_TOOL_SPECS,
  ...COMPARISON_TOOL_SPECS,
  ...MOD_TOOL_SPECS,
  ...VALIDATION_TOOL_SPECS,
  ...NBT_TOOL_SPECS,
  ...OPERATIONS_TOOL_SPECS
];
