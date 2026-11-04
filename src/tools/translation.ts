import { ALIAS_TOOL_INVENTORY, aliasInventoryEntry } from "./inventory.js";
import { isCallableCatalogTool } from "./next-actions.js";
import type { CatalogNextAction, ServiceSuggestedCall } from "./types.js";

/**
 * Turns a follow-up call a service suggested under an 8.x tool name into the
 * equivalent catalog call, or `undefined` to drop it.
 */
export type ServiceCallTranslator = (call: ServiceSuggestedCall) => CatalogNextAction | undefined;

/** No catalog tool takes over this suggestion yet, so a catalog reply drops it. */
const dropServiceCall: ServiceCallTranslator = () => undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(params: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (params[key] !== undefined) picked[key] = params[key];
  }
  return picked;
}

/**
 * The catalog `target` for an 8.x request: a flat `artifactId`, or an 8.x
 * `target` (`{ kind, value }`, workspace or dependency) with the top-level
 * `projectPath` and `scope` placed inside it where the catalog kind takes them.
 */
function catalogTargetOf(params: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof params.artifactId === "string") {
    return { kind: "artifact", artifactId: params.artifactId };
  }
  const target = params.target;
  if (!isRecord(target)) return undefined;
  const projectPath = typeof params.projectPath === "string" ? { projectPath: params.projectPath } : {};
  const scope = target.scope ?? params.scope;
  const scoped = scope !== undefined ? { scope } : {};
  switch (target.kind) {
    case "artifact":
      return { kind: "artifact", artifactId: target.artifactId };
    case "version":
      return { kind: "version", version: target.value, ...projectPath, ...scoped };
    case "jar":
      return { kind: "jar", jarPath: target.value };
    case "coordinate":
      return { kind: "coordinate", coordinate: target.value };
    case "workspace":
      return { kind: "workspace", ...projectPath, ...scoped };
    case "dependency":
      return {
        kind: "dependency",
        group: target.group,
        name: target.name,
        ...(target.version !== undefined ? { dependencyVersion: target.version } : projectPath)
      };
    default:
      return undefined;
  }
}

/**
 * Builds a translator for an 8.x tool whose catalog replacement takes a
 * target plus `keys`. A version target of `"latest"` names no real version,
 * so it becomes a template whose `<version>` comes from `version-list`.
 */
function targetedTranslator(tool: string, keys: readonly string[]): ServiceCallTranslator {
  return (call) => {
    const target = catalogTargetOf(call.params);
    if (target === undefined) return undefined;
    const rest = pick(call.params, keys);
    if (target.kind === "version" && target.version === "latest") {
      return {
        tool,
        params: { target: { ...target, version: "<version>" }, ...rest },
        reason: "Pick a Minecraft version from version-list and put it in place of <version>.",
        template: true
      };
    }
    return { tool, params: { target, ...rest } };
  };
}

/**
 * Builds a translator for an 8.x single-class tool whose catalog replacement
 * takes `classes`: `className` becomes a one-class list, the `keys` are kept,
 * and each 8.x option named in `renames` takes its catalog name.
 */
function classItemTranslator(
  tool: string,
  keys: readonly string[],
  renames: Readonly<Record<string, string>>
): ServiceCallTranslator {
  const targeted = targetedTranslator(tool, keys);
  return (call) => {
    const className = call.params.className;
    if (typeof className !== "string") return undefined;
    const translated = targeted(call);
    if (translated === undefined) return undefined;
    const renamed: Record<string, unknown> = {};
    for (const [from, to] of Object.entries(renames)) {
      if (call.params[from] !== undefined) renamed[to] = call.params[from];
    }
    return { ...translated, params: { ...translated.params, classes: [className], ...renamed } };
  };
}

const SYMBOL_KINDS = new Set(["class", "field", "method"]);

/**
 * The catalog symbol of an 8.x symbol request: a class's `name` is its
 * `className`; a member's `owner` is its `className` and its `name` the
 * `memberName`.
 */
