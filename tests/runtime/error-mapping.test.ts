import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ERROR_CODES, createError, type AppError } from "../../src/errors.ts";
import {
  errorToBatchEntryProblem,
  extractAllowlistedContext,
  extractNestedJars,
  issueOriginForErrorCode,
  problemClassification,
  retryClassForErrorCode,
  type IssueOrigin,
  type RetryClass
} from "../../src/error-mapping.ts";
import {
  buildSupervisorQueueLimitReply,
  buildValidateProjectTimeoutReply
} from "../../src/stdio-supervisor.ts";
import { errorResource } from "../../src/mcp-helpers.ts";
import { mapErrorToProblem } from "../../src/tool-guidance.ts";
import { legacyHandshake, startInProcessSession } from "../stdio/inprocess-era-serve.ts";

const dbDownRoot = await mkdtemp(join(tmpdir(), "mcp-tool-envelope-db-down-"));
const blockingParent = join(dbDownRoot, "regular-file");
await writeFile(blockingParent, "not a directory", "utf8");

const originalSqlitePath = process.env.MCP_SQLITE_PATH;
const dbDownSession = await (async () => {
  process.env.MCP_SQLITE_PATH = join(blockingParent, "source-cache.db");
  try {
    // startInProcessSession dynamically imports ../../src/index.ts, so the
    // module singleton captures the poisoned SQLite path at import time —
    // the same poison-import pattern as before, now over the public
    // in-process transport instead of the SDK-private handler map.
    const session = await startInProcessSession();
    const handshake = await legacyHandshake(session, undefined, "db-down-init");
    assert.equal(handshake.error, undefined);
    assert.ok(handshake.result);
    return session;
  } finally {
    if (originalSqlitePath === undefined) {
      delete process.env.MCP_SQLITE_PATH;
    } else {
      process.env.MCP_SQLITE_PATH = originalSqlitePath;
    }
  }
})();

after(() => dbDownSession.close());

let dbDownRequestId = 0;

async function callToolWithDatabaseDown(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  dbDownRequestId += 1;
  const frame = await dbDownSession.request({
    jsonrpc: "2.0",
    id: `db-down-${dbDownRequestId}`,
    method: "tools/call",
    params: { name, arguments: args }
  });
  assert.equal(frame.error, undefined, "tools/call must answer a result frame, not a JSON-RPC error frame");
  assert.ok(frame.result, "tools/call reply frame must carry a result");
  return frame.result;
}

test("input validation keeps ERR_INVALID_INPUT when SQLite cannot open", async () => {
  const response = await callToolWithDatabaseDown("nbt-to-json", {}) as {
    isError?: boolean;
    structuredContent?: { error?: { code?: string }; result?: unknown; meta?: { tool?: string } };
  };

  assert.equal(response.isError, true);
  assert.equal(response.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(response.structuredContent?.result, undefined);
  assert.equal(response.structuredContent?.meta?.tool, "nbt-to-json");
});

test("a database-independent NBT tool succeeds when SQLite cannot open", async () => {
  const response = await callToolWithDatabaseDown("nbt-to-json", {
    nbtBase64: "CgAAAA=="
  }) as {
    isError?: boolean;
    structuredContent?: { error?: unknown; result?: unknown; meta?: { tool?: string } };
  };

  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent?.error, undefined);
  assert.ok(response.structuredContent?.result);
  assert.equal(response.structuredContent?.meta?.tool, "nbt-to-json");
});

test("a database-backed tool keeps ERR_DB_FAILURE when SQLite cannot open", async () => {
  const response = await callToolWithDatabaseDown("list-versions", {}) as {
    isError?: boolean;
    structuredContent?: { error?: { code?: string }; result?: unknown; meta?: { tool?: string } };
  };

  assert.equal(response.isError, true);
  assert.equal(response.structuredContent?.error?.code, "ERR_DB_FAILURE");
  assert.equal(response.structuredContent?.result, undefined);
  assert.equal(response.structuredContent?.meta?.tool, "list-versions");
});

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

