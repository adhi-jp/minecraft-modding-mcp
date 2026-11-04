/**
 * Request vocabulary of the catalog: the property names catalog input schemas
 * may use, at the top level and inside `target`, work items and selectors.
 * One concept has one name across tools; a new name joins this list
 * deliberately, never by drift.
 */
export const CATALOG_PROPERTY_VOCABULARY: ReadonlySet<string> = new Set([
  // where to look
  "target",
  "kind",
  "artifactId",
  "version",
  "jarPath",
  "coordinate",
  "projectPath",
  "group",
  "name",
  "dependencyVersion",
  "scope",
  // versions
  "fromVersion",
  "toVersion",
  "includeSnapshots",
  "maxVersions",
  // names and namespaces
  "mapping",
  "toMapping",
  "className",
  "classes",
  "memberName",
  "descriptor",
  "symbol",
  "symbols",
  "kinds",
  "nameMode",
  "signatureMode",
  "maxCandidates",
  "exact",
  // artifact resolution tuning
  "sourcePriority",
  "allowDecompile",
  "gradleUserHome",
  "preferProjectVersion",
  "strictVersion",
  "force",
  // files and source
  "prefix",
  "filePath",
  "maxBytes",
  "mode",
  "startLine",
  "endLine",
  "maxLines",
  "maxChars",
  "outputDir",
  // search
  "query",
  "intent",
  "match",
  "queryMode",
  "packagePrefix",
  "fileGlob",
  "symbolKind",
  "searchType",
  // members
  "access",
  "includeSynthetic",
  "includeInherited",
  "memberPattern",
  // comparison and registries
  "category",
  "packageFilter",
  "registry",
  // mods
  "outputJar",
  "apply",
  // validation
  "source",
  "paths",
  "configPaths",
  "discover",
  "mixinMemberName",
  "autoRemap",
  "format",
  "content",
  "path",
  // nbt
  "nbtBase64",
  "compression",
  "typedJson",
  "patch",
  // cache
  "action",
  "cacheKinds",
  "selector",
  "entryId",
  "status",
  "olderThan",
  // paging and verbosity
  "limit",
  "cursor",
  "detail",
  "withLibraries",
  "withProvenance",
  "withDescriptors",
  "withAnnotations",
  "withTimeline",
  "withData",
  "withClasses"
]);

/** 8.x spellings the catalog replaced; none may appear in a catalog input schema. */
export const RETIRED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "sourceMapping",
  "targetMapping",
  "classNameMapping",
  "queryNamespace",
  "atNamespace",
  "include",
  "outputFile",
  "subject",
  "task",
  "focus",
  "inputJar",
  "mcVersion",
  "executionMode",
  "owner"
]);

/**
 * Data documents follow their own format instead of the catalog's
 * control-object rules: their members are validated by the document format
 * and are exempt from the strict-object and vocabulary checks.
 *
 *  - `typedJson`: a typed NBT JSON document.
 *  - `patch`: RFC 6902 JSON Patch operations, whose unknown members the RFC
 *    says to ignore.
 */
export const DATA_DOCUMENT_PROPERTIES: ReadonlySet<string> = new Set(["typedJson", "patch"]);
