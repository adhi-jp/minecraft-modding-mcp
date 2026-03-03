import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("storage catch paths emit warn logs", async () => {
  const filesRepo = await readFile("src/storage/files-repo.ts", "utf8");
  const artifactsRepo = await readFile("src/storage/artifacts-repo.ts", "utf8");
  const symbolsRepo = await readFile("src/storage/symbols-repo.ts", "utf8");

  // F-02: invalid cursors now throw ERR_INVALID_INPUT instead of logging a warning
  assert.match(filesRepo, /ERROR_CODES\.INVALID_INPUT/);
  assert.match(filesRepo, /log\("warn", "storage\.files\.fts_syntax_error"/);
  assert.match(filesRepo, /log\("warn", "storage\.files\.count_text_candidates_failed"/);

  assert.match(artifactsRepo, /log\("warn", "storage\.artifacts\.invalid_provenance_json"/);
  assert.match(artifactsRepo, /log\("warn", "storage\.artifacts\.invalid_quality_flags_json"/);

  assert.match(symbolsRepo, /log\("warn", "storage\.symbols\.invalid_cursor"/);
});
