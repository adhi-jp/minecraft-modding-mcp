import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

// validate-mixin `warningCategoryFilter` must never flip the
// verdict. A target-not-found error has category "validation", so filtering
// to warningCategoryFilter:["parse"] drops that issue from the visible
// issues[] list -- but `valid`, `validationStatus` and `quickSummary` must
// still reflect the true (unfiltered) outcome.
test("validateMixin warningCategoryFilter does not flip valid/validationStatus for a target-not-found mixin", async () => {
  const { SourceService } = await import("../../src/source-service.ts");

  const root = await mkdtemp(join(tmpdir(), "warning-category-filter-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});

  const service = new SourceService(buildTestConfig(root));

  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).explorerService = {
    async getSignature() {
      throw new Error("class not found in jar");
    }
  };
  (service as any).mappingService = {
    async checkSymbolExists() {
      return { resolved: false };
    }
  };

  const source = [
    "import net.minecraft.server.Main;",
    "import org.spongepowered.asm.mixin.Mixin;",
    "",
    "@Mixin(Main.class)",
    "public abstract class MainMixin {}"
  ].join("\n");

  const filtered = await service.validateMixin({
    input: {
      mode: "inline",
      source
    },
    version: "1.21",
    mapping: "obfuscated",
    warningCategoryFilter: ["parse"]
  });

  const single = filtered.results[0]?.result;
  assert.ok(single, "expected a validation result");
  assert.equal(
    single!.valid,
    false,
    `expected target-not-found mixin to stay invalid under warningCategoryFilter, summary: ${JSON.stringify(single!.summary)}`
  );
  assert.notEqual(
    single!.validationStatus,
    "full",
    `expected validationStatus to not be "full", got: ${single!.validationStatus}`
  );
  assert.ok(
    single!.unfilteredSummary,
    "expected unfilteredSummary to be populated when warningCategoryFilter narrows the summary"
  );
  assert.equal(single!.unfilteredSummary!.definiteErrors, 1);
  assert.equal(filtered.summary.valid, 0);
  assert.equal(filtered.summary.invalid, 1);

  // Sanity: without the filter, the same mixin is reported invalid too.
  const unfiltered = await service.validateMixin({
    input: {
      mode: "inline",
      source
    },
    version: "1.21",
    mapping: "obfuscated"
  });
  const unfilteredSingle = unfiltered.results[0]?.result;
  assert.equal(unfilteredSingle?.valid, false);
  assert.equal(unfilteredSingle?.validationStatus, single!.validationStatus);
});

// adding warningCategoryFilter on top of minSeverity/hideUncertain
// must leave valid/validationStatus/quickSummary exactly what the same call
// WITHOUT the category filter would produce. The malformed-accessor fixture
// (see tests/source-service/validate-mixin-resolution.test.ts's
// buildBadAccessorSource / "hideUncertain recomputes parseWarnings summary")
// has a single uncertain-confidence, category:"parse" warning issue.
// hideUncertain:true alone hides it and recovers to "full"; adding
// warningCategoryFilter:["parse"] removes nothing further (the issue was
// already hidden by hideUncertain), so the outcome must be identical.
function buildBadAccessorSource(): string {
  return [
    "import net.minecraft.server.Main;",
    "import org.spongepowered.asm.mixin.Mixin;",
    "import org.spongepowered.asm.mixin.gen.Accessor;",
    "",
    "@Mixin(Main.class)",
    "public interface BadAccessorMixin {",
    "  @Accessor",
    "  int notAMethod;",
    "}"
  ].join("\n");
}

test("validateMixin warningCategoryFilter reproduces the hideUncertain/minSeverity-only outcome exactly", async () => {
  const { SourceService } = await import("../../src/source-service.ts");

  async function run(extra: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), "warning-category-filter-r2-"));
    const jarPath = join(root, "client.jar");
    await createJar(jarPath, {});
    const service = new SourceService(buildTestConfig(root));
    (service as any).versionService = {
      async resolveVersionJar(version: string) {
        return { version, jarPath };
      }
    };
    (service as any).explorerService = {
      async getSignature() {
        return { className: "net.minecraft.server.Main", constructors: [], methods: [], fields: [], warnings: [] };
      }
    };
    // Stubbed like the file's first test: without it the health check tries to
    // load a real mapping graph, and its outcome (a "Mapping health degraded"
    // note in quickSummary) can differ between the two calls being compared.
    (service as any).mappingService = {
      async checkMappingHealth() {
        return {
          mojangMappingsAvailable: true,
          tinyMappingsAvailable: true,
          memberRemapAvailable: true,
          degradations: []
        };
      }
    };

    const result = await service.validateMixin({
      input: { mode: "inline", source: buildBadAccessorSource() },
      version: "1.21",
      mapping: "obfuscated",
      ...extra
    });
    return result.results[0]?.result;
  }

  const hideUncertainOnly = await run({ hideUncertain: true });
  const hideUncertainPlusCategory = await run({ hideUncertain: true, warningCategoryFilter: ["parse"] });

  assert.equal(
    hideUncertainOnly?.validationStatus,
    "full",
    `sanity: hiding the only (uncertain) warning should recover to "full", got: ${hideUncertainOnly?.validationStatus}`
  );
  assert.equal(
    hideUncertainPlusCategory?.validationStatus,
    hideUncertainOnly?.validationStatus,
    `expected warningCategoryFilter to reproduce the hideUncertain-only validationStatus exactly, got: ${hideUncertainPlusCategory?.validationStatus} vs ${hideUncertainOnly?.validationStatus}`
  );
  assert.equal(hideUncertainPlusCategory?.valid, hideUncertainOnly?.valid);
  assert.equal(hideUncertainPlusCategory?.quickSummary, hideUncertainOnly?.quickSummary);

  const minSeverityOnly = await run({ minSeverity: "error" });
  const minSeverityPlusCategory = await run({ minSeverity: "error", warningCategoryFilter: ["parse"] });

  assert.equal(
    minSeverityPlusCategory?.validationStatus,
    minSeverityOnly?.validationStatus,
    `expected warningCategoryFilter to reproduce the minSeverity-only validationStatus exactly, got: ${minSeverityPlusCategory?.validationStatus} vs ${minSeverityOnly?.validationStatus}`
  );
  assert.equal(minSeverityPlusCategory?.valid, minSeverityOnly?.valid);
  assert.equal(minSeverityPlusCategory?.quickSummary, minSeverityOnly?.quickSummary);
});

