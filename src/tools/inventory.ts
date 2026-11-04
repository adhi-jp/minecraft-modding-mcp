/**
 * The one hand-written inventory of tool names.
 *
 * Two groups share this module:
 *
 *  - the catalog: the flat tool surface, one entry per catalog tool with the
 *    execution flags the server needs before any catalog code loads;
 *  - the deprecated aliases: every 8.x tool name, still served by its 8.x
 *    handler, with the catalog tools that replace it and the flags the 8.x
 *    runner keys on.
 *
 * This module is plain data with no imports, so the stdio supervisor, both
 * registrations, the heavy-tool gate and the tests can all read it without
 * pulling in schemas, services or the MCP SDK.
 */

export type CatalogToolInventoryEntry = {
  readonly name: string;
  /** Runs behind the shared heavy-tool execution gate. */
  readonly heavy?: boolean;
  /** Gets the supervisor's deadline and exclusive-dispatch protection. */
  readonly longRunning?: boolean;
};

export type AliasToolInventoryEntry = {
  readonly name: string;
  /**
   * Catalog tools that take over this tool's work. The first entry is the
   * primary replacement, used when a text names this tool and nothing tells
   * which task it meant.
   */
  readonly replacedBy: readonly string[];
  /** Multiplexed tools only: the catalog tool that takes over each `task`. */
  readonly tasks?: Readonly<Record<string, string>>;
  /** Runs behind the shared heavy-tool execution gate. */
  readonly heavy?: boolean;
  /** Entry tool: default detail `summary` and the entry-tool meta contract. */
  readonly entry?: boolean;
  /** Batch tool: projects per entry and reports the applied detail in meta. */
  readonly batch?: boolean;
  /** Gets the supervisor's deadline and exclusive-dispatch protection. */
  readonly longRunning?: boolean;
};

export const CATALOG_TOOL_INVENTORY: readonly CatalogToolInventoryEntry[] = [
  { name: "version-list" },
  { name: "artifact-resolve" },
  { name: "artifact-index" },
  { name: "file-list" },
  { name: "file-read" },
  { name: "class-find" },
  { name: "source-read" },
  { name: "source-export" },
  { name: "member-list" },
  { name: "source-search" },
  { name: "symbol-check" },
  { name: "symbol-map", heavy: true },
  { name: "class-mappings", heavy: true },
  { name: "symbol-trace", heavy: true },
  { name: "version-compare", heavy: true },
  { name: "class-diff", heavy: true },
  { name: "registry-read", heavy: true },
  { name: "mod-inspect" },
  { name: "mod-search" },
  { name: "mod-remap" },
  { name: "project-validate", longRunning: true },
  { name: "mixin-validate", longRunning: true },
  { name: "access-validate" },
  { name: "mixin-verify-target" },
  { name: "nbt-decode" },
  { name: "nbt-encode" },
  { name: "nbt-patch" },
  { name: "cache-manage" },
  { name: "server-metrics" }
];

