import assert from "node:assert/strict";
import test from "node:test";

import { createRepos, seedArtifact, type TestRepos } from "../helpers/repos.ts";

// Reference: an FTS5 candidate query without rowid bounds, which filters the
// artifact and the path through the FTS table itself. The repository statement
// must return exactly these rows, in this order, for every artifact, MATCH
// expression, path scope and limit. Do not edit it to follow the repository
// statement; it is the fixed point the statement is compared with.
const REFERENCE_FTS_CANDIDATE_SQL = `
      SELECT file_path, rank
      FROM files_fts
      WHERE artifact_id = ? AND files_fts MATCH ?
        AND (? IS NULL OR file_path LIKE ? ESCAPE '\\')
      ORDER BY rank
      LIMIT ?
    `;

type ReferenceRow = { file_path: string; rank: number };

function file(filePath: string, content: string, index: number) {
  return {
    filePath,
    content,
    contentBytes: Buffer.byteLength(content, "utf8"),
    contentHash: `h-${index}-${filePath}`
  };
}

function scopePattern(pathPrefix: string | undefined): string | null {
  return pathPrefix ? `${pathPrefix.replace(/[\\%_]/g, "\\$&")}%` : null;
}

/** Independent spelling of the MATCH expression the repository builds for a query. */
function matchExpression(query: string, match: "exact" | "prefix" | "contains"): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replace(/"/g, '""')}"`;
      return match === "prefix" && index === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");
}

function referenceRows(
  repos: TestRepos,
  artifactId: string,
  query: string,
  match: "exact" | "prefix" | "contains",
  pathPrefix: string | undefined,
  limit: number
): ReferenceRow[] {
  const scope = scopePattern(pathPrefix);
  return repos.db
    .prepare(REFERENCE_FTS_CANDIDATE_SQL)
    .all(artifactId, matchExpression(query, match), scope, scope, limit) as ReferenceRow[];
}

function textCandidatePaths(
  repos: TestRepos,
  artifactId: string,
  query: string,
  options: { match?: "exact" | "prefix" | "contains"; pathPrefix?: string; fetchLimitOverride?: number } = {}
): string[] {
  return repos.files
    .searchFileCandidates(artifactId, { query, limit: 1000, mode: "text", ...options })
    .items.map((item) => item.filePath);
}

function rowidArtifactOrder(repos: TestRepos): string[] {
  return (repos.db.prepare("SELECT artifact_id FROM files ORDER BY rowid").all() as { artifact_id: string }[]).map(
    (row) => row.artifact_id
  );
}

test("filesRepo indexed text search keeps to one artifact when another artifact's rows sit between its rows", async () => {
  const repos = await createRepos();
  const a = "artifact-window-a";
  const b = "artifact-window-b";
  seedArtifact(repos.artifacts, a);
  seedArtifact(repos.artifacts, b);

  // A, B, A in rowid order; B's files repeat the token, so they outrank A's
  // and sit inside any range that spans A's first and last row.
  repos.files.insertFilesForArtifact(a, [file("pkg/a/First.java", "shared token", 0)]);
  repos.files.insertFilesForArtifact(b, [
    file("pkg/b/Loud.java", "shared shared shared shared", 1),
    file("pkg/b/Louder.java", "shared shared shared shared shared", 2)
  ]);
  repos.files.insertFilesForArtifact(a, [file("pkg/a/Second.java", "shared and some other words here", 3)]);
  assert.deepEqual(rowidArtifactOrder(repos), [a, b, b, a], "fixture must interleave the two artifacts");

  for (const pathPrefix of [undefined, "pkg/"]) {
    assert.deepEqual(
      textCandidatePaths(repos, a, "shared", { pathPrefix }),
      ["pkg/a/First.java", "pkg/a/Second.java"],
      `scope ${pathPrefix ?? "(none)"}`
    );
    assert.deepEqual(
      textCandidatePaths(repos, a, "shared", { pathPrefix, fetchLimitOverride: 1 }),
      ["pkg/a/First.java"],
      `scope ${pathPrefix ?? "(none)"}, one candidate`
    );
    assert.deepEqual(
      textCandidatePaths(repos, b, "shared", { pathPrefix }),
      ["pkg/b/Loud.java", "pkg/b/Louder.java"],
      `artifact B, scope ${pathPrefix ?? "(none)"}`
    );
  }
});

test("filesRepo indexed text search returns no candidates for an artifact or scope that has no rows", async () => {
  const repos = await createRepos();
  const populated = "artifact-window-populated";
  const other = "artifact-window-other";
  const empty = "artifact-window-empty";
  const cleared = "artifact-window-cleared";
  for (const artifactId of [populated, other, empty, cleared]) {
    seedArtifact(repos.artifacts, artifactId);
  }
  repos.files.insertFilesForArtifact(populated, [file("pkg/x/Holder.java", "shared token", 0)]);
  repos.files.insertFilesForArtifact(cleared, [file("pkg/c/Gone.java", "shared token", 1)]);
  repos.files.insertFilesForArtifact(other, [file("pkg/y/Holder.java", "shared token", 2)]);
  repos.files.clearFilesForArtifact(cleared);

  // Sanity: the token is indexed and found where rows exist.
  assert.deepEqual(textCandidatePaths(repos, populated, "shared"), ["pkg/x/Holder.java"]);

  const cases: Array<{ label: string; artifactId: string; pathPrefix?: string }> = [
    { label: "unknown artifact", artifactId: "artifact-window-missing" },
    { label: "artifact without files", artifactId: empty },
    { label: "artifact whose files were cleared", artifactId: cleared },
    { label: "scope that matches no path", artifactId: populated, pathPrefix: "zzz/" },
    { label: "scope that matches only another artifact's paths", artifactId: populated, pathPrefix: "pkg/y/" }
  ];
  for (const { label, artifactId, pathPrefix } of cases) {
    for (const match of ["exact", "prefix", "contains"] as const) {
      const result = repos.files.searchFileCandidates(artifactId, {
        query: "shared",
        match,
        limit: 20,
        mode: "text",
        pathPrefix
      });
      assert.deepEqual(result.items, [], `${label}, match=${match}`);
      assert.equal(result.scannedRows, 0, `${label}, match=${match}`);
    }
  }
});

test("filesRepo indexed text search returns the reference statement's rows in its order for every limit", async () => {
  const repos = await createRepos();
  const artifactIds = ["artifact-window-x", "artifact-window-y", "artifact-window-z"];
  for (const artifactId of artifactIds) {
    seedArtifact(repos.artifacts, artifactId);
  }

  const files = (variant: number) => [
    { path: "net/core/Alpha1.java", content: `alpha${" alpha".repeat(variant)}` },
    { path: "net/core/Alpha2.java", content: "alpha alpha" },
    { path: "net/core/Alpha3.java", content: "alpha alpha alpha beta" },
    // Identical contents: equal rank, so the limit can fall inside this group.
    { path: "net/core/TieA.java", content: "alpha beta gamma" },
    { path: "net/core/TieB.java", content: "alpha beta gamma" },
    { path: "net/core/TieC.java", content: "alpha beta gamma" },
    { path: "net/core/TieD.java", content: "alpha beta gamma" },
    { path: "net/extra/Mixed.java", content: "alpha beta beta beta" },
    { path: "net/core_x/Under.java", content: "alpha under beta" },
    { path: "net/corexx/Lookalike.java", content: "alpha lookalike beta" },
    { path: "com/other/Other.java", content: "alpha other beta gamma" },
    { path: "com/other/Alphabet.java", content: "alphabet soup" },
    { path: "net/core/None.java", content: "nothing here" }
  ];

  // Two interleaved batches per artifact, so every artifact's rowid range
  // overlaps the others'.
  for (const half of [0, 1]) {
    artifactIds.forEach((artifactId, variant) => {
      const all = files(variant);
      const batch = all.filter((_, index) => index % 2 === half);
      repos.files.insertFilesForArtifact(
        artifactId,
        batch.map((entry, index) => file(entry.path, entry.content, half * 100 + index))
      );
    });
  }
  assert.deepEqual(
    rowidArtifactOrder(repos).filter((id, index, list) => index === 0 || list[index - 1] !== id),
    [...artifactIds, ...artifactIds],
    "fixture must interleave the three artifacts"
  );

  const queries: Array<{ query: string; match: "exact" | "prefix" | "contains" }> = [
    { query: "alpha", match: "exact" },
    { query: "alpha", match: "prefix" },
    { query: "alpha", match: "contains" },
    { query: "alph", match: "prefix" },
    { query: "alpha beta", match: "contains" },
    { query: "alpha be", match: "prefix" },
    { query: "alpha.beta", match: "exact" },
    { query: "gamma", match: "contains" },
    { query: "missingtoken", match: "contains" }
  ];
  const scopes = [undefined, "net/", "net/core/", "net/core_x/", "com/", "zzz/"];

  let combinations = 0;
  let nonEmpty = 0;
  let scopedNonEmpty = 0;
  let limitsInsideTie = 0;
  for (const artifactId of artifactIds) {
    for (const { query, match } of queries) {
      for (const pathPrefix of scopes) {
        const label = `${artifactId} "${query}" ${match} scope=${pathPrefix ?? "(none)"}`;
        const reference = referenceRows(repos, artifactId, query, match, pathPrefix, 10_000);
        const referencePaths = reference.map((row) => row.file_path);
        combinations += 1;
        if (reference.length > 0) {
          nonEmpty += 1;
          if (pathPrefix) scopedNonEmpty += 1;
        }

        // The repository orders a page by its own score, so the statement's
        // order shows through which rows each candidate limit admits: the row
        // admitted when the limit grows from k-1 to k is the statement's k-th row.
        const admitted: string[] = [];
        let previous = new Set<string>();
        for (let limit = 1; limit <= reference.length + 1; limit += 1) {
          const page = repos.files.searchFileCandidates(artifactId, {
            query,
            match,
            limit: 1000,
            mode: "text",
            pathPrefix,
            fetchLimitOverride: limit
          });
          const current = new Set(page.items.map((item) => item.filePath));
          assert.equal(current.size, Math.min(limit, reference.length), `${label}, limit ${limit}`);
          assert.deepEqual(
            current,
            new Set(referencePaths.slice(0, limit)),
            `${label}, limit ${limit}`
          );
          admitted.push(...[...current].filter((path) => !previous.has(path)));
          previous = current;
          if (limit < reference.length && reference[limit - 1].rank === reference[limit].rank) {
            limitsInsideTie += 1;
          }

          const rankByPath = new Map(reference.map((row) => [row.file_path, row.rank]));
          for (const item of page.items) {
            const rank = rankByPath.get(item.filePath)!;
            assert.equal(item.score, 100 + Math.min(19, Math.max(0, Math.round(-rank))), `${label}, ${item.filePath}`);
          }
        }
        assert.deepEqual(admitted, referencePaths, label);
      }
    }
  }

  // The comparison must not pass vacuously.
  assert.equal(combinations, artifactIds.length * queries.length * scopes.length);
  assert.ok(nonEmpty >= 60, `non-empty combinations: ${nonEmpty}`);
  assert.ok(scopedNonEmpty >= 40, `non-empty scoped combinations: ${scopedNonEmpty}`);
  assert.ok(limitsInsideTie >= 10, `limits inside a tie group: ${limitsInsideTie}`);
});