test("extractNestedJars returns the inventory unchanged when every entry is a non-empty string", () => {
  const result = extractNestedJars({ nestedJars: ["META-INF/jars/a.jar", "META-INF/jars/b.jar"] });
  assert.deepEqual(result, ["META-INF/jars/a.jar", "META-INF/jars/b.jar"]);
});

test("extractNestedJars drops the whole array when any entry is not a non-empty string", () => {
  assert.equal(extractNestedJars({ nestedJars: ["a.jar", 42] }), undefined);
  assert.equal(extractNestedJars({ nestedJars: ["a.jar", ""] }), undefined);
  assert.equal(extractNestedJars({ nestedJars: ["a.jar", null] }), undefined);
});

test("extractNestedJars drops an empty array (matching the producing site, which omits the key instead)", () => {
  assert.equal(extractNestedJars({ nestedJars: [] }), undefined);
});

test("extractNestedJars caps the inventory at 64 entries", () => {
  const oversized = Array.from({ length: 70 }, (_, i) => `META-INF/jars/jar-${i}.jar`);
  const result = extractNestedJars({ nestedJars: oversized });
  assert.equal(result?.length, 64);
  assert.deepEqual(result, oversized.slice(0, 64));
});

test("extractNestedJars returns undefined for a missing or malformed field", () => {
  assert.equal(extractNestedJars({}), undefined);
  assert.equal(extractNestedJars(undefined), undefined);
  assert.equal(extractNestedJars({ nestedJars: "not-an-array" }), undefined);
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
    [ERROR_CODES.NESTED_JAR_AMBIGUOUS]: "permanent",
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
    [ERROR_CODES.NESTED_JAR_AMBIGUOUS]: "code_issue",
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

/**
 * Publish `error` through the `mc://` resource-read builder and hand back the
 * decoded ProblemDetails-shaped payload, so a classification assertion can be
 * written against all three emission paths in the same shape.
 */
function resourceProblem(error: AppError): Record<string, unknown> {
  const entry = errorResource("mc://classes/net.example.Foo", {
    message: error.message,
    code: error.code,
    details: error.details
  }).contents[0]!;
  return (JSON.parse(entry.text!) as { error: Record<string, unknown> }).error;
}

/** The `{ retryClass, issueOrigin }` pair, isolated from the rest of the envelope. */
function classificationOf(problem: {
  retryClass?: unknown;
  issueOrigin?: unknown;
}): { retryClass: unknown; issueOrigin: unknown } {
  return { retryClass: problem.retryClass, issueOrigin: problem.issueOrigin };
}

test("issueOrigin override reaches the tool, batch-entry, and resource builders identically", () => {
  // One AppError, three publication paths. The pair must not depend on WHICH
  // builder the caller happened to reach: a tools/call and an equivalent
  // mc:// resource read describe the same failure.
  const appError = createError({
    code: ERROR_CODES.CONTEXT_UNRESOLVED,
    message: 'artifact "minecraft-1.21.10" has no binary jar',
    details: { artifactId: "minecraft-1.21.10", issueOrigin: "tool_issue" }
  });

  const tool = mapErrorToProblem(appError, "req-classification-parity");
  const batch = errorToBatchEntryProblem(appError, "req-classification-parity");
  const resource = resourceProblem(appError);

  assert.equal(tool.issueOrigin, "tool_issue");
  assert.equal(batch.issueOrigin, "tool_issue");
  assert.equal(
    resource.issueOrigin,
    "tool_issue",
    "the mc:// resource-read path must honour the same per-throw-site override as the tool path"
  );
  assert.deepEqual(classificationOf(batch), classificationOf(tool));
  assert.deepEqual(classificationOf(resource), classificationOf(tool));
});

test("issueOrigin default is preserved on the tool, batch-entry, and resource builders when no override is present", () => {
  // Same code, no override: every path must still fall back to the code-keyed
  // default, so the override seam cannot silently change unmarked errors.
  const appError = createError({
    code: ERROR_CODES.CONTEXT_UNRESOLVED,
    message: "version 9.9.9 matched no artifact",
    details: { artifactId: "minecraft-1.21.10" }
  });

  const tool = mapErrorToProblem(appError, "req-classification-default");
  const batch = errorToBatchEntryProblem(appError, "req-classification-default");
  const resource = resourceProblem(appError);

  const expected = issueOriginForErrorCode(ERROR_CODES.CONTEXT_UNRESOLVED);
  assert.equal(expected, "code_issue");
  assert.equal(tool.issueOrigin, expected);
  assert.equal(batch.issueOrigin, expected);
  assert.equal(resource.issueOrigin, expected);
});

test("issueOrigin override leaves the code-derived retryClass untouched on all three builders", () => {
  // retryClass is a documented wire contract and stays purely code-derived: a
  // per-throw-site override seam exists for issueOrigin ONLY. Changing a
  // retryClass value on an existing code would be a Breaking change, so this
  // guards the deliberately-deferred decision.
  const appError = createError({
    code: ERROR_CODES.CONTEXT_UNRESOLVED,
    message: 'artifact "minecraft-1.21.10" has no binary jar',
    details: {
      artifactId: "minecraft-1.21.10",
      issueOrigin: "tool_issue",
      // A retryClass key on details must be inert: there is no override seam.
      retryClass: "environment"
    }
  });

  const codeDerived = retryClassForErrorCode(ERROR_CODES.CONTEXT_UNRESOLVED);
  assert.equal(codeDerived, "input");

  const tool = mapErrorToProblem(appError, "req-retry-class-guard");
  const batch = errorToBatchEntryProblem(appError, "req-retry-class-guard");
  const resource = resourceProblem(appError);

  assert.equal(tool.retryClass, codeDerived);
  assert.equal(batch.retryClass, codeDerived);
  assert.equal(resource.retryClass, codeDerived);
  assert.equal(tool.issueOrigin, "tool_issue");
  assert.equal(batch.issueOrigin, "tool_issue");
  assert.equal(resource.issueOrigin, "tool_issue");
});

// The supervisor answers a request the worker never ran, so it has no source
// AppError and cannot call problemClassification — it writes the pair as
// literals instead. problemClassification's doc records that those literals
// "must be mirrored there"; this pins that obligation as a gate rather than
// prose, so reclassifying either code fails here instead of silently letting
// the synthetic replies drift away from the classifier.
function syntheticErrorPayload(reply: unknown): { code: string; retryClass: string; issueOrigin: string } {
  const structured = (reply as { result?: { structuredContent?: { error?: unknown } } }).result?.structuredContent?.error;
  return structured as { code: string; retryClass: string; issueOrigin: string };
}

test("synthetic supervisor replies publish the same classification the builder would", () => {
  const queueLimit = syntheticErrorPayload(buildSupervisorQueueLimitReply(1, "tools/call"));
  assert.equal(queueLimit.code, ERROR_CODES.LIMIT_EXCEEDED);
  assert.deepEqual(
    { retryClass: queueLimit.retryClass, issueOrigin: queueLimit.issueOrigin },
    problemClassification(ERROR_CODES.LIMIT_EXCEEDED, undefined),
    "the queue-limit reply's hardcoded pair must match the classifier for its code"
  );

  const timeout = syntheticErrorPayload(buildValidateProjectTimeoutReply({
    request: { id: 2, startedAt: 0 },
    phase: "running",
    deadlineMs: 1_000,
    now: 2_000,
    workerRestartInitiated: false
  }));
  assert.equal(timeout.code, ERROR_CODES.TOOL_TIMEOUT);
  assert.deepEqual(
    { retryClass: timeout.retryClass, issueOrigin: timeout.issueOrigin },
    problemClassification(ERROR_CODES.TOOL_TIMEOUT, undefined),
    "the tool-timeout reply's hardcoded pair must match the classifier for its code"
  );
});