function catalogSymbolOf(params: Record<string, unknown>, kind = params.kind): Record<string, unknown> | undefined {
  const { name, owner, descriptor } = params;
  if (typeof kind !== "string" || !SYMBOL_KINDS.has(kind) || typeof name !== "string") return undefined;
  if (kind === "class") return { kind, className: name };
  if (typeof owner !== "string") return undefined;
  return { kind, className: owner, memberName: name, ...(typeof descriptor === "string" ? { descriptor } : {}) };
}

/** The catalog version target of an 8.x symbol request (`version`, optionally `projectPath`). */
function symbolVersionTarget(params: Record<string, unknown>, withProjectPath: boolean): Record<string, unknown> | undefined {
  if (typeof params.version !== "string") return undefined;
  return {
    kind: "version",
    version: params.version,
    ...(withProjectPath && typeof params.projectPath === "string" ? { projectPath: params.projectPath } : {})
  };
}

/**
 * Builds a translator for an 8.x symbol tool whose catalog replacement takes
 * one `symbols` item, `mapping` from `sourceMapping`, `toMapping` from
 * `targetMapping` (when `withToMapping`), and the `keys` kept as they are.
 */
function symbolItemTranslator(
  tool: string,
  options: { withToMapping: boolean; withProjectPath: boolean; keys: readonly string[]; extra?: Record<string, unknown>; kind?: string }
): ServiceCallTranslator {
  return (call) => {
    const target = symbolVersionTarget(call.params, options.withProjectPath);
    const symbol = catalogSymbolOf(call.params, options.kind ?? call.params.kind);
    const { sourceMapping, targetMapping } = call.params;
    if (target === undefined || symbol === undefined || typeof sourceMapping !== "string") return undefined;
    if (options.withToMapping && typeof targetMapping !== "string") return undefined;
    return {
      tool,
      params: {
        target,
        mapping: sourceMapping,
        ...(options.withToMapping ? { toMapping: targetMapping } : {}),
        symbols: [symbol],
        ...(options.extra ?? {}),
        ...pick(call.params, options.keys)
      }
    };
  };
}

/** `includeKinds` of 8.x `get-class-api-matrix` (a comma-separated string) as catalog `kinds`. */
function kindsOf(includeKinds: unknown): string[] | undefined {
  const tokens = Array.isArray(includeKinds)
    ? includeKinds
    : typeof includeKinds === "string"
      ? includeKinds.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0)
      : [];
  return tokens.length > 0 ? tokens.map(String) : undefined;
}

/** The `mixin-validate` input form of an 8.x mixin `input` (`{ mode, … }`). */
function mixinInputFormOf(input: Record<string, unknown>): Record<string, unknown> | undefined {
  switch (input.mode) {
    case "inline":
      return typeof input.source === "string" ? { source: input.source } : undefined;
    case "path":
      return typeof input.path === "string" ? { paths: [input.path] } : undefined;
    case "paths":
      return Array.isArray(input.paths) ? { paths: input.paths } : undefined;
    case "config":
      return Array.isArray(input.configPaths) ? { configPaths: input.configPaths } : undefined;
    case "project":
      return typeof input.path === "string" ? { discover: true, projectPath: input.path } : undefined;
    default:
      return undefined;
  }
}

/**
 * An 8.x `validate-project` call as its catalog call: `project-summary` is
 * `project-validate`, `mixin` is `mixin-validate` (whose `mapping` is
 * required without `projectPath`, so a call without one gets a `<mapping>`
 * placeholder). Suggestions for the access-widener and access-transformer
 * tasks are dropped: the only ones services make carry a fixed example
 * version rather than the caller's, so they are not calls to run as given.
 */
function validateProjectTranslator(call: ServiceSuggestedCall): CatalogNextAction | undefined {
  const { task, subject } = call.params;
  if (!isRecord(subject)) return undefined;
  const shared = pick(call.params, ["version", "mapping", "scope", "detail"]);
  if (task === "project-summary" && typeof subject.projectPath === "string") {
    const discover = Array.isArray(subject.discover) && subject.discover.length > 0 ? { discover: subject.discover } : {};
    return { tool: "project-validate", params: { projectPath: subject.projectPath, ...discover, ...shared } };
  }
  if (task === "mixin" && isRecord(subject.input)) {
    const form = mixinInputFormOf(subject.input);
    if (form === undefined) return undefined;
    const mapping = form.projectPath === undefined && shared.mapping === undefined ? { mapping: "<mapping>" } : {};
    return { tool: "mixin-validate", params: { ...form, ...shared, ...mapping } };
  }
  return undefined;
}

