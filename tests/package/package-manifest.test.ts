import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type PackageJson = {
  main?: unknown;
  types?: unknown;
  bin?: unknown;
  files?: unknown;
  publishConfig?: Record<string, unknown>;
  engines?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
};

test("package.json declares distribution entrypoints and include list", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

  assert.equal(packageJson.main, "dist/index.js");
  assert.equal(packageJson.types, "dist/index.d.ts");
  assert.deepEqual(packageJson.bin, {
    "minecraft-modding-mcp": "dist/cli.js"
  });
  assert.deepEqual(packageJson.files, [
    "dist/**/*.js",
    "dist/**/*.d.ts",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "docs/README-ja.md",
    "docs/examples.md",
    "docs/tool-reference.md"
  ]);
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.deepEqual(packageJson.engines, { node: ">=22.13.0" });
  assert.equal(packageJson.scripts?.clean, "node --input-type=module -e \"import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true });\"");
  assert.equal(packageJson.scripts?.build, "pnpm run clean && tsc -p tsconfig.json");
  assert.equal(packageJson.scripts?.prepack, "pnpm run build");
  assert.equal(packageJson.scripts?.dev, "tsx src/cli.ts");
  assert.equal(packageJson.scripts?.start, "node dist/cli.js");
  assert.equal(packageJson.scripts?.test, "node scripts/run-tests.mjs");
  assert.equal(packageJson.scripts?.["test:file"], "node --test --import tsx");
  assert.equal(packageJson.scripts?.["test:grep"], "node scripts/run-tests.mjs --test-name-pattern");
  assert.equal(
    packageJson.scripts?.["test:coverage"],
    "node scripts/run-tests.mjs --coverage"
  );
  assert.equal(
    packageJson.scripts?.["test:coverage:lcov"],
    "node scripts/run-tests.mjs --coverage --lcov coverage/lcov.info"
  );
  assert.equal(
    packageJson.scripts?.validate,
    "pnpm run check && pnpm test && pnpm run test:coverage && pnpm run test:perf"
  );
  assert.equal(
    packageJson.scripts?.["test:manual:package-smoke"],
    "node --import tsx tests/manual/package-distribution-smoke.manual.ts"
  );
  assert.equal(packageJson.scripts?.["test:manual:mcp-use-smoke"], undefined);
});

test("package distribution smoke guards CLI startup when stdio pipes close immediately", async () => {
  const source = await readFile("tests/manual/package-distribution-smoke.manual.ts", "utf8");

  assert.match(source, /REQUIRED_DOC_ENTRIES/);
  assert.match(source, /package\/docs\/README-ja\.md/);
  assert.match(source, /package\/docs\/examples\.md/);
  assert.match(source, /package\/docs\/tool-reference\.md/);
  assert.match(source, /async function stopCliChild/);
  assert.match(source, /child\.stdin\.end\(\)/);
  assert.match(source, /async function canUseStdioPipeReliably\(\): Promise<boolean>/);
  assert.match(source, /Package distribution smoke: tarball contents validated; CLI startup skipped because stdin pipe closes immediately in this runtime\./);
});
