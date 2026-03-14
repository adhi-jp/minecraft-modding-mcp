export const TOOL_SURFACE_SECTION_IDS = [
  "v3-entry-tools",
  "source-exploration",
  "version-comparison-symbol-tracking",
  "mapping-symbols",
  "nbt-utilities",
  "mod-analysis",
  "validation",
  "registry-diagnostics"
] as const;

export type ToolSurfaceSectionId = (typeof TOOL_SURFACE_SECTION_IDS)[number];
export type ToolSurfaceLocale = "en" | "ja";

type ToolSurfaceRows = {
  en: readonly string[];
  ja: readonly string[];
};

const SECTION_ROWS: Record<ToolSurfaceSectionId, ToolSurfaceRows> = {
  "v3-entry-tools": {
    en: [
      "| `inspect-minecraft` | Start from a version, artifact, class, file, search query, or workspace and route to the most relevant Minecraft inspection flow | `task?`, `subject?`, `detail?`, `include?`, `limit?`, `cursor?`, `includeSnapshots?` | `result.summary`, `versions?`, `subject`, `artifact?`, `class?`, `source?`, `members?`, `search?`, `file?`, `files?` |",
      "| `analyze-symbol` | One entry point for symbol existence checks, namespace mapping, lifecycle tracing, workspace symbol analysis, and API overview | `task`, `subject`, `version?`, `sourceMapping?`, `targetMapping?`, `projectPath?`, `classNameMapping?`, `signatureMode?`, `nameMode?`, `includeKinds?`, `maxRows?`, `maxCandidates?`, `detail?`, `include?` | `result.summary`, `match?`, `candidates?`, `ambiguity?`, `matrix?`, `workspace?` |",
      "| `compare-minecraft` | Compare version pairs, class signatures, registries, or produce a migration-oriented overview | `task?`, `subject`, `detail?`, `include?`, `subject.kind=\"class\".sourcePriority?`, `maxClassResults?`, `maxEntriesPerRegistry?`, `includeFullDiff?`, `limit?` | `result.summary`, `comparison`, `classes?`, `classDiff?`, `registry?`, `migration?` |",
      "| `analyze-mod` | Metadata-first entry point for mod summary, decompile/search flows, class source, and safe remap previews/applies | `task`, `subject`, `query?`, `searchType?`, `targetMapping?`, `outputJar?`, `executionMode?`, `includeFiles?`, `maxFiles?`, `maxLines?`, `maxChars?`, `limit?`, `detail?`, `include?` | `result.summary`, `metadata?`, `decompile?`, `hits?`, `source?`, `operation?` |",
      "| `validate-project` | Project-level validation entry for workspace summaries plus direct Mixin and Access Widener validation | `task`, `subject`, `version?`, `mapping?`, `sourcePriority?`, `scope?`, `preferProjectVersion?`, `preferProjectMapping?`, `sourceRoots?`, `configPaths?`, `minSeverity?`, `hideUncertain?`, `explain?`, `warningMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `includeIssues?`, `detail?`, `include?` | `result.summary`, `project`, `workspace?`, `issues?` |",
      "| `manage-cache` | User-facing cache summary, listing, verification, previewed deletion/pruning/rebuild, and explicit apply operations | `action`, `cacheKinds?`, `selector?`, `executionMode?`, `detail?`, `include?`, `limit?`, `cursor?` | `result.summary`, `stats?`, `cacheEntries?`, `operation?`, `meta.pagination.nextCursor?` |"
    ],
    ja: [
      "| `inspect-minecraft` | version / artifact / class / file / search / workspace から最適な Minecraft 調査フローへルーティング | `task?`, `subject?`, `detail?`, `include?`, `limit?`, `cursor?`, `includeSnapshots?` | `result.summary`, `versions?`, `subject`, `artifact?`, `class?`, `source?`, `members?`, `search?`, `file?`, `files?` |",
      "| `analyze-symbol` | シンボル存在確認、名前空間マッピング、ライフサイクル追跡、workspace symbol 解析、API overview を 1 つに統合 | `task`, `subject`, `version?`, `sourceMapping?`, `targetMapping?`, `projectPath?`, `classNameMapping?`, `signatureMode?`, `nameMode?`, `includeKinds?`, `maxRows?`, `maxCandidates?`, `detail?`, `include?` | `result.summary`, `match?`, `candidates?`, `ambiguity?`, `matrix?`, `workspace?` |",
      "| `compare-minecraft` | version pair 比較、class signature diff、registry diff、migration-oriented overview | `task?`, `subject`, `detail?`, `include?`, `subject.kind=\"class\".sourcePriority?`, `maxClassResults?`, `maxEntriesPerRegistry?`, `includeFullDiff?`, `limit?` | `result.summary`, `comparison`, `classes?`, `classDiff?`, `registry?`, `migration?` |",
      "| `analyze-mod` | Mod summary を cheap path にした metadata-first entry tool。decompile/search/class-source/remap へ拡張 | `task`, `subject`, `query?`, `searchType?`, `targetMapping?`, `outputJar?`, `executionMode?`, `includeFiles?`, `maxFiles?`, `maxLines?`, `maxChars?`, `limit?`, `detail?`, `include?` | `result.summary`, `metadata?`, `decompile?`, `hits?`, `source?`, `operation?` |",
      "| `validate-project` | workspace summary と direct Mixin / Access Widener validation をまとめた project-oriented entry tool | `task`, `subject`, `version?`, `mapping?`, `sourcePriority?`, `scope?`, `preferProjectVersion?`, `preferProjectMapping?`, `sourceRoots?`, `configPaths?`, `minSeverity?`, `hideUncertain?`, `explain?`, `warningMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `includeIssues?`, `detail?`, `include?` | `result.summary`, `project`, `workspace?`, `issues?` |",
      "| `manage-cache` | cache summary / list / verify / previewed delete-prune-rebuild / explicit apply を提供する user-facing cache tool | `action`, `cacheKinds?`, `selector?`, `executionMode?`, `detail?`, `include?`, `limit?`, `cursor?` | `result.summary`, `stats?`, `cacheEntries?`, `operation?`, `meta.pagination.nextCursor?` |"
    ]
  },
  "source-exploration": {
    en: [
      "| `list-versions` | List available Minecraft versions from Mojang manifest + local cache | `includeSnapshots?`, `limit?` | `result.latest`, `result.releases[]`, `meta.warnings[]` |",
      "| `resolve-artifact` | Resolve source artifact from `version` / `jar` / `coordinate` | `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `artifactId`, `origin`, `mappingApplied`, `qualityFlags[]`, `artifactContents`, `adjacentSourceCandidates?`, `sampleEntries?`, `warnings[]` |",
      "| `find-class` | Resolve simple or fully-qualified class names inside an artifact | `className`, `artifactId`, `limit?` | `matches[]`, `total`, `warnings[]` |",
      "| `get-class-source` | Get class source by artifact target or resolve target on demand (`mode=metadata` by default) | `className`, `target`, `mode?`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?`, `startLine?`, `endLine?`, `maxLines?`, `maxChars?`, `outputFile?` | `mode`, `sourceText`, `returnedRange`, `truncated`, `charsTruncated?`, `outputFile?`, `artifactId`, `returnedNamespace`, `artifactContents`, mapping/provenance metadata |",
      "| `get-class-members` | Get class fields/methods/constructors from bytecode | `className`, `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `access?`, `includeSynthetic?`, `includeInherited?`, `memberPattern?`, `maxMembers?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `members.{constructors,fields,methods}`, `counts`, `truncated`, `context`, `returnedNamespace`, `artifactContents`, `warnings[]` |",
      "| `search-class-source` | Search indexed class source for symbols/text/path | `artifactId`, `query`, `intent?`, `match?`, `packagePrefix?`, `fileGlob?`, `symbolKind?`, `queryMode?`, `limit?`, `cursor?` | `hits[]`, `nextCursor?`, `mappingApplied`, `returnedNamespace`, `artifactContents` |",
      "| `get-artifact-file` | Read full source file with byte guard | `artifactId`, `filePath`, `maxBytes?` | `content`, `contentBytes`, `truncated`, `mappingApplied`, `returnedNamespace`, `artifactContents` |",
      "| `list-artifact-files` | List indexed source file paths with cursor pagination | `artifactId`, `prefix?`, `limit?`, `cursor?` | `items[]`, `nextCursor?`, `mappingApplied`, `artifactContents`, `warnings[]` |",
      "| `index-artifact` | Rebuild index metadata for an existing artifact | `artifactId`, `force?` | `reindexed`, `reason`, `counts`, `indexedAt`, `durationMs` |"
    ],
    ja: [
      "| `list-versions` | Mojang マニフェスト＋ローカルキャッシュから利用可能な Minecraft バージョンを一覧表示 | `includeSnapshots?`, `limit?` | `result.latest`, `result.releases[]`, `meta.warnings[]` |",
      "| `resolve-artifact` | `version` / `jar` / `coordinate` からソースアーティファクトを解決 | `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `artifactId`, `origin`, `mappingApplied`, `qualityFlags[]`, `artifactContents`, `adjacentSourceCandidates?`, `sampleEntries?`, `warnings[]` |",
      "| `find-class` | アーティファクト内で簡易名または FQCN からクラスを解決 | `className`, `artifactId`, `limit?` | `matches[]`, `total`, `warnings[]` |",
      "| `get-class-source` | アーティファクト target からクラスソースを取得（デフォルト `mode=metadata`） | `className`, `target`, `mode?`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?`, `startLine?`, `endLine?`, `maxLines?`, `maxChars?`, `outputFile?` | `mode`, `sourceText`, `returnedRange`, `truncated`, `charsTruncated?`, `outputFile?`, `artifactId`, `returnedNamespace`, `artifactContents`, マッピング/来歴メタデータ |",
      "| `get-class-members` | バイトコードからクラスのフィールド/メソッド/コンストラクタを取得 | `className`, `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `access?`, `includeSynthetic?`, `includeInherited?`, `memberPattern?`, `maxMembers?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `members.{constructors,fields,methods}`, `counts`, `truncated`, `context`, `returnedNamespace`, `artifactContents`, `warnings[]` |",
      "| `search-class-source` | インデックス化されたクラスソースからシンボル/テキスト/パスを検索 | `artifactId`, `query`, `intent?`, `match?`, `packagePrefix?`, `fileGlob?`, `symbolKind?`, `queryMode?`, `limit?`, `cursor?` | `hits[]`, `nextCursor?`, `mappingApplied`, `returnedNamespace`, `artifactContents` |",
      "| `get-artifact-file` | バイトガード付きでソースファイル全体を読み取り | `artifactId`, `filePath`, `maxBytes?` | `content`, `contentBytes`, `truncated`, `mappingApplied`, `returnedNamespace`, `artifactContents` |",
      "| `list-artifact-files` | カーソルページネーション付きでインデックス化されたソースファイルパスを一覧表示 | `artifactId`, `prefix?`, `limit?`, `cursor?` | `items[]`, `nextCursor?`, `mappingApplied`, `artifactContents`, `warnings[]` |",
      "| `index-artifact` | 既存アーティファクトのインデックスメタデータを再構築 | `artifactId`, `force?` | `reindexed`, `reason`, `counts`, `indexedAt`, `durationMs` |"
    ]
  },
  "version-comparison-symbol-tracking": {
    en: [
      "| `trace-symbol-lifecycle` | Trace when `Class.method` exists across Minecraft versions (`descriptor` omitted = name-only lookup) | `symbol`, `descriptor?`, `fromVersion?`, `toVersion?`, `mapping?`, `sourcePriority?`, `includeSnapshots?`, `maxVersions?`, `includeTimeline?` | `presence.firstSeen`, `presence.lastSeen`, `presence.missingBetween[]`, `presence.existsNow`, `timeline?`, `warnings[]` |",
      "| `diff-class-signatures` | Compare one class between two versions and return member deltas | `className`, `fromVersion`, `toVersion`, `mapping?`, `sourcePriority?`, `includeFullDiff?` | `classChange`, `constructors/methods/fields.{added,removed,modified}`, `modified`, `modified[].{key,changed,from?,to?}`, `summary`, `warnings[]` |",
      "| `compare-versions` | Compare class/registry changes between two versions | `fromVersion`, `toVersion`, `category?`, `packageFilter?`, `maxClassResults?` | `classes`, `registry`, `summary`, `warnings[]` |"
    ],
    ja: [
      "| `trace-symbol-lifecycle` | `Class.method` が Minecraft バージョン間でいつ存在するかを追跡 | `symbol`, `descriptor?`, `fromVersion?`, `toVersion?`, `mapping?`, `sourcePriority?`, `includeSnapshots?`, `maxVersions?`, `includeTimeline?` | `presence.firstSeen`, `presence.lastSeen`, `presence.missingBetween[]`, `presence.existsNow`, `timeline?`, `warnings[]` |",
      "| `diff-class-signatures` | 2つのバージョン間で1つのクラスを比較しメンバーの差分を返す | `className`, `fromVersion`, `toVersion`, `mapping?`, `sourcePriority?`, `includeFullDiff?` | `classChange`, `constructors/methods/fields.{added,removed,modified}`, `modified`, `modified[].{key,changed,from?,to?}`, `summary`, `warnings[]` |",
      "| `compare-versions` | 2つのバージョン間のクラス/レジストリの変更を比較 | `fromVersion`, `toVersion`, `category?`, `packageFilter?`, `maxClassResults?` | `classes`, `registry`, `summary`, `warnings[]` |"
    ]
  },
  "mapping-symbols": {
    en: [
      "| `find-mapping` | Find mapping candidates for class/field/method symbols between namespaces | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `disambiguation?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `ambiguityReasons?`, `provenance?`, `meta.warnings[]` |",
      "| `resolve-method-mapping-exact` | Resolve one method mapping with strict owner+name+descriptor matching | `version`, `name`, `owner`, `descriptor`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `provenance?`, `meta.warnings[]` |",
      "| `get-class-api-matrix` | Show one class API as a mapping matrix (`obfuscated/mojang/intermediary/yarn`) | `version`, `className`, `classNameMapping`, `includeKinds?`, `sourcePriority?`, `maxRows?` | `classIdentity`, `rows[]`, `rowCount`, `rowsTruncated?`, `ambiguousRowCount?`, `meta.warnings[]` |",
      "| `resolve-workspace-symbol` | Resolve compile-visible symbol names for a Gradle workspace (`build.gradle/.kts`) | `projectPath`, `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `workspaceDetection`, `meta.warnings[]` |",
      "| `check-symbol-exists` | Strict symbol presence check for class/field/method | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `nameMode?`, `signatureMode?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `meta.warnings[]` |"
    ],
    ja: [
      "| `find-mapping` | クラス/フィールド/メソッドのシンボルに対するマッピング候補を名前空間間で検索 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `disambiguation?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `ambiguityReasons?`, `provenance?`, `meta.warnings[]` |",
      "| `resolve-method-mapping-exact` | owner+name+descriptor の厳密マッチングで1つのメソッドマッピングを解決 | `version`, `name`, `owner`, `descriptor`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `provenance?`, `meta.warnings[]` |",
      "| `get-class-api-matrix` | 1つのクラス API をマッピングマトリクスとして表示（`obfuscated/mojang/intermediary/yarn`） | `version`, `className`, `classNameMapping`, `includeKinds?`, `sourcePriority?`, `maxRows?` | `classIdentity`, `rows[]`, `rowCount`, `rowsTruncated?`, `ambiguousRowCount?`, `meta.warnings[]` |",
      "| `resolve-workspace-symbol` | Gradle ワークスペース（`build.gradle/.kts`）のコンパイル時可視シンボル名を解決 | `projectPath`, `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `workspaceDetection`, `meta.warnings[]` |",
      "| `check-symbol-exists` | クラス/フィールド/メソッドの厳密な存在確認 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `nameMode?`, `signatureMode?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `meta.warnings[]` |"
    ]
  },
  "nbt-utilities": {
    en: [
      "| `nbt-to-json` | Decode Java Edition NBT binary (`base64`) to typed JSON | `nbtBase64`, `compression?` (`none`, `gzip`, `auto`) | `typedJson`, `meta.compressionDetected`, `meta.inputBytes` |",
      "| `nbt-apply-json-patch` | Apply RFC 6902 patch (`add/remove/replace/test`) to typed NBT JSON | `typedJson`, `patch` | `typedJson`, `meta.appliedOps`, `meta.testOps`, `meta.changed` |",
      "| `json-to-nbt` | Encode typed JSON back to Java Edition NBT binary (`base64`) | `typedJson`, `compression?` (`none`, `gzip`) | `nbtBase64`, `meta.outputBytes`, `meta.compressionApplied` |"
    ],
    ja: [
      "| `nbt-to-json` | Java Edition NBT バイナリ（`base64`）を型付き JSON にデコード | `nbtBase64`, `compression?` (`none`, `gzip`, `auto`) | `typedJson`, `meta.compressionDetected`, `meta.inputBytes` |",
      "| `nbt-apply-json-patch` | RFC 6902 パッチ（`add/remove/replace/test`）を型付き NBT JSON に適用 | `typedJson`, `patch` | `typedJson`, `meta.appliedOps`, `meta.testOps`, `meta.changed` |",
      "| `json-to-nbt` | 型付き JSON を Java Edition NBT バイナリ（`base64`）にエンコード | `typedJson`, `compression?` (`none`, `gzip`) | `nbtBase64`, `meta.outputBytes`, `meta.compressionApplied` |"
    ]
  },
  "mod-analysis": {
    en: [
      "| `analyze-mod-jar` | Extract mod metadata/dependencies/entrypoints from mod JAR | `jarPath`, `includeClasses?` | `modId`, `loader`, `jarKind`, `dependencies`, `entrypoints`, `mixinConfigs`, class stats |",
      "| `decompile-mod-jar` | Decompile mod JAR and optionally return one class source | `jarPath`, `className?`, `includeFiles?`, `maxFiles?` | `outputDir`, `fileCount`, `files?`, `returnedFileCount?`, `filesTruncated?`, `filesOmitted?`, `source?`, `warnings[]` |",
      "| `get-mod-class-source` | Read one class source from decompiled mod cache | `jarPath`, `className`, `maxLines?`, `maxChars?`, `outputFile?` | `className`, `content`, `totalLines`, `truncated?`, `charsTruncated?`, `outputFilePath?`, `warnings[]` |",
      "| `search-mod-source` | Search decompiled mod source by class/method/field/content | `jarPath`, `query`, `searchType?`, `limit?` | `hits[]`, `totalHits`, `truncated`, `warnings[]` |",
      "| `remap-mod-jar` | Remap a Fabric/Quilt mod JAR to yarn/mojang names; Mojang-mapped inputs are copied for `targetMapping=\"mojang\"` | `inputJar`, `targetMapping`, `mcVersion?`, `outputJar?` | `outputJar`, `mcVersion`, `fromMapping`, `targetMapping`, `resolvedTargetNamespace`, `warnings[]` |"
    ],
    ja: [
      "| `analyze-mod-jar` | Mod JAR から Mod メタデータ/依存関係/エントリポイントを抽出 | `jarPath`, `includeClasses?` | `modId`, `loader`, `jarKind`, `dependencies`, `entrypoints`, `mixinConfigs`, クラス統計 |",
      "| `decompile-mod-jar` | Mod JAR をデコンパイルし、オプションで1つのクラスソースを返す | `jarPath`, `className?`, `includeFiles?`, `maxFiles?` | `outputDir`, `fileCount`, `files?`, `returnedFileCount?`, `filesTruncated?`, `filesOmitted?`, `source?`, `warnings[]` |",
      "| `get-mod-class-source` | デコンパイル済みキャッシュから1つのクラスソースを読み取り | `jarPath`, `className`, `maxLines?`, `maxChars?`, `outputFile?` | `className`, `content`, `totalLines`, `truncated?`, `charsTruncated?`, `outputFilePath?`, `warnings[]` |",
      "| `search-mod-source` | デコンパイル済み Mod ソースをクラス/メソッド/フィールド/コンテンツで検索 | `jarPath`, `query`, `searchType?`, `limit?` | `hits[]`, `totalHits`, `truncated`, `warnings[]` |",
      "| `remap-mod-jar` | Fabric Mod JAR を intermediary から yarn/mojang 名にリマップ | `inputJar`, `targetMapping`, `mcVersion?`, `outputJar?` | `outputJar`, `mcVersion`, `fromMapping`, `targetMapping`, `resolvedTargetNamespace`, `warnings[]` |"
    ]
  },
  "validation": {
    en: [
      "| `validate-mixin` | Parse/validate Mixin source against target Minecraft version | `input`, `sourceRoots?`, `version`, `mapping?`, `sourcePriority?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `minSeverity?`, `hideUncertain?`, `warningMode?`, `preferProjectMapping?`, `reportMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `explain?`, `includeIssues?` | `mode`, `results[].validationStatus`, `summary.partial`, `issueSummary?`, `provenance?`, `incompleteReasons?`, `toolHealth?`, `confidenceScore?`, `confidenceBreakdown?` |",
      "| `validate-access-widener` | Parse/validate Access Widener content against target version | `content`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |"
    ],
    ja: [
      "| `validate-mixin` | Mixin ソースを対象 Minecraft バージョンに対してパース/バリデーション | `input`, `sourceRoots?`, `version`, `mapping?`, `sourcePriority?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `minSeverity?`, `hideUncertain?`, `warningMode?`, `preferProjectMapping?`, `reportMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `explain?`, `includeIssues?` | `mode`, `results[].validationStatus`, `summary.partial`, `issueSummary?`, `provenance?`, `incompleteReasons?`, `toolHealth?`, `confidenceScore?`, `confidenceBreakdown?` |",
      "| `validate-access-widener` | Access Widener コンテンツを対象バージョンに対してパース/バリデーション | `content`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |"
    ]
  },
  "registry-diagnostics": {
    en: [
      "| `get-registry-data` | Get generated registry snapshots (blocks/items/entities etc.) | `version`, `registry?`, `includeData?`, `maxEntriesPerRegistry?` | `registries`, `data?`, `entryCount`, `returnedEntryCount?`, `registryEntryCounts?`, `dataTruncated?`, `warnings[]` |",
      "| `get-runtime-metrics` | Inspect runtime counters and latency snapshots | none | `result.*` runtime metrics, `meta` envelope |"
    ],
    ja: [
      "| `get-registry-data` | 生成済みレジストリスナップショット（blocks/items/entities 等）を取得 | `version`, `registry?`, `includeData?`, `maxEntriesPerRegistry?` | `registries`, `data?`, `entryCount`, `returnedEntryCount?`, `registryEntryCounts?`, `dataTruncated?`, `warnings[]` |",
      "| `get-runtime-metrics` | ランタイムカウンターとレイテンシスナップショットを検査 | なし | `result.*` ランタイムメトリクス, `meta` エンベロープ |"
    ]
  }
};

export function renderToolSurfaceSection(
  locale: ToolSurfaceLocale,
  sectionId: ToolSurfaceSectionId
): string {
  const header =
    locale === "en"
      ? "| Tool | Purpose | Key Inputs | Key Outputs |"
      : "| ツール | 機能 | 主な入力 | 主な出力 |";
  const divider = "| --- | --- | --- | --- |";
  const rows = SECTION_ROWS[sectionId][locale];
  return [header, divider, ...rows].join("\n");
}
