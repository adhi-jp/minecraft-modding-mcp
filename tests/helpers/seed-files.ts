import type { TestRepos } from "./repos.ts";

/** Index `filePaths` as minimal source files of an already-seeded artifact. */
export function seedFiles(repos: TestRepos, artifactId: string, filePaths: string[]): void {
  repos.files.replaceFilesForArtifact(
    artifactId,
    filePaths.map((filePath) => ({
      filePath,
      content: `// ${filePath}`,
      contentBytes: 10,
      contentHash: `hash-${filePath}`
    }))
  );
}
