import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  candidatePairKeys,
  compareCandidates,
  readTinyFileCandidate,
  resolveTinyIndexEntryBudget,
  selectTinyFiles
} from "../../src/mapping/loaders/tiny-loom-selection.ts";
import { loadTinyPairsFromLoom } from "../../src/mapping/loaders/tiny-loom.ts";
import type { DirectionIndex, PairKey } from "../../src/mapping/internal-types.ts";
import { lookupCandidates } from "../../src/mapping/lookup.ts";
import { mergeDirectionIndexes, createMethodSymbolRecord } from "../../src/mapping/parsers/symbol-records.ts";
import {
  countIndexEntries,
  parseTinyMappings,
  parseTinyMappingsInto
} from "../../src/mapping/parsers/tiny.ts";

const VERSION = "1.21.10";

/**
 * A Loom "final" rendering. Tiny v2 keeps one descriptor per member, expressed in the
 * FIRST namespace, so this file's descriptors are obfuscated coordinates (`La;`).
 */
const OFFICIAL_FIRST_TINY = [
  "tiny\t2\t0\tofficial\tintermediary\tnamed",
  "c\ta\tnet/minecraft/class_7833\tcom/mojang/math/Axis",
  "\tm\t(Lorg/joml/Vector3f;)La;\tof\tmethod_46356\tof",
  "\tf\tLa;\tb\tfield_40713\tXN"
].join("\n");

/**
 * The SAME mappings as {@link OFFICIAL_FIRST_TINY}, rendered the way Loom writes
 * `mappings-base.tiny`: namespace columns rotated so `intermediary` comes first, which
 * silently moves every descriptor into intermediary coordinates
 * (`Lnet/minecraft/class_7833;`).
 */
const INTERMEDIARY_FIRST_TINY = [
  "tiny\t2\t0\tintermediary\tnamed\tofficial",
  "c\tnet/minecraft/class_7833\tcom/mojang/math/Axis\ta",
  "\tm\t(Lorg/joml/Vector3f;)Lnet/minecraft/class_7833;\tmethod_46356\tof\tof",
  "\tf\tLnet/minecraft/class_7833;\tfield_40713\tXN\tb"
].join("\n");

/** A yarn-only rendering: no obfuscated column at all, so it carries pairs nothing else can. */
const YARN_ONLY_TINY = [
  "tiny\t2\t0\tintermediary\tnamed",
  "c\tnet/minecraft/class_1937\tnet/minecraft/world/level/Level",
  "\tm\t(Lnet/minecraft/class_1937;)V\tmethod_x\tdoThing"
].join("\n");

/** Complementary data that only exists in the second root. */
const COMPLEMENTARY_TINY = [
  "tiny\t2\t0\tofficial\tintermediary\tnamed",
  "c\tzz\tnet/minecraft/class_2680\tnet/minecraft/world/level/block/state/BlockState"
].join("\n");

async function makeWorkspace(prefix: string): Promise<{
  root: string;
  projectPath: string;
  gradleUserHome: string;
  writeProjectTiny: (relativePath: string, body: string) => Promise<string>;
  writeGradleHomeTiny: (relativePath: string, body: string) => Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectPath = join(root, "project");
  const gradleUserHome = join(root, "gradle-home");
  await mkdir(projectPath, { recursive: true });

  const writeUnder = async (base: string, relativePath: string, body: string): Promise<string> => {
    const target = join(base, VERSION, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, `${body}\n`, "utf8");
    return target;
  };

  return {
    root,
    projectPath,
    gradleUserHome,
    writeProjectTiny: (relativePath, body) =>
      writeUnder(join(projectPath, ".gradle", "loom-cache"), relativePath, body),
    writeGradleHomeTiny: (relativePath, body) =>
      writeUnder(join(gradleUserHome, "caches", "fabric-loom"), relativePath, body)
  };
}

function exactTargets(pairs: Map<PairKey, DirectionIndex>, pair: PairKey, key: string): string[] {
  return [...(pairs.get(pair)?.exact.get(key) ?? new Set<string>())].sort();
}

