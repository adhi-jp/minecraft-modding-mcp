import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { ZodError, z } from "zod";

import { problemClassification, type ProblemDetails, type ProblemFieldError } from "../error-mapping.js";
import { ERROR_CODES, isAppError } from "../errors.js";
import { log } from "../logger.js";
import { objectResult } from "../mcp-helpers.js";
import { suggestSimilar } from "../mixin/helpers.js";
import { convertRuntimeSqliteCorruption } from "../storage/db.js";
import { applyErrorMetaExtensions, mapErrorToProblem, type ToolMeta } from "../tool-guidance.js";
import { projectResultForDetail, requestedDetail } from "./detail.js";
import { containsPlaceholder, finalizeNextActions, requestStringValues } from "./next-actions.js";
import { targetFieldsForKind } from "./schemas.js";
import { translateServiceSuggestedCall, translateToolNamesInText } from "./translation.js";
import type {
  CatalogHandlerOutput,
  CatalogNextAction,
  CatalogRuntime,
  CatalogToolSpec,
  CatalogWarning
} from "./types.js";
import { buildCatalogWarnings } from "./warnings.js";

/**
 * The hint mapErrorToProblem appends when a service suggestion failed schema
 * validation. It describes an internal fallback, so catalog replies drop it.
 */
export const SUGGESTION_FALLBACK_HINT = "suggested call payload failed schema validation; using fallback examples";

export type CatalogFieldError = ProblemFieldError & { suggestions?: string[] };

export type CatalogMeta = {
  requestId: string;
  tool: string;
  durationMs: number;
  warnings?: CatalogWarning[];
  nextActions?: CatalogNextAction[];
  pagination?: CatalogHandlerOutput["pagination"];
  truncation?: CatalogHandlerOutput["truncation"];
  stageBudgetExhausted?: boolean;
  budgetMs?: number;
  elapsedMs?: number;
};

function buildRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Runs one catalog tool call: strict validation, the shared heavy-tool gate,
 * per-tool call metrics, and the catalog `{ result, meta }` / `{ error, meta }`
 * envelope with structured warnings and validated next actions.
 */
export async function runCatalogTool<TInput>(
  spec: CatalogToolSpec<TInput>,
  rawInput: unknown,
  runtime: CatalogRuntime,
  serverContext?: ServerContext
): Promise<CallToolResult> {
  const tool = spec.name;
  const requestId = buildRequestId();
  const startedAt = Date.now();

  try {
    const input = spec.inputSchema.parse(rawInput);
    const call = {
      tool,
      requestId,
      services: runtime.services,
      config: runtime.config,
      sqlitePath: runtime.sqlitePath,
      ...(serverContext !== undefined ? { serverContext } : {}),
      ...(runtime.stageEmitterFor !== undefined ? { stageEmitter: runtime.stageEmitterFor(serverContext) } : {})
    };
    const output = await (
      runtime.isHeavy(tool)
        ? runtime.heavyGate.run(tool, () => spec.handler(input, call))
        : spec.handler(input, call)
    );
    const durationMs = Date.now() - startedAt;
    runtime.recordToolCall(tool, durationMs);

    const warnings = buildCatalogWarnings(output.warnings ?? [], tool);
    const serviceActions = (output.serviceSuggestedCalls ?? [])
      .map((suggestion) => translateServiceSuggestedCall(suggestion, tool))
      .filter((action): action is CatalogNextAction => action !== undefined);
    const handlerActions = (output.nextActions ?? []).map((action) =>
      action.reason === undefined ? action : { ...action, reason: translateToolNamesInText(action.reason, tool) }
    );
    // The request's strings are collected only when there is a follow-up to
    // check: a large data document (an NBT tree) is otherwise walked for nothing.
    const candidates = [...handlerActions, ...serviceActions];
    const nextActions = candidates.length > 0 ? finalizeNextActions(candidates, requestStringValues(input)) : [];
    const meta: CatalogMeta = {
      requestId,
      tool,
      durationMs,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(nextActions.length > 0 ? { nextActions } : {}),
      ...(output.pagination !== undefined ? { pagination: output.pagination } : {}),
      ...(output.truncation !== undefined && output.truncation.length > 0
        ? { truncation: output.truncation }
        : {})
    };
    const result =
      spec.detailProjection !== undefined && spec.primaryKey !== undefined
        ? projectResultForDetail(
            output.result,
            spec.primaryKey,
            spec.detailProjection,
            requestedDetail(input, spec.detailProjection)
          )
        : output.result;
    return objectResult({ result, meta });
  } catch (caughtError) {
    let reportedError: unknown = caughtError;
    let problem: ProblemDetails;
    let nextActions: CatalogNextAction[] = [];
    if (caughtError instanceof ZodError) {
      problem = invalidInputProblem(caughtError, spec.inputSchema, rawInput, requestId);
    } else {
      reportedError = reportedFailure(caughtError, tool, requestId, runtime.sqlitePath);
      const mapped = moveSuggestionsToNextActions(
        mapErrorToProblem(reportedError, requestId, { tool, normalizedInput: rawInput }),
        tool
      );
      problem = mapped.problem;
      nextActions = mapped.nextActions;
    }

    const durationMs = Date.now() - startedAt;
    runtime.recordToolCall(tool, durationMs);
    const extensionMeta: ToolMeta = { requestId, tool, durationMs };
    applyErrorMetaExtensions(extensionMeta, reportedError);
    const meta: CatalogMeta = {
      requestId,
      tool,
      durationMs,
      ...(extensionMeta.stageBudgetExhausted !== undefined
        ? { stageBudgetExhausted: extensionMeta.stageBudgetExhausted }
        : {}),
      ...(extensionMeta.budgetMs !== undefined ? { budgetMs: extensionMeta.budgetMs } : {}),
      ...(extensionMeta.elapsedMs !== undefined ? { elapsedMs: extensionMeta.elapsedMs } : {}),
      ...(nextActions.length > 0 ? { nextActions } : {})
    };
    return objectResult({ error: problem, meta }, { isError: true });
  }
}

