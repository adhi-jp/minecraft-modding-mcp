import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, createError } from "../src/errors.ts";
import {
  errorToBatchEntryProblem,
  extractAllowlistedContext,
  issueOriginForErrorCode,
  retryClassForErrorCode,
  type IssueOrigin,
  type RetryClass
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
  assert.equal(retryClassForErrorCode("ERR_TOOL_TIMEOUT"), "transient");
  assert.equal(issueOriginForErrorCode("ERR_TOOL_TIMEOUT"), "tool_issue");
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

test("retryClassForErrorCode classifies every ERROR_CODES value explicitly (no silent transient default)", () => {
  // Mirror of the exhaustive status sweep in errors.test.ts: every known code
  // must be assigned a deliberate retry family here. A newly-added ERROR_CODES
  // entry that is missing from this map fails the iteration, forcing a conscious
  // classification instead of silently inheriting the "transient" catch-all.
  const expected: Record<string, RetryClass> = {
    [ERROR_CODES.INVALID_INPUT]: "input",
    [ERROR_CODES.COORDINATE_PARSE_FAILED]: "input",
    [ERROR_CODES.INVALID_LINE_RANGE]: "input",
    [ERROR_CODES.NBT_PARSE_FAILED]: "input",
    [ERROR_CODES.NBT_INVALID_TYPED_JSON]: "input",
    [ERROR_CODES.JSON_PATCH_INVALID]: "input",
    [ERROR_CODES.JSON_PATCH_CONFLICT]: "input",
    [ERROR_CODES.NBT_ENCODE_FAILED]: "input",
    [ERROR_CODES.NBT_UNSUPPORTED_FEATURE]: "input",
    [ERROR_CODES.NAMESPACE_MISMATCH]: "input",
    [ERROR_CODES.CONTEXT_UNRESOLVED]: "input",
    [ERROR_CODES.MIXIN_PARSE_FAILED]: "input",
    [ERROR_CODES.SOURCE_NOT_FOUND]: "permanent",
    [ERROR_CODES.FILE_NOT_FOUND]: "permanent",
    [ERROR_CODES.JAR_NOT_FOUND]: "permanent",
    [ERROR_CODES.VERSION_NOT_FOUND]: "permanent",
    [ERROR_CODES.CLASS_NOT_FOUND]: "permanent",
    [ERROR_CODES.MAPPING_NOT_APPLIED]: "permanent",
    [ERROR_CODES.MAPPING_UNAVAILABLE]: "permanent",
    [ERROR_CODES.DECOMPILE_DISABLED]: "permanent",
    [ERROR_CODES.REMAP_FAILED]: "permanent",
    [ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED]: "permanent",
    [ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED]: "permanent",
    [ERROR_CODES.PROVENANCE_INCOMPLETE]: "permanent",
    [ERROR_CODES.BATCH_ABORTED]: "permanent",
    [ERROR_CODES.JAVA_UNAVAILABLE]: "environment",
    [ERROR_CODES.DECOMPILER_UNAVAILABLE]: "environment",
    [ERROR_CODES.DECOMPILER_FAILED]: "environment",
    [ERROR_CODES.REMAPPER_UNAVAILABLE]: "environment",
    [ERROR_CODES.REGISTRY_GENERATION_FAILED]: "environment",
    [ERROR_CODES.INTERNAL]: "server",
    [ERROR_CODES.DB_FAILURE]: "server",
    [ERROR_CODES.REPO_FETCH_FAILED]: "transient",
    [ERROR_CODES.LIMIT_EXCEEDED]: "transient",
    [ERROR_CODES.ARTIFACT_RESOLUTION_FAILED]: "transient",
    [ERROR_CODES.JAVA_PROCESS_FAILED]: "transient",
    [ERROR_CODES.WORKER_RESTART]: "transient",
    ERR_TOOL_TIMEOUT: "transient",
    [ERROR_CODES.STAGE_BUDGET_PRE_PARSE]: "transient"
  };
  for (const code of Object.values(ERROR_CODES)) {
    const family = expected[code];
    assert.ok(
      family !== undefined,
      `ERROR_CODE ${code} is unclassified in the retryClass sweep — add it deliberately instead of relying on the transient default`
    );
    assert.equal(retryClassForErrorCode(code), family, `${code} retryClass`);
  }
});

test("issueOriginForErrorCode classifies every ERROR_CODES value explicitly (no silent tool_issue default)", () => {
  // Companion to the retryClass sweep: pin the issue origin of every known code
  // so a newly-added ERROR_CODES entry cannot silently inherit the "tool_issue"
  // catch-all default.
  const expected: Record<string, IssueOrigin> = {
    [ERROR_CODES.INVALID_INPUT]: "code_issue",
    [ERROR_CODES.COORDINATE_PARSE_FAILED]: "code_issue",
    [ERROR_CODES.INVALID_LINE_RANGE]: "code_issue",
    [ERROR_CODES.NBT_PARSE_FAILED]: "code_issue",
    [ERROR_CODES.NBT_INVALID_TYPED_JSON]: "code_issue",
    [ERROR_CODES.JSON_PATCH_INVALID]: "code_issue",
    [ERROR_CODES.JSON_PATCH_CONFLICT]: "code_issue",
    [ERROR_CODES.NBT_ENCODE_FAILED]: "code_issue",
    [ERROR_CODES.NBT_UNSUPPORTED_FEATURE]: "code_issue",
    [ERROR_CODES.NAMESPACE_MISMATCH]: "code_issue",
    [ERROR_CODES.CONTEXT_UNRESOLVED]: "code_issue",
    [ERROR_CODES.MIXIN_PARSE_FAILED]: "code_issue",
    [ERROR_CODES.CLASS_NOT_FOUND]: "code_issue",
    [ERROR_CODES.SOURCE_NOT_FOUND]: "code_issue",
    [ERROR_CODES.FILE_NOT_FOUND]: "code_issue",
    [ERROR_CODES.JAR_NOT_FOUND]: "code_issue",
    [ERROR_CODES.VERSION_NOT_FOUND]: "code_issue",
    [ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED]: "code_issue",
    [ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED]: "code_issue",
    [ERROR_CODES.JAVA_UNAVAILABLE]: "environment",
    [ERROR_CODES.DECOMPILER_UNAVAILABLE]: "environment",
    [ERROR_CODES.DECOMPILER_FAILED]: "environment",
    [ERROR_CODES.REMAPPER_UNAVAILABLE]: "environment",
    [ERROR_CODES.REGISTRY_GENERATION_FAILED]: "environment",
    [ERROR_CODES.REPO_FETCH_FAILED]: "tool_issue",
    [ERROR_CODES.DB_FAILURE]: "tool_issue",
    [ERROR_CODES.LIMIT_EXCEEDED]: "tool_issue",
    [ERROR_CODES.ARTIFACT_RESOLUTION_FAILED]: "tool_issue",
    [ERROR_CODES.MAPPING_NOT_APPLIED]: "tool_issue",
    [ERROR_CODES.PROVENANCE_INCOMPLETE]: "tool_issue",
    [ERROR_CODES.MAPPING_UNAVAILABLE]: "tool_issue",
    [ERROR_CODES.DECOMPILE_DISABLED]: "tool_issue",
    [ERROR_CODES.JAVA_PROCESS_FAILED]: "tool_issue",
    [ERROR_CODES.REMAP_FAILED]: "tool_issue",
    [ERROR_CODES.WORKER_RESTART]: "tool_issue",
    ERR_TOOL_TIMEOUT: "tool_issue",
    [ERROR_CODES.STAGE_BUDGET_PRE_PARSE]: "tool_issue",
    [ERROR_CODES.BATCH_ABORTED]: "tool_issue",
    [ERROR_CODES.INTERNAL]: "tool_issue"
  };
  for (const code of Object.values(ERROR_CODES)) {
    const origin = expected[code];
    assert.ok(
      origin !== undefined,
      `ERROR_CODE ${code} is unclassified in the issueOrigin sweep — add it deliberately instead of relying on the tool_issue default`
    );
    assert.equal(issueOriginForErrorCode(code), origin, `${code} issueOrigin`);
  }
});