test("selectTinyFiles collapses byte-identical renderings copied into every layered variant directory", async () => {
  const workspace = await makeWorkspace("tiny-loom-dedup-");
  try {
    const paths = await Promise.all([
      workspace.writeGradleHomeTiny("layered-a/mappings.tiny", OFFICIAL_FIRST_TINY),
      workspace.writeGradleHomeTiny("layered-b/mappings.tiny", OFFICIAL_FIRST_TINY),
      workspace.writeGradleHomeTiny("layered-c/mappings.tiny", OFFICIAL_FIRST_TINY)
    ]);

    const selection = await selectTinyFiles([...paths].sort());
    assert.equal(selection.selected.length, 1, "identical bytes must be parsed once");
    assert.equal(selection.duplicateOf.size, 2);
    assert.equal(selection.selected[0]?.path, [...paths].sort()[0]);
    for (const duplicate of selection.duplicateOf.values()) {
      assert.equal(duplicate, selection.selected[0]?.path);
    }
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("selectTinyFiles drops an intermediary-first rendering whose namespace pairs are already covered", async () => {
  const workspace = await makeWorkspace("tiny-loom-conflict-");
  try {
    const primary = await workspace.writeGradleHomeTiny("layered/mappings.tiny", OFFICIAL_FIRST_TINY);
    const base = await workspace.writeGradleHomeTiny("layered/mappings-base.tiny", INTERMEDIARY_FIRST_TINY);

    const selection = await selectTinyFiles([base, primary].sort());
    assert.deepEqual(
      selection.selected.map((candidate) => candidate.path),
      [primary],
      "the obfuscated-coordinate rendering must win even though the base rendering is larger"
    );
    assert.deepEqual(
      selection.descriptorConflicts.map((candidate) => candidate.path),
      [base]
    );
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("selectTinyFiles keeps a differently-scoped rendering that contributes an uncovered namespace pair", async () => {
  const workspace = await makeWorkspace("tiny-loom-coverage-");
  try {
    const primary = await workspace.writeGradleHomeTiny("layered/mappings.tiny", OFFICIAL_FIRST_TINY);
    // intermediary-first like the dropped base rendering, but it is the only source of
    // intermediary<->yarn for class_1937, so the coverage clause must keep it.
    const yarnOnly = await workspace.writeGradleHomeTiny("yarn/yarn.tiny", YARN_ONLY_TINY);

    const selection = await selectTinyFiles([primary, yarnOnly].sort());
    assert.deepEqual(selection.descriptorConflicts, []);
    assert.deepEqual(
      selection.selected.map((candidate) => candidate.path).sort(),
      [primary, yarnOnly].sort()
    );
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("loadTinyPairsFromLoom does not admit a foreign-coordinate descriptor for a method the primary rendering already maps", async () => {
  const workspace = await makeWorkspace("tiny-loom-phantom-");
  try {
    await workspace.writeGradleHomeTiny("layered/mappings.tiny", OFFICIAL_FIRST_TINY);
    await workspace.writeGradleHomeTiny("layered/mappings-base.tiny", INTERMEDIARY_FIRST_TINY);

    const result = await loadTinyPairsFromLoom(VERSION, workspace.projectPath, workspace.gradleUserHome);
    const index = result.pairs.get("obfuscated->intermediary");
    assert.ok(index, "obfuscated->intermediary must be populated");

    // Merging both renderings registers the same method twice under two incompatible
    // descriptors, which makes the descriptorless fallback key ambiguous.
    assert.deepEqual(
      exactTargets(result.pairs, "obfuscated->intermediary", "a.of"),
      ["method|net.minecraft.class_7833|method_46356|(Lorg/joml/Vector3f;)La;"],
      "the descriptorless method key must resolve to exactly one record"
    );

    const candidates = lookupCandidates(index, createMethodSymbolRecord("a", "of", undefined));
    assert.equal(candidates.length, 1, "a name-only method query must not become ambiguous");
    assert.equal(candidates[0]?.descriptor, "(Lorg/joml/Vector3f;)La;");
    assert.equal(index.records.size, 3, "class + field + method, with no phantom duplicate");
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("loadTinyPairsFromLoom still merges complementary renderings across project and GRADLE_USER_HOME roots", async () => {
  const workspace = await makeWorkspace("tiny-loom-complementary-");
  try {
    await workspace.writeProjectTiny("mappings.tiny", OFFICIAL_FIRST_TINY);
    await workspace.writeGradleHomeTiny("mappings-mojang.tiny", COMPLEMENTARY_TINY);

    const result = await loadTinyPairsFromLoom(VERSION, workspace.projectPath, workspace.gradleUserHome);
    assert.deepEqual(
      exactTargets(result.pairs, "obfuscated->yarn", "a"),
      ["class|com.mojang.math|Axis|"]
    );
    assert.deepEqual(
      exactTargets(result.pairs, "obfuscated->yarn", "zz"),
      ["class|net.minecraft.world.level.block.state|BlockState|"],
      "a same-shaped rendering in another root must still be merged"
    );
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("loadTinyPairsFromLoom reports the file it actually merged as the mapping artifact", async () => {
  const workspace = await makeWorkspace("tiny-loom-artifact-");
  try {
    // Sorts before the real rendering alphabetically, so the pre-selection loader
    // would have reported this unusable file as the provenance.
    await workspace.writeGradleHomeTiny("aaa-not-a-mapping.tiny", "this is not a tiny header");
    const primary = await workspace.writeGradleHomeTiny("zzz-mappings.tiny", OFFICIAL_FIRST_TINY);

    const result = await loadTinyPairsFromLoom(VERSION, workspace.projectPath, workspace.gradleUserHome);
    assert.equal(result.mappingArtifact, primary);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("loadTinyPairsFromLoom stops at the index-entry budget and warns instead of growing without bound", async () => {
  const workspace = await makeWorkspace("tiny-loom-budget-");
  const previous = process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
  try {
    await workspace.writeGradleHomeTiny("layered/mappings.tiny", OFFICIAL_FIRST_TINY);
    await workspace.writeGradleHomeTiny("yarn/yarn.tiny", YARN_ONLY_TINY);
    process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES = "1";

    const result = await loadTinyPairsFromLoom(VERSION, workspace.projectPath, workspace.gradleUserHome);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /hit the 1-entry index budget/);
    assert.match(result.warnings[0] ?? "", /MCP_LOOM_TINY_MAX_INDEX_ENTRIES/);
  } finally {
    if (previous === undefined) {
      delete process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
    } else {
      process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES = previous;
    }
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("resolveTinyIndexEntryBudget honours an explicit override and otherwise scales with the free heap", () => {
  assert.equal(resolveTinyIndexEntryBudget("250000"), 250_000);
  assert.equal(resolveTinyIndexEntryBudget("not-a-number", { heap_size_limit: 4_000_000_000, used_heap_size: 0 }) > 1_000_000, true);
  // A nearly full heap still yields a usable floor rather than zero.
  assert.equal(
    resolveTinyIndexEntryBudget(undefined, { heap_size_limit: 1_000, used_heap_size: 1_000 }),
    1_000_000
  );
  // A huge heap is capped so the budget can never promise more than the guard is for.
  assert.equal(
    resolveTinyIndexEntryBudget(undefined, { heap_size_limit: 1e15, used_heap_size: 0 }),
    64_000_000
  );
});

test("parseTinyMappingsInto matches parse-then-merge exactly for multi-file input", () => {
  const bodies = [OFFICIAL_FIRST_TINY, COMPLEMENTARY_TINY, YARN_ONLY_TINY];

  const viaAccumulator = new Map<PairKey, DirectionIndex>();
  for (const body of bodies) {
    parseTinyMappingsInto(viaAccumulator, body);
  }

  const viaMerge = new Map<PairKey, DirectionIndex>();
  for (const body of bodies) {
    for (const [key, index] of parseTinyMappings(body).entries()) {
      const existing = viaMerge.get(key);
      if (!existing) {
        viaMerge.set(key, index);
      } else {
        mergeDirectionIndexes(existing, index);
      }
    }
  }

  const snapshot = (pairs: Map<PairKey, DirectionIndex>) =>
    [...pairs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, index]) => [
        key,
        [...index.exact.entries()].map(([k, v]) => [k, [...v].sort()]).sort(),
        [...index.normalized.entries()].map(([k, v]) => [k, [...v].sort()]).sort(),
        [...index.simple.entries()].map(([k, v]) => [k, [...v].sort()]).sort(),
        [...index.records.keys()].sort()
      ]);

  assert.deepEqual(snapshot(viaAccumulator), snapshot(viaMerge));
});

test("parseTinyMappingsInto adds no index entries when the same rendering is parsed again", () => {
  const target = new Map<PairKey, DirectionIndex>();
  const first = parseTinyMappingsInto(target, OFFICIAL_FIRST_TINY);
  assert.equal(first.parsed, true);
  assert.equal(first.truncated, false);
  assert.ok(first.indexEntries > 0);

  const second = parseTinyMappingsInto(target, OFFICIAL_FIRST_TINY);
  assert.equal(second.indexEntries, first.indexEntries, "a repeated rendering is pure overhead");
  assert.equal(countIndexEntries(target), first.indexEntries);
});

test("parseTinyMappingsInto stops on the entry budget and reports the truncation", () => {
  const target = new Map<PairKey, DirectionIndex>();
  const full = parseTinyMappingsInto(new Map<PairKey, DirectionIndex>(), OFFICIAL_FIRST_TINY);
  const bounded = parseTinyMappingsInto(target, OFFICIAL_FIRST_TINY, { maxIndexEntries: 1 });

  assert.equal(bounded.parsed, true);
  assert.equal(bounded.truncated, false, "a file shorter than the check interval runs to completion");
  assert.equal(bounded.indexEntries, full.indexEntries);

  // A second parse starts already over budget and must refuse before adding anything.
  const again = parseTinyMappingsInto(target, COMPLEMENTARY_TINY, { maxIndexEntries: 1 });
  assert.equal(again.truncated, true);
  assert.equal(again.indexEntries, full.indexEntries, "nothing may be added once the budget is spent");
});

test("readTinyFileCandidate classifies a file from its header alone and rejects non-tiny bodies", async () => {
  const workspace = await makeWorkspace("tiny-loom-header-");
  try {
    const official = await workspace.writeGradleHomeTiny("mappings.tiny", OFFICIAL_FIRST_TINY);
    const base = await workspace.writeGradleHomeTiny("mappings-base.tiny", INTERMEDIARY_FIRST_TINY);
    const junk = await workspace.writeGradleHomeTiny("junk.tiny", "not a tiny file at all");
    const tooFewNamespaces = await workspace.writeGradleHomeTiny("srg.tiny", "tiny\t2\t0\tsrg\tmcp\nc\ta\tb");

    const officialCandidate = await readTinyFileCandidate(official);
    assert.equal(officialCandidate?.descriptorNamespace, "obfuscated", "official normalizes to obfuscated");
    assert.deepEqual(officialCandidate?.namespaces, ["obfuscated", "intermediary", "yarn"]);

    const baseCandidate = await readTinyFileCandidate(base);
    assert.equal(baseCandidate?.descriptorNamespace, "intermediary");

    assert.equal(await readTinyFileCandidate(junk), undefined);
    assert.equal(await readTinyFileCandidate(tooFewNamespaces), undefined);
    assert.equal(await readTinyFileCandidate(join(workspace.root, "missing.tiny")), undefined);

    assert.ok(officialCandidate && baseCandidate);
    assert.equal(
      compareCandidates(baseCandidate, officialCandidate) > 0,
      true,
      "the obfuscated-coordinate rendering sorts first despite the base rendering being larger"
    );
    assert.deepEqual(candidatePairKeys(officialCandidate).sort(), [
      "intermediary->obfuscated",
      "intermediary->yarn",
      "obfuscated->intermediary",
      "obfuscated->yarn",
      "yarn->intermediary",
      "yarn->obfuscated"
    ]);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("resolveTinyIndexEntryBudget ignores an override that is not a plain integer instead of truncating it", () => {
  const previous = process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
  delete process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
  try {
    const heap = { heap_size_limit: 4_000_000_000, used_heap_size: 0 };
    // floor(4_000_000_000 * 0.7 / 340), inside the 1M..64M clamp.
    const derived = 8_235_294;
    assert.equal(resolveTinyIndexEntryBudget(undefined, heap), derived);

    // Number.parseInt would read these as 1, 2, 10 and 1 respectively, silently
    // capping the index at a handful of entries and truncating every Loom load.
    for (const malformed of ["1e9", "2_000_000", "10M", "1.9", " 250000", "-5", "0"]) {
      assert.equal(
        resolveTinyIndexEntryBudget(malformed, heap),
        derived,
        `"${malformed}" must fall back to the heap-derived budget`
      );
    }

    // A plain integer is still honoured verbatim, with no floor applied.
    assert.equal(resolveTinyIndexEntryBudget("250000", heap), 250_000);
    assert.equal(resolveTinyIndexEntryBudget("1", heap), 1);
  } finally {
    if (previous === undefined) {
      delete process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
    } else {
      process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES = previous;
    }
  }
});
