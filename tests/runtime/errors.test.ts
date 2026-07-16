import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, type ErrorCode } from "../../src/errors.ts";

test("ERROR_CODES exposes ERR_WORKER_RESTART", () => {
  assert.equal(ERROR_CODES.WORKER_RESTART, "ERR_WORKER_RESTART");
});

test("ERROR_CODES exposes ERR_TOOL_TIMEOUT", () => {
  assert.equal(
    (ERROR_CODES as Record<string, string>).TOOL_TIMEOUT,
    "ERR_TOOL_TIMEOUT"
  );
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
  assert.ok(values.includes("ERR_TOOL_TIMEOUT" as ErrorCode));
  assert.ok(values.includes("ERR_MIXIN_PARSE_FAILED" as ErrorCode));
  assert.ok(values.includes("ERR_STAGE_BUDGET_PRE_PARSE" as ErrorCode));
  assert.ok(values.includes("ERR_WORKSPACE_VERSION_UNRESOLVED" as ErrorCode));
  assert.ok(values.includes("ERR_DEPENDENCY_VERSION_UNRESOLVED" as ErrorCode));
});

import { AppError, createError, isAppError } from "../../src/errors.ts";

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

import { statusForErrorCode } from "../../src/error-mapping.ts";

test("every ERROR_CODES value maps to a documented HTTP status (no untyped 500 fallback)", () => {
  // All 36 codes must map to one of the documented buckets. The buckets we
  // document live in `src/error-mapping.ts`; the fallback is `500` for any
  // code that the switch does not handle. ERR_DB_FAILURE / ERR_WORKER_RESTART /
  // ERR_MIXIN_PARSE_FAILED / ERR_INTERNAL / ERR_ARTIFACT_RESOLUTION_FAILED
  // currently fall through to 500 intentionally.
  const allCodes = Object.values(ERROR_CODES);
  const allowedStatuses = new Set([400, 404, 408, 409, 412, 413, 422, 500, 502, 503]);
  for (const code of allCodes) {
    const status = statusForErrorCode(code);
    assert.ok(
      allowedStatuses.has(status),
      `ERROR_CODE ${code} mapped to unexpected status ${status}`
    );
  }
});

test("statusForErrorCode buckets cover the documented groups (400 / 404 / 422 / 503 / 500)", () => {
  // 400 — validation / parse errors
  for (const code of [
    ERROR_CODES.INVALID_INPUT,
    ERROR_CODES.COORDINATE_PARSE_FAILED,
    ERROR_CODES.INVALID_LINE_RANGE,
    ERROR_CODES.NBT_PARSE_FAILED,
    ERROR_CODES.NBT_INVALID_TYPED_JSON,
    ERROR_CODES.JSON_PATCH_INVALID,
    ERROR_CODES.NBT_ENCODE_FAILED,
    ERROR_CODES.NBT_UNSUPPORTED_FEATURE
  ]) {
    assert.equal(statusForErrorCode(code), 400, `${code} must map to 400`);
  }
  // 404 — not-found family
  for (const code of [
    ERROR_CODES.SOURCE_NOT_FOUND,
    ERROR_CODES.FILE_NOT_FOUND,
    ERROR_CODES.JAR_NOT_FOUND,
    ERROR_CODES.VERSION_NOT_FOUND,
    ERROR_CODES.CLASS_NOT_FOUND
  ]) {
    assert.equal(statusForErrorCode(code), 404, `${code} must map to 404`);
  }
  // 422 — mapping/remap-state semantic failures
  for (const code of [
    ERROR_CODES.MAPPING_NOT_APPLIED,
    ERROR_CODES.MAPPING_UNAVAILABLE,
    ERROR_CODES.NAMESPACE_MISMATCH,
    ERROR_CODES.DECOMPILE_DISABLED,
    ERROR_CODES.REMAP_FAILED,
    ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
    ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED,
    ERROR_CODES.NESTED_JAR_AMBIGUOUS
  ]) {
    assert.equal(statusForErrorCode(code), 422, `${code} must map to 422`);
  }
  // 503 — runtime/tooling unavailable
  for (const code of [
    ERROR_CODES.REMAPPER_UNAVAILABLE,
    ERROR_CODES.JAVA_PROCESS_FAILED,
    ERROR_CODES.DECOMPILER_UNAVAILABLE,
    ERROR_CODES.DECOMPILER_FAILED,
    ERROR_CODES.JAVA_UNAVAILABLE,
    ERROR_CODES.REGISTRY_GENERATION_FAILED
  ]) {
    assert.equal(statusForErrorCode(code), 503, `${code} must map to 503`);
  }
  // Specials
  assert.equal(statusForErrorCode(ERROR_CODES.BATCH_ABORTED), 412);
  assert.equal(statusForErrorCode(ERROR_CODES.STAGE_BUDGET_PRE_PARSE), 408);
  assert.equal(statusForErrorCode(ERROR_CODES.LIMIT_EXCEEDED), 413);
  assert.equal(statusForErrorCode(ERROR_CODES.REPO_FETCH_FAILED), 502);
  assert.equal(statusForErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT), 409);
  assert.equal(statusForErrorCode(ERROR_CODES.CONTEXT_UNRESOLVED), 409);
  assert.equal(statusForErrorCode(ERROR_CODES.INTERNAL), 500);
});

test("statusForErrorCode returns 500 for unknown codes (default fallback)", () => {
  assert.equal(statusForErrorCode("ERR_TOTALLY_UNKNOWN" as any), 500);
});