/**
 * Moves the problem's `suggestedCall` and `exampleCalls` into translated,
 * validated next actions, removes the internal fallback hint, and translates
 * 8.x tool names in the problem's prose (`detail`, `hints`, field-error
 * messages). Data fields such as `nestedJars`, `didYouMean`, `context`, paths
 * and `type` keep their values.
 */
function moveSuggestionsToNextActions(
  problem: ProblemDetails,
  tool: string
): { problem: ProblemDetails; nextActions: CatalogNextAction[] } {
  const { suggestedCall, exampleCalls, hints, ...rest } = problem;
  const candidates: CatalogNextAction[] = [];
  if (suggestedCall !== undefined) {
    const translated = translateServiceSuggestedCall(suggestedCall, tool);
    if (translated !== undefined) candidates.push(translated);
  }
  for (const example of exampleCalls ?? []) {
    const translated = translateServiceSuggestedCall(example, tool);
    if (translated === undefined) continue;
    candidates.push(containsPlaceholder(translated.params) ? { ...translated, template: true } : translated);
  }
  const keptHints = (hints ?? [])
    .filter((hint) => hint !== SUGGESTION_FALLBACK_HINT)
    .map((hint) => translateToolNamesInText(hint, tool));
  const cleaned: ProblemDetails = {
    ...rest,
    detail: translateToolNamesInText(rest.detail, tool),
    ...(rest.fieldErrors !== undefined
      ? {
          fieldErrors: rest.fieldErrors.map((fieldError) => ({
            ...fieldError,
            message: translateToolNamesInText(fieldError.message, tool)
          }))
        }
      : {}),
    ...(keptHints.length > 0 ? { hints: keptHints } : {})
  };
  for (const key of Object.keys(cleaned) as Array<keyof ProblemDetails>) {
    if (cleaned[key] === undefined) delete cleaned[key];
  }
  return { problem: cleaned, nextActions: finalizeNextActions(candidates) };
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.length > 0 ? path.map(String).join(".") : "$";
}

/**
 * Maps a validation failure to `ERR_INVALID_INPUT` with one `fieldErrors`
 * entry per problem; an unknown key is named by its full path and carries
 * the declared keys of its object within edit distance 3 as `suggestions`.
 * Under `target`, the keys compared are `kind` and the fields of the
 * request's `target.kind` (every declared key when the kind is missing or
 * not one the tool takes), and the 8.x locator `value` is answered with that
 * kind's locator fields.
 */
