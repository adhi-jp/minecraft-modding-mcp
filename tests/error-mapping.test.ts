import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, createError } from "../src/errors.ts";
import {
  errorToBatchEntryProblem,
  extractAllowlistedContext,
  issueOriginForErrorCode,
  retryClassForErrorCode,
  statusForErrorCode
} from "../src/error-mapping.ts";

test("issueOriginForErrorCode separates caller input from tool capability and environment", () => {
  assert.equal(issueOriginForErrorCode(ERROR_CODES.INVALID_INPUT), "code_issue");
  assert.equal(issueOriginForErrorCode(ERROR_CODES.CLASS_NOT_FOUND), "code_issue");
  assert.equal(issueOriginForErrorCode(ERROR_CODES.MAPPING_UNAVAILABLE), "tool_issue");
  assert.equal(issueOriginForErrorCode(ERROR_CODES.JAVA_UNAVAILABLE), "environment");
});

test("errorToBatchEntryProblem attaches issueOrigin and allowlisted context", () => {
  const problem = errorToBatchEntryProblem(
    createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "query too long",
      details: { queryLength: 5000, maxLength: 1000, jarPath: "/home/secret/x.jar" }
    }),
    "test-context"
  );
  assert.equal(problem.issueOrigin, "code_issue");
  assert.deepEqual(problem.context, { queryLength: 5000, maxLength: 1000 });
  // Filesystem paths are not allowlisted and must not leak into context.
  assert.equal((problem.context as Record<string, unknown>)?.jarPath, undefined);
});

test("extractAllowlistedContext drops unknown and non-primitive fields", () => {
  const context = extractAllowlistedContext({
    artifactId: "mc-1.21.10",
    queryLength: 42,
    filePath: "/secret/path",
    nested: { a: 1 }
  });
  assert.deepEqual(context, { artifactId: "mc-1.21.10", queryLength: 42 });
});

test("retryClassForErrorCode classifies the four recovery families", () => {
  assert.equal(retryClassForErrorCode(ERROR_CODES.JAVA_UNAVAILABLE), "environment");
  assert.equal(retryClassForErrorCode(ERROR_CODES.REPO_FETCH_FAILED), "transient");
  assert.equal(retryClassForErrorCode(ERROR_CODES.INVALID_INPUT), "input");
  assert.equal(retryClassForErrorCode(ERROR_CODES.CLASS_NOT_FOUND), "permanent");
});

test("retryClassForErrorCode classifies non-recoverable server faults as 'server'", () => {
  // Deterministic internal failures are not transient: retrying the identical
  // call cannot help, so they must not be advertised as retryable.
  assert.equal(retryClassForErrorCode(ERROR_CODES.INTERNAL), "server");
  assert.equal(retryClassForErrorCode(ERROR_CODES.DB_FAILURE), "server");
});

test("retryClassForErrorCode keeps genuinely-transient codes transient (scope guard)", () => {
  // The conservative reclassification (INTERNAL + DB_FAILURE -> server) must NOT
  // spill onto codes that a later retry can legitimately resolve.
  for (const code of [
    ERROR_CODES.REPO_FETCH_FAILED,
    ERROR_CODES.ARTIFACT_RESOLUTION_FAILED,
    ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
    ERROR_CODES.LIMIT_EXCEEDED,
    ERROR_CODES.JAVA_PROCESS_FAILED
  ]) {
    assert.equal(retryClassForErrorCode(code), "transient", `${code} must stay transient`);
  }
  // An unknown code still falls through to the transient catch-all.
  assert.equal(retryClassForErrorCode("ERR_DOES_NOT_EXIST"), "transient");
});

test("errorToBatchEntryProblem labels a non-AppError as a non-retryable server fault", () => {
  const problem = errorToBatchEntryProblem(new Error("boom"), "test-server-retry-class");
  assert.equal(problem.code, ERROR_CODES.INTERNAL);
  assert.equal(problem.retryClass, "server");
});

test("errorToBatchEntryProblem attaches retryClass derived from the error code", () => {
  const problem = errorToBatchEntryProblem(
    createError({ code: ERROR_CODES.CLASS_NOT_FOUND, message: "missing" }),
    "test-retry-class"
  );
  assert.equal(problem.retryClass, "permanent");
});

test("statusForErrorCode: ERR_WORKSPACE_VERSION_UNRESOLVED maps to 422 (recoverable input)", () => {
  assert.equal(statusForErrorCode(ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED), 422);
});

test("statusForErrorCode: ERR_DEPENDENCY_VERSION_UNRESOLVED maps to 422 (recoverable input)", () => {
  assert.equal(statusForErrorCode(ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED), 422);
});

test("statusForErrorCode: ERR_BATCH_ABORTED maps to 412 (failFast precondition)", () => {
  assert.equal(statusForErrorCode(ERROR_CODES.BATCH_ABORTED), 412);
});

test("statusForErrorCode: ERR_STAGE_BUDGET_PRE_PARSE maps to 408 (request timeout)", () => {
  assert.equal(statusForErrorCode(ERROR_CODES.STAGE_BUDGET_PRE_PARSE), 408);
});

test("statusForErrorCode: ERR_INVALID_INPUT maps to 400 (existing contract preserved)", () => {
  assert.equal(statusForErrorCode(ERROR_CODES.INVALID_INPUT), 400);
});

test("statusForErrorCode: unknown code falls through to 500", () => {
  assert.equal(statusForErrorCode("ERR_DOES_NOT_EXIST"), 500);
});

test("errorToBatchEntryProblem: non-AppError generic detail is sanitized (no Error.message leak)", () => {
  // Generic Error.message must not surface in the public envelope: a
  // filesystem path, parser internal, or assertion text could leak from a
  // per-entry handler while the top-level batch call still returns a normal
  // envelope.
  const err = new Error("/home/user/.local/share/secret-cache/db.sqlite is locked");
  const problem = errorToBatchEntryProblem(err, "test-instance-1");
  assert.equal(problem.detail, "Unexpected server error.");
  assert.equal(problem.code, ERROR_CODES.INTERNAL);
  assert.equal(problem.status, 500);
  assert.ok(
    !problem.detail.includes("/home/user/.local/share"),
    "raw Error.message must not leak into the public detail"
  );
});

test("errorToBatchEntryProblem: AppError detail is preserved (AppErrors are intentionally caller-facing)", () => {
  // AppError detail is construction-site-controlled caller-actionable text;
  // the generic sanitization rule applies only to non-AppError throws.
  const appError = createError({
    code: ERROR_CODES.CLASS_NOT_FOUND,
    message: "class net.example.Foo not found"
  });
  const problem = errorToBatchEntryProblem(appError, "test-instance-2");
  assert.equal(problem.detail, "class net.example.Foo not found");
  assert.equal(problem.code, ERROR_CODES.CLASS_NOT_FOUND);
});
