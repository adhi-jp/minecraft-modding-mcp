import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_TOOLS = [
  "list-versions",
  "resolve-artifact",
  "find-class",
  "get-class-source",
  "get-class-members",
  "search-class-source",
  "get-artifact-file",
  "list-artifact-files",
  "trace-symbol-lifecycle",
  "diff-class-signatures",
  "find-mapping",
  "resolve-method-mapping-exact",
  "get-class-api-matrix",
  "resolve-workspace-symbol",
  "check-symbol-exists",
  "nbt-to-json",
  "nbt-apply-json-patch",
  "json-to-nbt",
  "index-artifact",
  "get-runtime-metrics",
  "validate-mixin",
  "validate-access-widener",
  "analyze-mod-jar",
  "get-registry-data",
  "compare-versions",
  "decompile-mod-jar",
  "get-mod-class-source",
  "search-mod-source",
  "remap-mod-jar"
] as const;

test("index.ts registers the expected MCP tools without mc prefix", async () => {
  const source = await readFile("src/index.ts", "utf8");

  for (const toolName of EXPECTED_TOOLS) {
    assert.match(source, new RegExp(`server\\.tool\\("${toolName}"`));
  }

  const registrations = source.match(/server\.tool\(/g) ?? [];
  assert.equal(registrations.length, EXPECTED_TOOLS.length);
});

test("index.ts does not include legacy compatibility handlers", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.doesNotMatch(source, /server\.tool\("mc-/);
  assert.doesNotMatch(source, /mc-list-versions/);
  assert.doesNotMatch(source, /mc-resolve-source/);
  assert.doesNotMatch(source, /mc-get-source/);
  assert.doesNotMatch(source, /mc-search-source/);
  assert.doesNotMatch(source, /mc-query-symbols/);
  assert.doesNotMatch(source, /mc-get-source-context/);
  assert.doesNotMatch(source, /mc-get-source-file/);
  assert.doesNotMatch(source, /mc-resolve-context/);
  assert.doesNotMatch(source, /mc-find-symbol/);
  assert.doesNotMatch(source, /mc-get-class-index/);
  assert.doesNotMatch(source, /mc-get-signature/);
  assert.doesNotMatch(source, /mc-map-name/);
  assert.doesNotMatch(source, /mc-trace-usage/);
});

test("index.ts accepts expanded mapping enum in tool inputs", async () => {
  const source = await readFile("src/index.ts", "utf8");

  const mappingDescriptionMatches =
    source.match(/\.describe\("obfuscated \| mojang \| intermediary \| yarn/g) ?? [];
  assert.ok(mappingDescriptionMatches.length >= 4);
  assert.match(source, /const SOURCE_MAPPINGS = \["obfuscated", "mojang", "intermediary", "yarn"\] as const;/);
  assert.doesNotMatch(source, /const SOURCE_MAPPINGS = \["official", "mojang", "intermediary", "yarn"\] as const;/);
  assert.match(source, /sourceMapping:/);
});

test("index.ts coerces numeric string inputs for positive integer params", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const optionalPositiveInt = z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\);/);
  assert.match(source, /const POSITIVE_INT_FIELD_NAMES = new Set\(\[/);
  assert.match(source, /function coerceKnownNumericStrings\(value: unknown\): unknown/);
  assert.match(source, /typeof entry === "string" && POSITIVE_INT_FIELD_NAMES\.has\(key\)/);
  assert.match(source, /Number\.parseInt\(trimmed, 10\)/);
  assert.match(source, /const normalizedInput = coerceKnownNumericStrings\(rawInput\);/);
  assert.match(source, /schema\.parse\(normalizedInput\)/);
});

test("index.ts rejects removed official mapping namespace with obfuscated replacement hint", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const MAPPING_FIELD_NAMES = new Set\(\["mapping", "sourceMapping", "targetMapping", "classNameMapping"\]\);/);
  assert.match(source, /function collectRemovedOfficialNamespacePaths\(/);
  assert.match(source, /The "official" mapping namespace was removed\. Use "obfuscated" instead\./);
  assert.match(source, /"official" is no longer supported for this field\. Use "obfuscated"\./);
});

test("index.ts accepts mapping source priority override inputs", async () => {
  const source = await readFile("src/index.ts", "utf8");

  const priorityDescriptionMatches =
    source.match(/\.describe\("loom-first \| maven-first"\)/g) ?? [];
  assert.ok(priorityDescriptionMatches.length >= 4);
  assert.match(source, /const SOURCE_PRIORITIES = \["loom-first", "maven-first"\] as const;/);
});

test("index.ts documents validate-mixin mode-based input schema", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const nonEmptyString = z\.string\(\)\.trim\(\)\.min\(1\);/);
  assert.match(source, /input:\s*z\.discriminatedUnion\("mode"/);
  assert.match(source, /configPaths:\s*z\.array\(nonEmptyString\)\.min\(1\)/);
});

test("index.ts uses unified target objects for source resolution tools", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const resolveArtifactBlock = source.match(/const resolveArtifactShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const classSourceBlock = source.match(/const getClassSourceShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const classMembersBlock = source.match(/const getClassMembersShape = \{[\s\S]*?\n\};/)?.[0] ?? "";

  assert.match(resolveArtifactBlock, /target:\s*z\.object\(\{\s*kind:\s*targetKindSchema,\s*value:\s*nonEmptyString/s);
  assert.match(source, /type:\s*z\.literal\("artifact"\),\s*artifactId:\s*nonEmptyString/s);
  assert.match(source, /type:\s*z\.literal\("resolve"\),\s*kind:\s*targetKindSchema,\s*value:\s*nonEmptyString/s);
  assert.doesNotMatch(resolveArtifactBlock, /targetKind:/);
  assert.doesNotMatch(classSourceBlock, /artifactId:/);
  assert.doesNotMatch(classSourceBlock, /targetKind:/);
  assert.doesNotMatch(classMembersBlock, /artifactId:/);
  assert.doesNotMatch(classMembersBlock, /targetKind:/);
});

test("index.ts removes kind from resolve-method-mapping-exact contract", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const block = source.match(/const resolveMethodMappingExactShape = \{[\s\S]*?\n\};/)?.[0] ?? "";

  assert.match(block, /version:\s*nonEmptyString[\s\S]*owner:\s*nonEmptyString[\s\S]*descriptor:\s*nonEmptyString/s);
  assert.doesNotMatch(block, /kind:/);
  assert.doesNotMatch(source, /resolve-method-mapping-exact requires kind=method/);
});

test("index.ts reshapes validate-mixin around mode-based input", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const validateMixinShape = \{[\s\S]*input:\s*z\.discriminatedUnion\("mode"/s);
  assert.match(source, /mode:\s*z\.literal\("inline"\),\s*source:\s*nonEmptyString/s);
  assert.match(source, /mode:\s*z\.literal\("path"\),\s*path:\s*nonEmptyString/s);
  assert.match(source, /mode:\s*z\.literal\("paths"\),\s*paths:\s*z\.array\(nonEmptyString\)\.min\(1\)/s);
  assert.match(source, /mode:\s*z\.literal\("config"\),\s*configPaths:\s*z\.array\(nonEmptyString\)\.min\(1\)/s);
  assert.match(source, /sourceRoots:\s*z\.array\(z\.string\(\)\.min\(1\)\)\.optional\(\)/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*sourcePath:/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*sourcePaths:/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*mixinConfigPath:/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*sourceRoot:/);
});

test("index.ts documents symbol-query grammar for mapping tools", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /kind:\s*workspaceSymbolKindSchema\.describe\("class \| field \| method"\)/);
  assert.match(source, /name:\s*nonEmptyString/);
  assert.match(source, /owner:\s*optionalNonEmptyString/);
  assert.match(source, /descriptor:\s*optionalNonEmptyString/);
});

test("index.ts documents exact method mapping and workspace symbol tools", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /server\.tool\("resolve-method-mapping-exact"/);
  assert.match(source, /server\.tool\("get-class-api-matrix"/);
  assert.match(source, /server\.tool\("resolve-workspace-symbol"/);
  assert.match(source, /server\.tool\("check-symbol-exists"/);
  assert.match(source, /\.describe\("class \| field \| method"\)/);
  assert.doesNotMatch(source, /memberName:/);
});

test("index.ts formats tool responses with result/error/meta envelope", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /result:/);
  assert.match(source, /error:/);
  assert.match(source, /meta:/);
  assert.match(source, /patch:\s*z\.array\(/);
});

test("index.ts validates includeKinds values instead of silently ignoring invalid kinds", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const classApiKindsSchema = z\.string\(\)/);
  assert.doesNotMatch(source, /includeKinds:\s*z\.string\(\)\.optional\(\)/);
});

