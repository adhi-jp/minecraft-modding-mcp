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
      "| `inspect-minecraft` | Inspect versions, artifacts, classes, files, source text, and workspace-aware lookup flows |",
      "| `analyze-symbol` | Handle symbol existence checks, namespace mapping, lifecycle tracing, workspace symbol resolution, and API overviews |",
      "| `compare-minecraft` | Compare version pairs, class diffs, registry diffs, and migration-oriented summaries |",
      "| `analyze-mod` | Summarize mod metadata, decompile and search mod code, inspect class source, and preview or apply remaps |",
      "| `validate-project` | Summarize workspaces and run direct Mixin or Access Widener validation |",
      "| `manage-cache` | List, verify, and preview or apply cache cleanup and rebuild operations |"
    ],
    ja: [
      "| `inspect-minecraft` | バージョン、アーティファクト、クラス、ファイル、ソース本文、ワークスペース文脈の調査フローをまとめて扱う |",
      "| `analyze-symbol` | シンボル存在確認、名前空間変換、ライフサイクル追跡、ワークスペースシンボル解決、API 概要をまとめて扱う |",
      "| `compare-minecraft` | バージョン差分、クラス差分、レジストリ差分、移行向け概要を比較する |",
      "| `analyze-mod` | Mod メタデータの要約、Mod コードのデコンパイル / 検索、クラスソース確認、リマップのプレビュー / 実行を扱う |",
      "| `validate-project` | ワークスペース要約と、Mixin / Access Widener の直接検証を行う |",
      "| `manage-cache` | キャッシュの一覧、検証、クリーンアップ / 再構築のプレビュー / 実行を行う |"
    ]
  },
  "source-exploration": {
    en: [
      "| `list-versions` | List available Minecraft versions from Mojang metadata and local cache |",
      "| `resolve-artifact` | Resolve source artifacts from versions, JAR paths, or Maven coordinates |",
      "| `find-class` | Find simple or fully-qualified class names inside an artifact |",
      "| `get-class-source` | Read class source from an artifact or resolve the backing artifact on demand |",
      "| `get-class-members` | List constructors, fields, and methods from bytecode |",
      "| `search-class-source` | Search indexed class source by symbol, text, or path |",
      "| `get-artifact-file` | Read a full source file with a byte limit |",
      "| `list-artifact-files` | List indexed source file paths with cursor pagination |",
      "| `index-artifact` | Rebuild indexed metadata for an existing artifact |"
    ],
    ja: [
      "| `list-versions` | Mojang メタデータとローカルキャッシュから利用可能な Minecraft バージョンを一覧表示する |",
      "| `resolve-artifact` | バージョン、JAR パス、Maven 座標からソースアーティファクトを解決する |",
      "| `find-class` | アーティファクト内で簡易名または完全修飾クラス名を探す |",
      "| `get-class-source` | アーティファクトからクラスソースを読み取り、必要に応じて背後のアーティファクトを解決する |",
      "| `get-class-members` | バイトコードからコンストラクタ、フィールド、メソッドを一覧化する |",
      "| `search-class-source` | インデックス化されたクラスソースをシンボル、テキスト、パスで検索する |",
      "| `get-artifact-file` | バイト上限付きでソースファイル全体を読み取る |",
      "| `list-artifact-files` | インデックス化されたソースファイルパスをカーソルページネーション付きで一覧表示する |",
      "| `index-artifact` | 既存アーティファクトのインデックスメタデータを再構築する |"
    ]
  },
  "version-comparison-symbol-tracking": {
    en: [
      "| `trace-symbol-lifecycle` | Trace when `Class.method` exists across Minecraft versions |",
      "| `diff-class-signatures` | Compare one class across two versions and return member deltas |",
      "| `compare-versions` | Compare class and registry changes between two versions |"
    ],
    ja: [
      "| `trace-symbol-lifecycle` | `Class.method` が Minecraft のどのバージョンで存在するかを追跡する |",
      "| `diff-class-signatures` | 2 つのバージョン間で 1 つのクラスを比較し、メンバー差分を返す |",
      "| `compare-versions` | 2 つのバージョン間でクラスとレジストリの変更を比較する |"
    ]
  },
  "mapping-symbols": {
    en: [
      "| `find-mapping` | Look up mapping candidates for class, field, or method symbols |",
      "| `resolve-method-mapping-exact` | Resolve one method mapping with strict owner, name, and descriptor matching |",
      "| `get-class-api-matrix` | Show one class API across `obfuscated`, `mojang`, `intermediary`, and `yarn` |",
      "| `resolve-workspace-symbol` | Resolve compile-visible symbol names from a Gradle workspace |",
      "| `check-symbol-exists` | Check whether a class, field, or method exists in a namespace |"
    ],
    ja: [
      "| `find-mapping` | クラス、フィールド、メソッドのシンボルに対するマッピング候補を調べる |",
      "| `resolve-method-mapping-exact` | owner、name、descriptor の厳密一致で 1 つのメソッドマッピングを解決する |",
      "| `get-class-api-matrix` | 1 つのクラス API を `obfuscated`、`mojang`、`intermediary`、`yarn` で見比べる |",
      "| `resolve-workspace-symbol` | Gradle ワークスペースからコンパイル時に見えるシンボル名を解決する |",
      "| `check-symbol-exists` | 名前空間内でクラス、フィールド、メソッドが存在するかを確認する |"
    ]
  },
  "nbt-utilities": {
    en: [
      "| `nbt-to-json` | Decode Java Edition NBT binary payloads into typed JSON |",
      "| `nbt-apply-json-patch` | Apply RFC 6902 patches to typed NBT JSON |",
      "| `json-to-nbt` | Encode typed JSON back to Java Edition NBT binary |"
    ],
    ja: [
      "| `nbt-to-json` | Java Edition の NBT バイナリを型付き JSON にデコードする |",
      "| `nbt-apply-json-patch` | 型付き NBT JSON に RFC 6902 パッチを適用する |",
      "| `json-to-nbt` | 型付き JSON を Java Edition の NBT バイナリへ再エンコードする |"
    ]
  },
  "mod-analysis": {
    en: [
      "| `analyze-mod-jar` | Extract mod metadata, dependencies, entrypoints, and mixin config info from a JAR |",
      "| `decompile-mod-jar` | Decompile a mod JAR and optionally return one class source |",
      "| `get-mod-class-source` | Read one class source from the decompiled mod cache |",
      "| `search-mod-source` | Search decompiled mod source by class, method, field, or content |",
      "| `remap-mod-jar` | Remap a Fabric or Quilt mod JAR to `yarn` or `mojang` names |"
    ],
    ja: [
      "| `analyze-mod-jar` | JAR から Mod メタデータ、依存関係、エントリポイント、Mixin 設定情報を抽出する |",
      "| `decompile-mod-jar` | Mod JAR をデコンパイルし、必要に応じて 1 つのクラスソースを返す |",
      "| `get-mod-class-source` | デコンパイル済み Mod キャッシュから 1 つのクラスソースを読み取る |",
      "| `search-mod-source` | デコンパイル済み Mod ソースを class、method、field、content で検索する |",
      "| `remap-mod-jar` | Fabric または Quilt の Mod JAR を `yarn` または `mojang` 名へリマップする |"
    ]
  },
  "validation": {
    en: [
      "| `validate-mixin` | Validate Mixin source against a target Minecraft version |",
      "| `validate-access-widener` | Validate Access Widener content against a target Minecraft version |"
    ],
    ja: [
      "| `validate-mixin` | 対象 Minecraft バージョンに対して Mixin ソースを検証する |",
      "| `validate-access-widener` | 対象 Minecraft バージョンに対して Access Widener の内容を検証する |"
    ]
  },
  "registry-diagnostics": {
    en: [
      "| `get-registry-data` | Read generated registry snapshots and optionally include entry data |",
      "| `get-runtime-metrics` | Inspect runtime metrics and latency snapshots |"
    ],
    ja: [
      "| `get-registry-data` | 生成済みレジストリスナップショットを読み取り、必要に応じてエントリデータも含める |",
      "| `get-runtime-metrics` | ランタイムメトリクスとレイテンシスナップショットを確認する |"
    ]
  }
};

export function renderToolSurfaceSection(
  locale: ToolSurfaceLocale,
  sectionId: ToolSurfaceSectionId
): string {
  const header = locale === "en" ? "| Tool | Purpose |" : "| ツール | 役割 |";
  const divider = "| --- | --- |";
  const rows = SECTION_ROWS[sectionId][locale];
  return [header, divider, ...rows].join("\n");
}