/** The 8.x tools in their registration call-site order. */
export const ALIAS_TOOL_INVENTORY: readonly AliasToolInventoryEntry[] = [
  { name: "list-versions", replacedBy: ["version-list"] },
  {
    name: "inspect-minecraft",
    replacedBy: [
      "version-list",
      "artifact-resolve",
      "class-find",
      "source-read",
      "member-list",
      "source-search",
      "file-read",
      "file-list"
    ],
    tasks: {
      versions: "version-list",
      artifact: "artifact-resolve",
      "class-overview": "class-find",
      "class-source": "source-read",
      "class-members": "member-list",
      search: "source-search",
      file: "file-read",
      "list-files": "file-list"
    },
    entry: true
  },
  {
    name: "analyze-symbol",
    replacedBy: ["symbol-check", "symbol-map", "symbol-trace", "class-mappings"],
    tasks: {
      exists: "symbol-check",
      map: "symbol-map",
      "exact-map": "symbol-map",
      lifecycle: "symbol-trace",
      workspace: "symbol-map",
      "api-overview": "class-mappings"
    },
    entry: true
  },
  {
    name: "compare-minecraft",
    replacedBy: ["version-compare", "class-diff"],
    tasks: {
      versions: "version-compare",
      "class-diff": "class-diff",
      "registry-diff": "version-compare",
      "migration-overview": "version-compare"
    },
    entry: true
  },
  {
    name: "analyze-mod",
    replacedBy: ["mod-inspect", "mod-search", "source-read", "member-list", "mod-remap"],
    tasks: {
      summary: "mod-inspect",
      decompile: "mod-inspect",
      search: "mod-search",
      "class-source": "source-read",
      members: "member-list",
      remap: "mod-remap"
    },
    entry: true
  },
  {
    name: "validate-project",
    replacedBy: ["project-validate", "mixin-validate", "access-validate"],
    tasks: {
      "project-summary": "project-validate",
      mixin: "mixin-validate",
      "access-widener": "access-validate",
      "access-transformer": "access-validate"
    },
    entry: true,
    longRunning: true
  },
  { name: "manage-cache", replacedBy: ["cache-manage"], entry: true },
  { name: "verify-mixin-target", replacedBy: ["mixin-verify-target"] },
  { name: "batch-class-source", replacedBy: ["source-read", "source-export"], batch: true },
  { name: "batch-class-members", replacedBy: ["member-list"], batch: true },
  { name: "batch-symbol-exists", replacedBy: ["symbol-check"], batch: true },
  { name: "batch-mappings", replacedBy: ["symbol-map"], batch: true },
  { name: "resolve-artifact", replacedBy: ["artifact-resolve"] },
  { name: "find-class", replacedBy: ["class-find"] },
  { name: "get-class-source", replacedBy: ["source-read", "source-export"] },
  { name: "get-class-members", replacedBy: ["member-list"] },
  { name: "search-class-source", replacedBy: ["source-search"] },
  { name: "get-artifact-file", replacedBy: ["file-read"] },
  { name: "list-artifact-files", replacedBy: ["file-list"] },
  { name: "trace-symbol-lifecycle", replacedBy: ["symbol-trace"], heavy: true },
  { name: "diff-class-signatures", replacedBy: ["class-diff"], heavy: true },
  { name: "find-mapping", replacedBy: ["symbol-map"], heavy: true },
  { name: "resolve-method-mapping-exact", replacedBy: ["symbol-map"], heavy: true },
  { name: "get-class-api-matrix", replacedBy: ["class-mappings"], heavy: true },
  { name: "resolve-workspace-symbol", replacedBy: ["symbol-map"] },
  { name: "check-symbol-exists", replacedBy: ["symbol-check"] },
  { name: "nbt-to-json", replacedBy: ["nbt-decode"] },
  { name: "nbt-apply-json-patch", replacedBy: ["nbt-patch"] },
  { name: "json-to-nbt", replacedBy: ["nbt-encode"] },
  { name: "index-artifact", replacedBy: ["artifact-index"] },
  { name: "get-runtime-metrics", replacedBy: ["server-metrics"] },
  { name: "validate-mixin", replacedBy: ["mixin-validate"] },
  { name: "validate-access-widener", replacedBy: ["access-validate"] },
  { name: "validate-access-transformer", replacedBy: ["access-validate"] },
  { name: "analyze-mod-jar", replacedBy: ["mod-inspect"] },
  { name: "get-registry-data", replacedBy: ["registry-read"], heavy: true },
  { name: "compare-versions", replacedBy: ["version-compare"], heavy: true },
  { name: "decompile-mod-jar", replacedBy: ["mod-inspect", "source-read"] },
  { name: "get-mod-class-source", replacedBy: ["source-read", "source-export"] },
  { name: "search-mod-source", replacedBy: ["mod-search"] },
  { name: "remap-mod-jar", replacedBy: ["mod-remap"] }
];