const RESOLUTION_TUNING_KEYS = [
  "mapping",
  "sourcePriority",
  "allowDecompile",
  "gradleUserHome",
  "preferProjectVersion",
  "strictVersion"
] as const;

/**
 * Every 8.x tool name that code shared with catalog tools (services, the
 * entry-tool modules, the execution gate) writes into a structured suggested
 * call, a result-level next action, or warning, hint and `nextAction` text.
 * Structured suggestions naming one of these tools are rewritten by its
 * translator; suggestions naming any other non-catalog tool are dropped. Text
 * is rewritten for every 8.x name by `translateToolNamesInText`.
 */
export const SERVICE_HINT_TRANSLATIONS: Readonly<Record<string, ServiceCallTranslator>> = {
  "analyze-mod": dropServiceCall,
  "batch-mappings": dropServiceCall,
  "batch-symbol-exists": dropServiceCall,
  "check-symbol-exists": symbolItemTranslator("symbol-check", {
    withToMapping: false,
    withProjectPath: false,
    keys: ["nameMode", "signatureMode", "maxCandidates"]
  }),
  "compare-minecraft": dropServiceCall,
  "find-class": targetedTranslator("class-find", ["className", "limit"]),
  "find-mapping": symbolItemTranslator("symbol-map", {
    withToMapping: true,
    withProjectPath: true,
    keys: ["nameMode", "signatureMode", "maxCandidates"]
  }),
  "get-artifact-file": targetedTranslator("file-read", ["filePath", "maxBytes"]),
  "get-class-api-matrix": (call) => {
    const { version, className, classNameMapping, maxRows, cursor } = call.params;
    if (typeof version !== "string" || typeof className !== "string" || typeof classNameMapping !== "string") {
      return undefined;
    }
    const kinds = kindsOf(call.params.includeKinds);
    return {
      tool: "class-mappings",
      params: {
        version,
        className,
        mapping: classNameMapping,
        ...(kinds !== undefined ? { kinds } : {}),
        ...(maxRows !== undefined ? { limit: maxRows } : {}),
        ...(cursor !== undefined ? { cursor } : {})
      }
    };
  },
  "get-class-members": classItemTranslator(
    "member-list",
    ["mapping", "access", "includeSynthetic", "includeInherited", "memberPattern", "cursor"],
    { maxMembers: "limit", includeDescriptors: "withDescriptors", includeAnnotations: "withAnnotations" }
  ),
  "get-class-source": classItemTranslator(
    "source-read",
    ["mapping", "allowDecompile", "mode", "startLine", "endLine", "maxLines", "maxChars"],
    { includeProvenance: "withProvenance" }
  ),
  "get-registry-data": dropServiceCall,
  "inspect-minecraft": dropServiceCall,
  "json-to-nbt": dropServiceCall,
  "list-artifact-files": targetedTranslator("file-list", ["prefix", "limit", "cursor"]),
  "list-versions": (call) => ({
    tool: "version-list",
    params: pick(call.params, ["includeSnapshots", "limit"])
  }),
  "manage-cache": dropServiceCall,
  "nbt-apply-json-patch": dropServiceCall,
  "nbt-to-json": (call) => ({
    tool: "nbt-decode",
    params: pick(call.params, ["nbtBase64", "compression"])
  }),
  "resolve-artifact": targetedTranslator("artifact-resolve", RESOLUTION_TUNING_KEYS),
  "resolve-method-mapping-exact": symbolItemTranslator("symbol-map", {
    withToMapping: true,
    withProjectPath: true,
    keys: ["maxCandidates"],
    extra: { exact: true },
    kind: "method"
  }),
  "validate-access-widener": dropServiceCall,
  "validate-mixin": dropServiceCall,
  "validate-project": validateProjectTranslator,
  "verify-mixin-target": dropServiceCall
};

