import assert from "node:assert/strict";
import test from "node:test";

import { createRepos, seedArtifact } from "../helpers/repos.ts";

// Real Minecraft source contains identifiers that tokenize into FTS5 operator
// keywords (`BooleanOp.AND`), and free text can spell one out in the middle of a
// phrase (`a NOT b`). Both have to reach the MATCH expression as inert string
// literals: unquoted, the first is a syntax error and the second silently
// changes the query's meaning.
const CORPUS: Array<{ filePath: string; content: string }> = [
  { filePath: "net/minecraft/util/BooleanOpHolder.java", content: "int mask = BooleanOp.AND.apply(left, right);" },
  { filePath: "net/minecraft/util/NotHolder.java", content: "boolean flag = a NOT b;" },
  { filePath: "net/minecraft/util/Plain.java", content: "String token = \"ordinaryNeedle\";" }
];

async function seedCorpus(artifactId: string): Promise<Awaited<ReturnType<typeof createRepos>>> {
  const repos = await createRepos();
  seedArtifact(repos.artifacts, artifactId);
  repos.files.replaceFilesForArtifact(
    artifactId,
    CORPUS.map((file, index) => ({
      filePath: file.filePath,
      content: file.content,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      contentHash: `h${index}`
    }))
  );
  return repos;
}

test("filesRepo indexed text search matches a query whose token is an FTS5 operator keyword", async () => {
  const artifactId = "artifact-fts-operator";
  const { files } = await seedCorpus(artifactId);

  // Unquoted this becomes `BooleanOp AND*`, an FTS5 syntax error that the repo
  // swallows into zero hits.
  const prefixPage = files.searchFileCandidates(artifactId, {
    query: "BooleanOp.AND",
    match: "prefix",
    limit: 20,
    mode: "text"
  });
  assert.deepEqual(
    prefixPage.items.map((item) => item.filePath),
    ["net/minecraft/util/BooleanOpHolder.java"]
  );

  for (const match of ["exact", "contains"] as const) {
    const page = files.searchFileCandidates(artifactId, {
      query: "BooleanOp.AND",
      match,
      limit: 20,
      mode: "text"
    });
    assert.deepEqual(
      page.items.map((item) => item.filePath),
      ["net/minecraft/util/BooleanOpHolder.java"],
      `match=${match} must survive the operator keyword`
    );
  }
});

test("filesRepo indexed text search treats a mid-query FTS5 operator as literal text, not a boolean", async () => {
  const artifactId = "artifact-fts-mid-operator";
  const { files } = await seedCorpus(artifactId);

  // Unquoted `a NOT b` is valid FTS5 meaning "a AND NOT b", which excludes the
  // one file that actually contains the phrase.
  const page = files.searchFileCandidates(artifactId, {
    query: "a NOT b",
    match: "contains",
    limit: 20,
    mode: "text"
  });
  assert.deepEqual(
    page.items.map((item) => item.filePath),
    ["net/minecraft/util/NotHolder.java"]
  );

  assert.equal(files.searchFileCandidates(artifactId, { query: "a NOT b", limit: 20, mode: "text" }).items.length, 1);
});

test("filesRepo indexed text search leaves an ordinary separator-heavy query's results unchanged", async () => {
  const artifactId = "artifact-fts-ordinary";
  const { files } = await seedCorpus(artifactId);

  for (const query of ["ordinaryNeedle", "String.token", "mask BooleanOp"]) {
    const page = files.searchFileCandidates(artifactId, {
      query,
      match: "contains",
      limit: 20,
      mode: "text"
    });
    assert.equal(page.items.length, 1, `"${query}" must still match exactly one file`);
  }

  assert.equal(
    files.searchFileCandidates(artifactId, {
      query: "zzzNothingHere",
      match: "contains",
      limit: 20,
      mode: "text"
    }).items.length,
    0
  );
});
