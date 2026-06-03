import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-map-error-contract-cache");

test.before(async () => {
  await mkdtemp(join(tmpdir(), "mcp-map-error-contract-pre-"));
});

test("D9: published suggestedCall validates against the registered schema for the tool", async () => {
  const { mapErrorToProblem } = await import("../src/index.ts");
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");

  const validParams = {
    className: "net.minecraft.world.entity.LivingEntity",
    target: { type: "resolve" as const, kind: "version" as const, value: "1.21.10" }
  };
  const error = createError({
    code: ERROR_CODES.SOURCE_NOT_FOUND,
    message: "synthetic test error",
    details: {
      nextAction: "Use get-class-source to retry.",
      suggestedCall: { tool: "get-class-source", params: validParams }
    }
  });
  const problem = mapErrorToProblem(error, "test-req-1");
  assert.ok(problem.suggestedCall, "expected suggestedCall to be emitted");
  assert.equal(problem.suggestedCall!.tool, "get-class-source");
  const validated = validateToolParams(
    problem.suggestedCall!.tool,
    problem.suggestedCall!.params
  );
  assert.equal(
    validated.valid,
    true,
    `published suggestedCall.params must validate, got ${JSON.stringify(validated)}`
  );
});

test("D10: bug-shaped suggestedCall is dropped and error.hints carries the fallback line", async () => {
  const { mapErrorToProblem } = await import("../src/index.ts");

  const error = createError({
    code: ERROR_CODES.SOURCE_NOT_FOUND,
    message: "synthetic test error with bug-shaped suggested call",
    details: {
      nextAction: "Should be repaired.",
      suggestedCall: {
        tool: "get-class-members",
        params: {
          target: {
            type: "resolve",
            kind: "coordinate",
            value:
              "{\"type\": \"resolve\", \"kind\": \"version\", \"value\": \"1.21.10\"}"
          }
        }
      }
    }
  });
  const problem = mapErrorToProblem(error, "test-req-2");
  assert.equal(
    problem.suggestedCall,
    undefined,
    "bug-shaped suggestedCall must be dropped"
  );
  assert.ok(
    problem.hints && problem.hints.includes(
      "suggested call payload failed schema validation; using fallback examples"
    ),
    `expected fallback hint, got ${JSON.stringify(problem.hints)}`
  );
});

test("D13: byte-identical envelope for valid suggestions (no key additions, no defaults injected)", async () => {
  const { mapErrorToProblem } = await import("../src/index.ts");

  // Two-key input; the published payload must retain exactly those two keys
  // so the get-class-source schema defaults (mode, allowDecompile, detail)
  // do not slip into the agent-visible payload.
  const callerParams: Record<string, unknown> = {
    className: "net.minecraft.world.entity.LivingEntity",
    target: { type: "resolve", kind: "version", value: "1.21.10" }
  };
  const error = createError({
    code: ERROR_CODES.SOURCE_NOT_FOUND,
    message: "synthetic test error",
    details: {
      suggestedCall: { tool: "get-class-source", params: callerParams }
    }
  });
  const problem = mapErrorToProblem(error, "test-req-3");
  assert.ok(problem.suggestedCall);
  assert.deepEqual(
    problem.suggestedCall!.params,
    callerParams,
    "published suggestedCall.params must be byte-identical to the caller-supplied object"
  );
  const publishedKeys = Object.keys(problem.suggestedCall!.params).sort();
  assert.deepEqual(publishedKeys, ["className", "target"]);
});

test("D14: a non-AppError throw maps to a non-retryable server fault (retryClass=server)", async () => {
  const { mapErrorToProblem } = await import("../src/index.ts");

  // Programming bugs / null derefs surface as sanitized ERR_INTERNAL. Retrying
  // the identical call cannot help, so the envelope must NOT advertise it as
  // transient — it carries retryClass "server" while issueOrigin stays tool_issue.
  const problem = mapErrorToProblem(new Error("unexpected null deref"), "test-req-internal");
  assert.equal(problem.code, ERROR_CODES.INTERNAL);
  assert.equal(problem.retryClass, "server");
  assert.equal(problem.issueOrigin, "tool_issue");
  assert.equal(problem.detail, "Unexpected server error.");
});
