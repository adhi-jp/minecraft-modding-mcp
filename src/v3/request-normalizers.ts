import { createError, ERROR_CODES } from "../errors.js";
import type { DetailLevel, NextAction } from "./response-contract.js";
import { normalizeIncludeGroups } from "./response-contract.js";

export function resolveDetail(detail: DetailLevel | undefined): DetailLevel {
  return detail ?? "summary";
}

export function resolveInclude(include: readonly string[] | undefined): string[] {
  return normalizeIncludeGroups(include);
}

export function normalizeReadOnlyExecutionMode(
  action: string,
  executionMode: "preview" | "apply" | undefined
): "preview" | "apply" {
  if (action === "summary" || action === "list" || action === "inspect" || action === "verify") {
    return "preview";
  }
  return executionMode ?? "preview";
}

export function capArray<T>(
  values: readonly T[],
  maxItems: number
): { items: T[]; truncated: boolean } {
  if (values.length <= maxItems) {
    return { items: [...values], truncated: false };
  }
  return {
    items: [...values.slice(0, maxItems)],
    truncated: true
  };
}

export function requireNonEmptyObject(
  selector: Record<string, unknown> | undefined,
  message: string
): Record<string, unknown> {
  if (!selector || Object.keys(selector).length === 0) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message
    });
  }
  return selector;
}

export function nextActionsOrUndefined(actions: NextAction[]): NextAction[] | undefined {
  return actions.length > 0 ? actions : undefined;
}
