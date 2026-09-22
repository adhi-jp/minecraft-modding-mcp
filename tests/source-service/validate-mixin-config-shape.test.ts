import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

// validate-mixin config mode only guards file read + JSON.parse
// inside the input-validation catch. A config that parses successfully but
// has the wrong shape (null, a non-object, a non-array mixins/client/server,
// or a non-string package) later throws a raw TypeError when that field is
// used, which becomes ERR_INTERNAL at the tool boundary instead of
// ERR_INVALID_INPUT.
//
// the shape check validates the containers but not their
// elements, so a non-string entry inside mixins/client/server (e.g. a
// number) passes the guard and later throws at the fqcn.replace(...) call
// (or is silently coerced into a bogus class name when package is
// non-empty). Every element of mixins/client/server must be a string.
test("SourceService validateMixin config mode rejects malformed config shapes with ERR_INVALID_INPUT", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  type ValidateMixinArgs = Parameters<InstanceType<typeof SourceService>["validateMixin"]>[0];
  const cases: Array<{
    name: string;
    configContent: string;
    expectedKey?: string;
    expectedIndex?: number;
  }> = [
    { name: "config parses to null", configContent: "null" },
    { name: "config parses to a non-object (array)", configContent: "[]" },
    { name: "config parses to a non-object (string)", configContent: "\"oops\"" },
    { name: "mixins field is not an array", configContent: JSON.stringify({ package: "demo", mixins: "NotAnArray" }), expectedKey: "mixins" },
    { name: "client field is not an array", configContent: JSON.stringify({ package: "demo", client: 42 }), expectedKey: "client" },
    { name: "server field is not an array", configContent: JSON.stringify({ package: "demo", server: { nope: true } }), expectedKey: "server" },
    { name: "package field is not a string", configContent: JSON.stringify({ package: 123, mixins: ["Foo"] }), expectedKey: "package" },
    { name: "mixins array contains a non-string element", configContent: JSON.stringify({ package: "demo", mixins: [42] }), expectedKey: "mixins", expectedIndex: 0 },
    { name: "client array contains a non-string element", configContent: JSON.stringify({ package: "demo", client: ["Ok", 7] }), expectedKey: "client", expectedIndex: 1 },
    { name: "server array contains a non-string element", configContent: JSON.stringify({ package: "demo", server: [null] }), expectedKey: "server", expectedIndex: 0 }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "validate-mixin-config-shape-"));
      const configPath = join(root, "bad.mixins.json");
      await writeFile(configPath, testCase.configContent, "utf8");
      const service = new SourceService(buildTestConfig(root));

      const args: ValidateMixinArgs = {
        input: { mode: "config", configPaths: [configPath] },
        version: "1.21",
        mapping: "obfuscated"
      };

      await assert.rejects(
        () => service.validateMixin(args),
        (err: unknown) => {
          const appError = err as { code?: string; message?: string; details?: Record<string, unknown> };
          assert.equal(
            appError.code,
            ERROR_CODES.INVALID_INPUT,
            `${testCase.name}: expected ERR_INVALID_INPUT, got ${appError.code}: ${appError.message}`
          );
          assert.equal(appError.details?.failedStage, "input-validation");
          assert.match(String(appError.message), new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          if (testCase.expectedKey) {
            assert.match(
              String(appError.message),
              new RegExp(testCase.expectedKey),
              `${testCase.name}: expected message to name the offending key "${testCase.expectedKey}", got: ${appError.message}`
            );
          }
          if (testCase.expectedIndex !== undefined) {
            assert.match(
              String(appError.message),
              new RegExp(String(testCase.expectedIndex)),
              `${testCase.name}: expected message to name the offending index ${testCase.expectedIndex}, got: ${appError.message}`
            );
          }
          return true;
        }
      );
    });
  }
});
