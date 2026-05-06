import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, createError } from "../src/errors.ts";
import { errorToBatchEntryProblem, statusForErrorCode } from "../src/error-mapping.ts";

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
