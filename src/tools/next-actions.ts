import { getToolSchema, validateToolParams } from "../tool-schema-registry.js";
import { isAliasToolName } from "./inventory.js";
import type { CatalogNextAction } from "./types.js";

// `<...>` tokens a caller must substitute (e.g. "<version>"). The JVM method
// names `<init>` and `<clinit>` are real values, not placeholders.
const PLACEHOLDER_PATTERN = /<(?!init>)(?!clinit>)[^<>]+>/;

const NO_STRINGS: ReadonlySet<string> = new Set();

/**
 * Whether `value` holds a `<...>` placeholder. A string in `requestStrings`
 * is a value the caller sent (a query such as `List<ItemStack>`, a file name
 * with angle brackets) that a follow-up call repeats, so it is not one.
 */
export function containsPlaceholder(value: unknown, requestStrings: ReadonlySet<string> = NO_STRINGS): boolean {
  if (typeof value === "string") {
    return !requestStrings.has(value) && PLACEHOLDER_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsPlaceholder(entry, requestStrings));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => containsPlaceholder(entry, requestStrings));
  }
  return false;
}

/** Every string value inside a parsed request, at any depth. */
export function requestStringValues(request: unknown): ReadonlySet<string> {
  const strings = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      strings.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(visit);
    }
  };
  visit(request);
  return strings;
}

/** A registered tool that is not a deprecated 8.x alias. */
export function isCallableCatalogTool(name: string): boolean {
  return !isAliasToolName(name) && getToolSchema(name) !== undefined;
}

/**
 * Keeps the follow-up calls a catalog reply may publish: each names a catalog
 * tool, and an executable entry carries no placeholder and validates against
 * that tool's registered schema. Template entries keep `template: true`.
 * `requestStrings` are the string values of the request being answered; a
 * follow-up that repeats one of them is not taken for a placeholder.
 */
export function finalizeNextActions(
  candidates: readonly CatalogNextAction[],
  requestStrings: ReadonlySet<string> = NO_STRINGS
): CatalogNextAction[] {
  const kept: CatalogNextAction[] = [];
  for (const candidate of candidates) {
    if (!isCallableCatalogTool(candidate.tool)) {
      continue;
    }
    const reason = candidate.reason !== undefined ? { reason: candidate.reason } : {};
    if (candidate.template === true) {
      kept.push({ tool: candidate.tool, params: candidate.params, ...reason, template: true });
      continue;
    }
    if (containsPlaceholder(candidate.params, requestStrings)) {
      continue;
    }
    if (!validateToolParams(candidate.tool, candidate.params).valid) {
      continue;
    }
    kept.push({ tool: candidate.tool, params: candidate.params, ...reason });
  }
  return kept;
}
