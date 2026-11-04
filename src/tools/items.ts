import { isAppError } from "../errors.js";
import { mapErrorToProblem } from "../tool-guidance.js";
import { containsPlaceholder } from "./next-actions.js";
import { reportedFailure, SUGGESTION_FALLBACK_HINT } from "./runner.js";
import { translateServiceSuggestedCall, translateToolNamesInText } from "./translation.js";
import type { CatalogCall, CatalogNextAction, CatalogStatus } from "./types.js";

/**
 * Work items: the building blocks of tools that take 1 to 50 items (classes,
 * symbols) and answer each in its own `result.items` entry with a status. A
 * failing item carries its error inside the entry; the call itself fails only
 * on invalid input or a shared context (the target) that cannot be set up.
 */

/** The record without its `undefined` fields. */
export function defined<T extends Record<string, unknown>>(record: T): Partial<T> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) kept[key] = value;
  }
  return kept as Partial<T>;
}

export type CatalogItemError = {
  code: string;
  detail: string;
  retryClass?: string;
  issueOrigin?: string;
  hints?: string[];
  didYouMean?: unknown;
};

/** An item that failed: its identifying fields, a status, and the error. */
export type FailedItem<TIdentity extends Record<string, unknown>> = TIdentity & {
  status: CatalogStatus;
  error: CatalogItemError;
};

/**
 * Collects the follow-up calls of one reply: catalog calls built by the
 * family, and service suggestions translated to catalog calls (a suggestion
 * with placeholders becomes a template). The runner validates them all.
 */
export class FollowUps {
  private readonly entries: CatalogNextAction[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly tool: string) {}

  add(action: CatalogNextAction): void {
    const key = JSON.stringify([action.tool, action.params]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.entries.push(action);
  }

  addServiceCall(call: { tool: string; params: Record<string, unknown>; reason?: string } | undefined): void {
    if (call === undefined) return;
    const translated = translateServiceSuggestedCall(call, this.tool);
    if (translated === undefined) return;
    this.add(containsPlaceholder(translated.params) && translated.template !== true ? { ...translated, template: true } : translated);
  }

  list(): CatalogNextAction[] {
    return [...this.entries];
  }
}

/**
 * The item for a work item whose service call failed. A service error keeps
 * its recovery data: hints and near-miss classes on the item's error,
 * suggested and example calls as next actions. Any other error is reported
 * like the runner reports it (`ERR_DB_FAILURE` for a SQLite corruption,
 * `ERR_INTERNAL` otherwise), but only for this item. `statusOf` maps the
 * error code to the item's status.
 */
export function failedItem<TIdentity extends Record<string, unknown>>(
  identity: TIdentity,
  caught: unknown,
  call: CatalogCall,
  followUps: FollowUps,
  statusOf: (code: string) => CatalogStatus
): FailedItem<TIdentity> {
  const reported = isAppError(caught) ? caught : reportedFailure(caught, call.tool, call.requestId, call.sqlitePath);
  const problem = mapErrorToProblem(reported, call.requestId, { tool: call.tool });
  followUps.addServiceCall(problem.suggestedCall);
  for (const example of problem.exampleCalls ?? []) followUps.addServiceCall(example);
  const hints = (problem.hints ?? [])
    .filter((hint) => hint !== SUGGESTION_FALLBACK_HINT)
    .map((hint) => translateToolNamesInText(hint, call.tool));
  return {
    ...identity,
    status: statusOf(problem.code),
    error: {
      code: problem.code,
      detail: translateToolNamesInText(problem.detail, call.tool),
      retryClass: problem.retryClass,
      issueOrigin: problem.issueOrigin,
      ...(hints.length > 0 ? { hints } : {}),
      ...(problem.didYouMean !== undefined && problem.didYouMean.length > 0 ? { didYouMean: problem.didYouMean } : {})
    }
  };
}

/** `counts` of a work-item reply; `failed` counts the items that carry an `error`. */
export function itemCounts(items: ReadonlyArray<{ status: CatalogStatus; error?: unknown }>) {
  return {
    total: items.length,
    ok: items.filter((item) => item.status === "ok").length,
    failed: items.filter((item) => item.error !== undefined).length
  };
}