test("index.ts maps NBT parse failures to bad request status", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /code === ERROR_CODES\.NBT_PARSE_FAILED/);
});

test("index.ts remap target enum includes yarn and mojang", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const REMAP_TARGETS = \["yarn", "mojang"\] as const;/);
});

// ── Resources integration ──────────────────────────────────────────

const EXPECTED_FIXED_RESOURCES = ["versions-list", "runtime-metrics"] as const;

const EXPECTED_TEMPLATE_RESOURCES = [
  "class-source",
  "artifact-file",
  "find-mapping",
  "class-members",
  "artifact-metadata"
] as const;

const ALL_RESOURCES = [...EXPECTED_FIXED_RESOURCES, ...EXPECTED_TEMPLATE_RESOURCES] as const;

test("resources.ts registers the expected fixed and template resources", async () => {
  const source = await readFile("src/resources.ts", "utf8");

  for (const name of ALL_RESOURCES) {
    assert.match(source, new RegExp(`server\\.resource\\("${name}"`));
  }

  const registrations = source.match(/server\.resource\(/g) ?? [];
  assert.equal(registrations.length, ALL_RESOURCES.length);
});

test("resources.ts uses ResourceTemplate for template resources", async () => {
  const source = await readFile("src/resources.ts", "utf8");

  const templateConstructors = source.match(/new ResourceTemplate\(/g) ?? [];
  assert.equal(templateConstructors.length, EXPECTED_TEMPLATE_RESOURCES.length);
});

test("index.ts calls registerResources", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /registerResources\(server,\s*sourceService\)/);
  assert.match(source, /import\s*\{[^}]*registerResources[^}]*\}\s*from\s*"\.\/resources\.js"/);
});


