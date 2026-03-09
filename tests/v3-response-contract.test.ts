import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEntryToolMeta,
  buildEntryToolResult,
  createNextAction,
  createTruncationMeta,
  normalizeIncludeGroups
} from "../src/entry-tools/response-contract.ts";

test("buildEntryToolResult keeps summary and task while preserving selected blocks", () => {
  const result = buildEntryToolResult({
    task: "artifact",
    summary: {
      status: "ok",
      headline: "Resolved one artifact."
    },
    detail: "summary",
    include: ["artifact"],
    blocks: {
      artifact: {
        artifactId: "artifact-1"
      },
      search: {
        hits: 5
      }
    }
  });

  assert.equal(result.task, "artifact");
  assert.equal(result.summary.status, "ok");
  assert.deepEqual(result.artifact, { artifactId: "artifact-1" });
  assert.equal("search" in result, false);
});

test("normalizeIncludeGroups deduplicates and preserves canonical order", () => {
  assert.deepEqual(
    normalizeIncludeGroups(["timings", "artifact", "timings", "warnings", "artifact"]),
    ["warnings", "timings", "artifact"]
  );
});

test("buildEntryToolMeta includes truncation details only when provided", () => {
  const meta = buildEntryToolMeta({
    detail: "standard",
    include: ["artifact", "timings"],
    warnings: ["used cache"],
    truncated: createTruncationMeta({
      omittedGroups: ["source"],
      nextActions: [createNextAction("inspect-minecraft", { task: "class-source" })]
    })
  });

  assert.equal(meta.detailApplied, "standard");
  assert.deepEqual(meta.includeApplied, ["timings", "artifact"]);
  assert.deepEqual(meta.warnings, ["used cache"]);
  assert.deepEqual(meta.truncated, {
    didTruncate: true,
    reason: "limit",
    omittedGroups: ["source"],
    nextActions: [
      {
        tool: "inspect-minecraft",
        params: {
          task: "class-source"
        }
      }
    ]
  });
});