function invalidInputProblem(error: ZodError, schema: z.ZodType, rawInput: unknown, requestId: string): ProblemDetails {
  const fieldErrors: CatalogFieldError[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      const objectSchema = schemaAt(schema, issue.path);
      const kind = kindAt(rawInput, issue.path);
      const target = targetFieldsForKind(objectSchema, kind);
      const declared = target?.keys ?? (objectSchema instanceof z.ZodObject ? Object.keys(objectSchema.shape) : []);
      for (const key of issue.keys) {
        const path = formatPath([...issue.path, key]);
        if (key === "value" && target !== undefined) {
          const locators = [...target.locators];
          fieldErrors.push({
            path,
            code: "unrecognized_keys",
            message: `Unknown key "value"; target kind "${String(kind)}" takes ${locators.map((entry) => `"${entry}"`).join(" and ")} instead.`,
            suggestions: locators
          });
          continue;
        }
        const suggestions = suggestSimilar(key, declared);
        fieldErrors.push({
          path,
          code: "unrecognized_keys",
          message: suggestions.length > 0
            ? `Unknown key "${key}"; did you mean ${suggestions.map((entry) => `"${entry}"`).join(" or ")}?`
            : `Unknown key "${key}".`,
          ...(suggestions.length > 0 ? { suggestions } : {})
        });
      }
      continue;
    }
    fieldErrors.push({ path: formatPath(issue.path), code: issue.code, message: issue.message });
  }
  return {
    type: "https://minecraft-modding-mcp.dev/problems/invalid-input",
    title: "Invalid input",
    detail: "Request validation failed.",
    status: 400,
    code: ERROR_CODES.INVALID_INPUT,
    instance: requestId,
    ...problemClassification(ERROR_CODES.INVALID_INPUT, undefined),
    fieldErrors,
    hints: ["Fix the keys named in fieldErrors; unknown keys are rejected, not ignored."]
  };
}

/** Peels wrappers that do not change an object's keys (optional, default, preprocessing, ...). */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  for (;;) {
    const def = (current as unknown as { def?: Record<string, unknown> }).def;
    if (def?.innerType instanceof z.ZodType) {
      current = def.innerType;
      continue;
    }
    if (current instanceof z.ZodPipe) {
      current = (current.def.in instanceof z.ZodTransform ? current.def.out : current.def.in) as z.ZodType;
      continue;
    }
    return current;
  }
}

/** The schema of the value at `path`, its wrappers peeled, or undefined when the path leaves the schema. */
function schemaAt(schema: z.ZodType, path: ReadonlyArray<PropertyKey>): z.ZodType | undefined {
  let current: z.ZodType | undefined = unwrapSchema(schema);
  for (const segment of path) {
    if (current instanceof z.ZodObject) {
      const next: z.ZodType | undefined = (current.shape as Record<string, z.ZodType>)[String(segment)];
      current = next === undefined ? undefined : unwrapSchema(next);
    } else if (current instanceof z.ZodArray) {
      current = unwrapSchema(current.element as z.ZodType);
    } else {
      current = undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** The `kind` the request gave the object at `path`, if any. */
function kindAt(rawInput: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = rawInput;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return typeof current === "object" && current !== null ? (current as Record<string, unknown>).kind : undefined;
}

/**
 * The error a failure is reported as: a raw SQLite corruption error becomes
 * `ERR_DB_FAILURE` (and schedules the full check); every failure is logged.
 */
export function reportedFailure(caughtError: unknown, tool: string, requestId: string, sqlitePath: string): unknown {
  const reportedError = convertRuntimeSqliteCorruption(caughtError, sqlitePath);
  logFailure(tool, requestId, caughtError, reportedError);
  return reportedError;
}

function logFailure(tool: string, requestId: string, caughtError: unknown, reportedError: unknown): void {
  if (reportedError !== caughtError) {
    // The public envelope carries only the generic database failure; the raw
    // SQLite diagnostic is kept server-side.
    const raw = caughtError as { message?: unknown; code?: unknown; errcode?: unknown };
    log("error", "tool.call.sqlite_runtime_corruption", {
      requestId,
      tool,
      message: typeof raw?.message === "string" ? raw.message : String(caughtError),
      code: raw?.code,
      errcode: raw?.errcode
    });
  }
  if (isAppError(reportedError)) {
    const severe =
      reportedError.code === ERROR_CODES.DB_FAILURE ||
      reportedError.code === ERROR_CODES.REPO_FETCH_FAILED ||
      reportedError.code === ERROR_CODES.REGISTRY_GENERATION_FAILED ||
      reportedError.code === ERROR_CODES.JAVA_UNAVAILABLE ||
      reportedError.code.startsWith("ERR_DECOMPILER");
    log(severe ? "error" : "warn", severe ? "tool.call.failed" : "tool.call.warning", {
      requestId,
      tool,
      code: reportedError.code,
      message: reportedError.message
    });
    return;
  }
  log("error", "tool.call.unhandled", {
    requestId,
    tool,
    reason: reportedError instanceof Error ? reportedError.message : String(reportedError)
  });
}