/**
 * The catalog form of a service suggestion: kept as is when it already names
 * a catalog tool, translated when its 8.x tool is listed above, otherwise
 * dropped. The caller still validates the result.
 */
export function translateServiceSuggestedCall(
  call: ServiceSuggestedCall,
  currentTool?: string
): CatalogNextAction | undefined {
  const reason = call.reason !== undefined
    ? { reason: translateToolNamesInText(call.reason, currentTool) }
    : {};
  if (isCallableCatalogTool(call.tool)) {
    return { tool: call.tool, params: call.params, ...reason };
  }
  if (!Object.hasOwn(SERVICE_HINT_TRANSLATIONS, call.tool)) {
    return undefined;
  }
  const translated = SERVICE_HINT_TRANSLATIONS[call.tool]!(call);
  if (translated === undefined) {
    return undefined;
  }
  return translated.reason === undefined ? { ...translated, ...reason } : translated;
}

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${[...ALIAS_TOOL_INVENTORY]
    .map((entry) => entry.name)
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![A-Za-z0-9_-])`,
  "g"
);

const PATH_SEPARATORS = new Set(["/", "\\"]);

/** The name-like token (letters, digits, `_`, `-`) that ends at `end` or starts at `start`. */
function tokenBefore(text: string, end: number): string {
  return /[A-Za-z0-9_-]*$/.exec(text.slice(0, end))![0];
}

function tokenAfter(text: string, start: number): string {
  return /^[A-Za-z0-9_-]*/.exec(text.slice(start))![0];
}

/**
 * Whether the 8.x name at `offset` is part of a file or directory name: it
 * follows a `.`, or a `/` or `\` joins it to something other than another
 * 8.x name (`get-class-source/get-class-members` is a list of tools).
 */
function isInsidePath(text: string, offset: number, length: number): boolean {
  const before = text[offset - 1];
  const after = text[offset + length];
  if (before === ".") return true;
  if (before !== undefined && PATH_SEPARATORS.has(before) && aliasInventoryEntry(tokenBefore(text, offset - 1)) === undefined) {
    return true;
  }
  if (after !== undefined && PATH_SEPARATORS.has(after) && aliasInventoryEntry(tokenAfter(text, offset + length + 1)) === undefined) {
    return true;
  }
  return false;
}

/**
 * A known service sentence and its catalog wording. A `service` entry is one
 * fixed sentence, rewritten wherever it occurs in a text. A `pattern` entry is
 * a sentence with variable parts (a namespace, a query): it is rewritten only
 * when it is the whole text, as the service emits it in a warning of its own,
 * and `catalog` builds the wording from the pattern's captures.
 */
export type ServiceSentenceRewrite =
  | { readonly id: string; readonly service: string; readonly catalog: string }
  | { readonly id: string; readonly pattern: RegExp; readonly catalog: (...captures: string[]) => string };

const NAMESPACE = "(obfuscated|mojang|intermediary|yarn)";

/** How every sentence below about an untranslated search query ends. */
const SEARCHED_AS_GIVEN = "The query was searched as given";

/**
 * Whole service sentences whose advice names an 8.x input, target shape or
 * action that the catalog tool it points to does not have, with their catalog
 * wording. Only these sentences are rewritten; any other text keeps its words.
 * A sentence that only one family's tools can receive may sit in that
 * family's own list instead.
 */
export const SERVICE_SENTENCE_REWRITES: ReadonlyArray<ServiceSentenceRewrite> = [
  {
    // An intermediary or Yarn resolution of an artifact without a version
    // (src/source/artifact-resolver.ts), which every target-taking tool
    // resolves its target through.
    id: "resolver-versioned-target",
    service:
      'Use target: { kind: "version", value } or a versioned Maven coordinate so mapping artifacts can be resolved.',
    catalog:
      'Use target: { kind: "version", version } or target: { kind: "coordinate", coordinate } with a versioned Maven coordinate ' +
      "so mapping artifacts can be resolved."
  },
  {
    // The member lookup of an artifact without a version, under a mapping
    // other than obfuscated (src/source/class-source.ts).
    id: "member-versioned-target",
    service: 'Resolve with target: { kind: "version", value: ... } or specify a versioned coordinate.',
    catalog:
      'Resolve with target: { kind: "version", version: ... } or target: { kind: "coordinate", coordinate: ... } ' +
      "with a versioned Maven coordinate."
  },
  {
    // The member lookup of an artifact without a binary jar
    // (src/source/class-source.ts); the next sentence follows it.
    id: "member-binary-jar-target",
    service: 'Resolve with target: { kind: "jar" | "version", value: ... } or use an artifact that has a binary jar.',
    catalog:
      'Resolve with target: { kind: "jar", jarPath: ... } or target: { kind: "version", version: ... }, ' +
      "or use an artifact that has a binary jar."
  },
  {
    // The member lookup of an artifact without a binary jar (src/source/class-source.ts).
    id: "member-binary-jar",
    service:
      'To tell whether an artifact carries one, call manage-cache with action="inspect", selector: { artifactId: ... } and include: ["cacheEntries"]: ' +
      "the cacheEntries block reports meta.binaryJarPath from the artifact's stored row - the same row this lookup reads - and omits it when the row has none. " +
      'The include is required: manage-cache defaults to detail: "summary", which drops the cacheEntries block entirely (detail: "standard" or "full" opts it back in too).',
    catalog:
      'To tell whether an artifact carries one, call cache-manage with action: "list", cacheKinds: ["artifact-index"] and selector: { artifactId: ... }: ' +
      "the listed entry reports meta.binaryJarPath from the artifact's stored row - the same row this lookup reads - and omits it when the row has none."
  },
  {
    // A class lookup that found nothing for a deobfuscated-looking name in an
    // artifact labelled obfuscated (src/source/class-source.ts); only
    // class-find receives it. The service asks for mapping="mojang", which
    // class-find does not take. The artifact can be any jar labelled
    // obfuscated, so the wording claims obfuscated names only for a
    // Minecraft jar before 26.1.
    id: "class-find-obfuscated-names",
    pattern:
      /^No exact class symbol matched "([^"]*)"\. Artifact is indexed in obfuscated runtime names\. Deobfuscated names like "\1" usually require mapping="mojang" or a find-mapping lookup to obfuscated names\.$/,
    catalog: (className) =>
      `No exact class symbol matched "${className}". The artifact is indexed in the names its jar ships with ` +
      "(namespace obfuscated); a Minecraft jar before 26.1 ships obfuscated names. " +
      `A deobfuscated name like "${className}" is usually found by resolving the target with artifact-resolve and ` +
      'mapping: "mojang" and passing the returned artifactId as target: { kind: "artifact", artifactId }, ' +
      "or by translating it to its obfuscated name with symbol-map."
  },
  // Source search with a query namespace other than the artifact's
  // (src/source/search.ts). The service names its `queryNamespace` input,
  // which is `mapping` in the catalog.
  {
    id: "search-query-no-version",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE} could not be applied because the artifact has no version recorded; namespace translation requires a version\\. Running literal search in ${NAMESPACE} instead\\.$`
    ),
    catalog: (from, artifactNamespace) =>
      `mapping "${from}" was not applied to the query: the artifact has no version recorded, and translating a name needs one. ` +
      `${SEARCHED_AS_GIVEN} in ${artifactNamespace} names.`
  },
  {
    id: "search-query-ambiguous",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE}: translation for "([\\s\\S]*)" was ambiguous \\((\\d+) candidates\\); running literal search instead\\. Narrow the query with a more specific FQCN or call find-mapping directly\\.$`
    ),
    catalog: (from, query, count) =>
      `mapping "${from}" was not applied to the query: "${query}" maps to ${count} classes. ${SEARCHED_AS_GIVEN}. ` +
      "Use a more specific fully qualified class name, or list the candidates with symbol-map."
  },
  {
    id: "search-query-not-found",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE}: no ${NAMESPACE} mapping found for "([\\s\\S]*)"; running literal search instead\\.$`
    ),
    catalog: (from, artifactNamespace, query) =>
      `mapping "${from}" was not applied to the query: no ${artifactNamespace} mapping was found for "${query}". ${SEARCHED_AS_GIVEN}.`
  },
  {
    id: "search-query-mapping-unavailable",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE}: mapping data unavailable for version ([\\s\\S]*); running literal search instead\\.$`
    ),
    catalog: (from, version) =>
      `mapping "${from}" was not applied to the query: mapping data is unavailable for version ${version}. ${SEARCHED_AS_GIVEN}.`
  },
  {
    id: "search-query-untranslated",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE}: could not translate "([\\s\\S]*)" to ${NAMESPACE}; running literal search instead\\.$`
    ),
    catalog: (from, query, artifactNamespace) =>
      `mapping "${from}" was not applied to the query: "${query}" could not be translated to ${artifactNamespace}. ${SEARCHED_AS_GIVEN}.`
  },
  {
    id: "search-query-translation-failed",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE}: translation failed \\(([\\s\\S]*)\\); running literal search instead\\.$`
    ),
    catalog: (from, reason) =>
      `mapping "${from}" was not applied to the query: translation failed (${reason}). ${SEARCHED_AS_GIVEN}.`
  },
  {
    id: "search-query-not-qualified",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE} requires a fully-qualified class name for translation; running literal search in ${NAMESPACE} instead\\. Resolve "([\\s\\S]*)" to an FQCN with find-class or find-mapping first\\.$`
    ),
    catalog: (from, artifactNamespace, query) =>
      `mapping "${from}" was not applied to the query: only a fully qualified class name is translated. ` +
      `${SEARCHED_AS_GIVEN} in ${artifactNamespace} names. Find the fully qualified name of "${query}" with class-find or symbol-map first.`
  },
  {
    id: "search-query-intent",
    pattern: new RegExp(
      `^queryNamespace=${NAMESPACE} has no effect when intent="(text|path)" — (?:text|path) search is a literal match against the artifact's ${NAMESPACE} index\\. Use intent="symbol" for namespace translation\\.$`
    ),
    catalog: (from, intent, artifactNamespace) =>
      `mapping "${from}" does not apply with intent "${intent}": ${intent} search matches the query as given against the artifact's ${artifactNamespace} index. ` +
      'Use intent "symbol" with a fully qualified class name to translate it.'
  }
];