function namesWhere<T extends { readonly name: string }>(
  entries: readonly T[],
  predicate: (entry: T) => boolean = () => true
): ReadonlySet<string> {
  return new Set(entries.filter(predicate).map((entry) => entry.name));
}

export const CATALOG_TOOL_NAMES: ReadonlySet<string> = namesWhere(CATALOG_TOOL_INVENTORY);
export const CATALOG_HEAVY_TOOL_NAMES: ReadonlySet<string> = namesWhere(
  CATALOG_TOOL_INVENTORY,
  (entry) => entry.heavy === true
);

export const ALIAS_TOOL_NAMES: ReadonlySet<string> = namesWhere(ALIAS_TOOL_INVENTORY);
export const ALIAS_HEAVY_TOOL_NAMES: ReadonlySet<string> = namesWhere(
  ALIAS_TOOL_INVENTORY,
  (entry) => entry.heavy === true
);
export const ALIAS_ENTRY_TOOL_NAMES: ReadonlySet<string> = namesWhere(
  ALIAS_TOOL_INVENTORY,
  (entry) => entry.entry === true
);
export const ALIAS_BATCH_TOOL_NAMES: ReadonlySet<string> = namesWhere(
  ALIAS_TOOL_INVENTORY,
  (entry) => entry.batch === true
);

/** Catalog and alias tools that get the supervisor's deadline and exclusive dispatch. */
export const LONG_RUNNING_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...namesWhere(CATALOG_TOOL_INVENTORY, (entry) => entry.longRunning === true),
  ...namesWhere(ALIAS_TOOL_INVENTORY, (entry) => entry.longRunning === true)
]);

const ALIAS_BY_NAME: ReadonlyMap<string, AliasToolInventoryEntry> = new Map(
  ALIAS_TOOL_INVENTORY.map((entry) => [entry.name, entry])
);

export function isCatalogToolName(name: string | undefined): boolean {
  return name !== undefined && CATALOG_TOOL_NAMES.has(name);
}

export function isAliasToolName(name: string | undefined): boolean {
  return name !== undefined && ALIAS_TOOL_NAMES.has(name);
}

export function isLongRunningToolName(name: string | undefined): boolean {
  return name !== undefined && LONG_RUNNING_TOOL_NAMES.has(name);
}

export function aliasInventoryEntry(name: string): AliasToolInventoryEntry | undefined {
  return ALIAS_BY_NAME.get(name);
}

/** The release that removes the deprecated aliases, at the earliest. */
export const ALIAS_REMOVAL_VERSION = "10.0.0";

/** The `deprecated` block an alias carries in its listing `_meta` and in every reply's `meta`. */
export type AliasDeprecation = {
  replacedBy: string[];
  removeIn: string;
};

/**
 * The deprecation block of an alias, or undefined for any other name.
 * `replacedBy` names the catalog tools that replace the alias; for a
 * multiplexed alias whose own `args.task` property is one of its tasks, only
 * that task's tool. An inherited `task` (for example through a `__proto__`
 * key in a copy of the arguments) does not count.
 */
export function aliasDeprecation(name: string | undefined, args?: unknown): AliasDeprecation | undefined {
  const entry = name === undefined ? undefined : ALIAS_BY_NAME.get(name);
  if (entry === undefined) return undefined;
  const task =
    args !== null && typeof args === "object" && !Array.isArray(args) && Object.hasOwn(args, "task")
      ? (args as { task?: unknown }).task
      : undefined;
  const taskTool =
    entry.tasks !== undefined && typeof task === "string" && Object.hasOwn(entry.tasks, task)
      ? entry.tasks[task]
      : undefined;
  return {
    replacedBy: taskTool !== undefined ? [taskTool] : [...entry.replacedBy],
    removeIn: ALIAS_REMOVAL_VERSION
  };
}
