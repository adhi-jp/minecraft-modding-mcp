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

test("new error codes are part of the ErrorCode union", () => {
  const values = Object.values(ERROR_CODES) as ErrorCode[];
  assert.ok(values.includes("ERR_WORKER_RESTART" as ErrorCode));
  assert.ok(values.includes("ERR_MIXIN_PARSE_FAILED" as ErrorCode));
  assert.ok(values.includes("ERR_STAGE_BUDGET_PRE_PARSE" as ErrorCode));
});
