import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, type ErrorCode } from "../src/errors.ts";

test("ERROR_CODES exposes ERR_WORKER_RESTART", () => {
  assert.equal(ERROR_CODES.WORKER_RESTART, "ERR_WORKER_RESTART");
});

test("ERROR_CODES exposes ERR_MIXIN_PARSE_FAILED", () => {
  assert.equal(ERROR_CODES.MIXIN_PARSE_FAILED, "ERR_MIXIN_PARSE_FAILED");
});

test("ERROR_CODES exposes ERR_STAGE_BUDGET_PRE_PARSE", () => {
  assert.equal(ERROR_CODES.STAGE_BUDGET_PRE_PARSE, "ERR_STAGE_BUDGET_PRE_PARSE");
});

test("ERROR_CODES exposes ERR_WORKSPACE_VERSION_UNRESOLVED", () => {
  assert.equal(ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED, "ERR_WORKSPACE_VERSION_UNRESOLVED");
});

test("ERROR_CODES exposes ERR_DEPENDENCY_VERSION_UNRESOLVED", () => {
  assert.equal(ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED, "ERR_DEPENDENCY_VERSION_UNRESOLVED");
});

test("new error codes are part of the ErrorCode union", () => {
  const values = Object.values(ERROR_CODES) as ErrorCode[];
  assert.ok(values.includes("ERR_WORKER_RESTART" as ErrorCode));
  assert.ok(values.includes("ERR_MIXIN_PARSE_FAILED" as ErrorCode));
  assert.ok(values.includes("ERR_STAGE_BUDGET_PRE_PARSE" as ErrorCode));
  assert.ok(values.includes("ERR_WORKSPACE_VERSION_UNRESOLVED" as ErrorCode));
  assert.ok(values.includes("ERR_DEPENDENCY_VERSION_UNRESOLVED" as ErrorCode));
});

import { AppError, createError, isAppError } from "../src/errors.ts";

test("isAppError returns true for AppError instances created via createError", () => {
  const err = createError({ code: ERROR_CODES.INVALID_INPUT, message: "bad", details: { x: 1 } });
  assert.equal(isAppError(err), true);
});

test("isAppError returns false for arbitrary Error objects with a `code` property", () => {
  const masquerade = Object.assign(new Error("/secret/path"), { code: "ERR_FAKE" });
  assert.equal(
    isAppError(masquerade),
    false,
    "isAppError must NOT accept plain Errors that merely set a `code` field — that lets unrelated errors leak through AppError handling"
  );
});

test("isAppError returns false for non-Error values that look error-like", () => {
  assert.equal(isAppError({ code: "ERR_FAKE", message: "x" }), false);
  assert.equal(isAppError({ code: "ERR_FAKE" }), false);
  assert.equal(isAppError(null), false);
  assert.equal(isAppError(undefined), false);
  assert.equal(isAppError("ERR_FAKE"), false);
});

test("isAppError narrows the type so callers can read AppError fields safely", () => {
  const err: unknown = createError({ code: ERROR_CODES.INVALID_INPUT, message: "x", details: { y: 2 } });
  if (isAppError(err)) {
    // Compile-time: err is AppError. Runtime: code and details are accessible.
    assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
    assert.deepEqual(err.details, { y: 2 });
  } else {
    assert.fail("createError result must be recognised by isAppError");
  }
});

test("AppError carries name === 'AppError' for diagnostic logging", () => {
  const err = createError({ code: ERROR_CODES.INVALID_INPUT, message: "x" });
  assert.ok(err instanceof AppError);
  assert.equal(err.name, "AppError");
});