test("index.ts lazily initializes SourceService to reduce startup overhead", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /let\s+sourceServiceInstance:\s*SourceService\s*\|\s*undefined/);
  assert.match(source, /function\s+getSourceService\(\):\s*SourceService/);
  assert.match(source, /sourceServiceInstance\s*\?\?=\s*new\s+SourceService\(config\)/);
  assert.match(source, /const\s+sourceService\s*=\s*new\s+Proxy\(/);
  assert.doesNotMatch(source, /setImmediate\(getSourceService\)/);
});

test("get-class-members contract preserves actual mappingApplied metadata", async () => {
  const serviceSource = await readFile("src/source-service.ts", "utf8");

  assert.match(
    serviceSource,
    /async getClassMembers[\s\S]*requestedMapping,[\s\S]*mappingApplied,[\s\S]*provenance: normalizedProvenance/
  );
  assert.doesNotMatch(
    serviceSource,
    /async getClassMembers[\s\S]*mappingApplied:\s*requestedMapping/
  );
});

test("CLI entrypoint delegates startup to async startServer export", async () => {
  const indexSource = await readFile("src/index.ts", "utf8");
  const cliSource = await readFile("src/cli.ts", "utf8");

  assert.match(indexSource, /export async function startServer\(\): Promise<void>/);
  assert.match(cliSource, /^#!\/usr\/bin\/env node/m);
  assert.match(cliSource, /import\s+\{\s*startServer\s*\}\s+from\s+"\.\/index\.js"/);
  assert.match(cliSource, /startServer\(\)\s*\.then/);
  assert.match(cliSource, /\.catch\(\(err\)\s*=>/);
});

test("startServer installs process-level error handlers", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /process\.on\("uncaughtException"/);
  assert.match(source, /process\.on\("unhandledRejection"/);
  assert.match(source, /attachProcessErrorHandlers\(\)/);
});

test("index.ts uses compatibility stdio transport for newline and Content-Length clients", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /import\s+\{\s*CompatStdioServerTransport\s*\}\s+from\s+"\.\/compat-stdio-transport\.js"/);
  assert.match(source, /new CompatStdioServerTransport\(\)/);
  assert.doesNotMatch(source, /server\/stdio\.js/);
});