/** The id of the pattern sentence that makes up the whole of `text`, if any. */
export function serviceSentenceId(text: string): string | undefined {
  for (const sentence of SERVICE_SENTENCE_REWRITES) {
    if ("pattern" in sentence && sentence.pattern.test(text)) return sentence.id;
  }
  return undefined;
}

function rewriteServiceSentences(text: string): string {
  let current = text;
  for (const sentence of SERVICE_SENTENCE_REWRITES) {
    if ("service" in sentence) {
      current = current.split(sentence.service).join(sentence.catalog);
      continue;
    }
    const match = sentence.pattern.exec(current);
    if (match !== null) current = sentence.catalog(...match.slice(1));
  }
  return current;
}

/**
 * Rewrites the known service sentences above, then replaces every 8.x tool
 * name in `text` with a catalog name: the current catalog tool when it
 * replaces that 8.x tool, otherwise the 8.x tool's primary replacement. A
 * name inside a path is kept as it is.
 */
export function translateToolNamesInText(text: string, currentTool?: string): string {
  const reworded = rewriteServiceSentences(text);
  return reworded.replace(ALIAS_NAME_PATTERN, (name: string, _group: string, offset: number) => {
    if (isInsidePath(reworded, offset, name.length)) return name;
    const replacedBy = aliasInventoryEntry(name)?.replacedBy ?? [];
    if (currentTool !== undefined && replacedBy.includes(currentTool)) {
      return currentTool;
    }
    return replacedBy[0] ?? name;
  });
}
