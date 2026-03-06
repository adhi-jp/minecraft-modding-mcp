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
  assert.deepEqual(packageJson.files, ["dist/**/*.js", "dist/**/*.d.ts", "README.md", "LICENSE", "CHANGELOG.md"]);
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.deepEqual(packageJson.engines, { node: ">=22" });
  assert.equal(packageJson.scripts?.clean, "node --input-type=module -e \"import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true });\"");
  assert.equal(packageJson.scripts?.build, "npm run clean && tsc -p tsconfig.json");
  assert.equal(packageJson.scripts?.prepack, "npm run build");
  assert.equal(packageJson.scripts?.dev, "tsx src/cli.ts");
  assert.equal(packageJson.scripts?.start, "node dist/cli.js");
  assert.equal(
    packageJson.scripts?.["test:coverage"],
    "node --test --import tsx --experimental-test-coverage --test-coverage-lines=80 --test-coverage-branches=70 --test-coverage-functions=80 tests/*.test.ts"
  );
  assert.equal(
    packageJson.scripts?.["test:coverage:lcov"],
    "node --input-type=module -e \"import { mkdirSync } from 'node:fs'; mkdirSync('coverage', { recursive: true });\" && node --test --import tsx --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info --test-coverage-lines=80 --test-coverage-branches=70 --test-coverage-functions=80 tests/*.test.ts"
  );
  assert.equal(
    packageJson.scripts?.validate,
    "npm run check && npm test && npm run test:coverage && npm run test:perf"
  );
  assert.equal(
    packageJson.scripts?.["test:manual:package-smoke"],
    "node --import tsx tests/manual/package-distribution-smoke.manual.ts"
  );
});