// shouldRetryValidateMixinWithMavenFirst reads result.issues to
// decide retry eligibility when membersSkipped is 0. For a class-only mixin
// (no injections/shadows/accessors) whose target mapping fails under
// loom-first, the only signal is a "target-mapping-failed" issue -- category
// "mapping". warningCategoryFilter:["parse"] must not remove that issue
// before the retry decision is made, so the retry must trigger identically
// with and without the category filter.
test("validateMixin warningCategoryFilter does not change maven-first retry eligibility for a class-only mixin", async () => {
  const { SourceService } = await import("../../src/source-service.ts");

  async function run(extra: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), "warning-category-filter-retry-"));
    const jarPath = join(root, "client.jar");
    await createJar(jarPath, {});
    const service = new SourceService(buildTestConfig(root, { mappingSourcePriority: "loom-first" }));

    const seenPriorities: string[] = [];
    (service as any).versionService = {
      async resolveVersionJar(version: string) {
        return { version, jarPath };
      }
    };
    (service as any).workspaceMappingService = {
      async detectCompileMapping() {
        return { resolved: false, evidence: [], warnings: [] };
      },
      async detectProjectMinecraftVersion() {
        return undefined;
      }
    };
    (service as any).mappingService = {
      async checkMappingHealth() {
        return {
          mojangMappingsAvailable: true,
          tinyMappingsAvailable: true,
          memberRemapAvailable: true,
          degradations: []
        };
      },
      async findMapping(input: { sourcePriority?: string }) {
        seenPriorities.push(input.sourcePriority ?? "loom-first");
        if (input.sourcePriority === "maven-first") {
          return {
            resolved: true,
            status: "resolved",
            resolvedSymbol: { name: "a" },
            candidates: [],
            warnings: []
          };
        }
        return { resolved: false, status: "not_found", candidates: [], warnings: [] };
      },
      async checkSymbolExists() {
        return { resolved: true, status: "resolved", candidates: [], warnings: [] };
      }
    };
    (service as any).explorerService = {
      async getSignature(input: { fqn: string }) {
        if (input.fqn !== "a") {
          throw new Error(`missing bytecode for ${input.fqn}`);
        }
        return { className: "a", constructors: [], methods: [], fields: [], warnings: [] };
      }
    };

    const source = [
      "import net.minecraft.server.Main;",
      "import org.spongepowered.asm.mixin.Mixin;",
      "",
      "@Mixin(Main.class)",
      "public abstract class MainMixin {}"
    ].join("\n");

    const result = await service.validateMixin({
      input: { mode: "inline", source },
      version: "1.21",
      mapping: "mojang",
      reportMode: "full",
      ...extra
    });
    return { result, seenPriorities };
  }

  const baseline = await run({});
  const withCategoryFilter = await run({ warningCategoryFilter: ["parse"] });

  assert.ok(
    baseline.seenPriorities.includes("maven-first"),
    `sanity: baseline (no category filter) should retry with maven-first, saw: ${JSON.stringify(baseline.seenPriorities)}`
  );
  assert.ok(
    withCategoryFilter.seenPriorities.includes("maven-first"),
    `expected warningCategoryFilter:["parse"] to retry identically, saw: ${JSON.stringify(withCategoryFilter.seenPriorities)}`
  );
});
