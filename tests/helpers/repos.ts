import Database from "../../src/storage/sqlite.ts";

import type { ArtifactsRepo } from "../../src/storage/artifacts-repo.ts";
import type { FilesRepo } from "../../src/storage/files-repo.ts";
import type { SymbolsRepo } from "../../src/storage/symbols-repo.ts";

export interface TestRepos {
  db: Database;
  artifacts: ArtifactsRepo;
  files: FilesRepo;
  symbols: SymbolsRepo;
}

/**
 * Create a fresh in-memory SQLite database with migrations applied and the
 * three storage repos wired up. Shared by the storage-layer test files so the
 * boilerplate stays in one place.
 */
export async function createRepos(): Promise<TestRepos> {
  const { ArtifactsRepo } = await import("../../src/storage/artifacts-repo.ts");
  const { FilesRepo } = await import("../../src/storage/files-repo.ts");
  const { runMigrations } = await import("../../src/storage/migrations.ts");
  const { SymbolsRepo } = await import("../../src/storage/symbols-repo.ts");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return {
    db,
    artifacts: new ArtifactsRepo(db),
    files: new FilesRepo(db),
    symbols: new SymbolsRepo(db)
  };
}

/** Insert a minimal artifact row so file/symbol rows satisfy FK constraints. */
export function seedArtifact(artifacts: ArtifactsRepo, artifactId: string): void {
  artifacts.upsertArtifact({
    artifactId,
    origin: "local-jar",
    artifactSignature: "sig",
    isDecompiled: false,
    timestamp: new Date().toISOString()
  });
}
