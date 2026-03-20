# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

**[English](../README.md)** | 日本語

---

`@adhisang/minecraft-modding-mcp` は、AI アシスタントに Minecraft のソースコード、マッピング、Mod JAR、レジストリデータ、バリデーションワークフローへの構造化アクセスを提供する [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) サーバーです。

[MCP](https://modelcontextprotocol.io/) は、AI アシスタントが構造化インターフェースを通じて外部ツールを呼び出せるようにするオープンプロトコルです。このサーバーは Claude Desktop、Claude Code、VS Code、Codex CLI、Gemini CLI などの MCP 対応クライアントで利用できます。

**35 ツール**（6 エントリー + 29 エキスパート） | **7 リソース** | **4 マッピング名前空間** | **SQLite ベースのキャッシュ**

## 特長

- **ソース探索**: デコンパイルされた Minecraft ソースコードを、行単位の精度とカーソルページネーション付きファイル一覧で閲覧・検索
- **マルチマッピング変換**: クラス、フィールド、メソッド名を `obfuscated`、`mojang`、`intermediary`、`yarn` の間で変換
- **バージョン比較**: Minecraft バージョン間でクラスシグネチャとレジストリエントリを比較
- **Mod JAR 解析**: Fabric、Forge、NeoForge の Mod JAR からメタデータ、依存関係、エントリポイント、Mixin 設定を抽出
- **Mixin / Access Widener 検証**: ソースや `.accesswidener` ファイルを対象 Minecraft バージョンに対して検証
- **NBT ラウンドトリップ**: NBT バイナリを型付き JSON にデコードし、RFC 6902 パッチを適用して、再び NBT にエンコード
- **レジストリデータとランタイムメトリクス**: 生成済みレジストリスナップショットの参照と、キャッシュやレイテンシカウンターの確認
- **MCP リソース**: バージョン、クラスソース、アーティファクトメタデータ、マッピングを URI ベースのリソースとして公開

## クイックスタート

### パッケージ利用者向け

要件:

- Node.js 22+
- Java は `remap-mod-jar` と、Vineflower または tiny-remapper を必要とするデコンパイル / リマップ処理でのみ必要です

ローカルでサーバーを起動:

```bash
npx -y @adhisang/minecraft-modding-mcp
```

環境によって自動 JAR ダウンロードがブロックされる場合は、クライアント設定で `MCP_VINEFLOWER_JAR_PATH` と `MCP_TINY_REMAPPER_JAR_PATH` を設定してください。

### クライアント設定

CLI クライアント:

- `Claude Code`: `claude mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp`
- `OpenAI Codex CLI`: `codex mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp`

登録後に `claude mcp list` または `codex mcp list` を実行し、サーバーが利用可能になっていることを確認します。

stdio トランスポートは、改行区切り形式と `Content-Length` フレーミングの両方を自動判別するため、Codex と標準的な MCP クライアントの両方で同じサーバー起動コマンドを利用できます。

#### Claude Desktop

`claude_desktop_config.json` に次を追加します:

```json
{
  "mcpServers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"]
    }
  }
}
```

#### VS Code

ワークスペースの `.vscode/mcp.json` に次を追加します:

```json
{
  "servers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"]
    }
  }
}
```

#### Gemini CLI

`~/.gemini/settings.json` に次を追加します:

```json
{
  "mcpServers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"]
    }
  }
}
```

その後、以下を実行します:

```text
/mcp list
```

#### カスタム環境

環境変数を渡してデフォルト値を上書きできます:

```json
{
  "mcpServers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"],
      "env": {
        "MCP_CACHE_DIR": "/path/to/custom/cache",
        "MCP_MAPPING_SOURCE_PRIORITY": "maven-first"
      }
    }
  }
}
```

## まずここから

以下の 6 つのトップレベルワークフローツールは、一般的な作業をカバーし、summary-first の結果を返します。エージェントや MCP クライアントが最初に使う既定の入口として最適です。

| ツール | 主な用途 |
| --- | --- |
| `inspect-minecraft` | バージョン、アーティファクト、クラス、ファイル、ソース検索 |
| `analyze-symbol` | シンボル存在確認、マッピング変換、ライフサイクル追跡、ワークスペースシンボル解決 |
| `compare-minecraft` | バージョン差分、クラス差分、レジストリ差分、移行向け概要 |
| `analyze-mod` | Mod メタデータ、デコンパイル / 検索フロー、クラスソース、安全なリマップの preview/apply |
| `validate-project` | ワークスペース要約と、Mixin / Access Widener の直接検証 |
| `manage-cache` | キャッシュ一覧、検証、preview/apply によるクリーンアップワークフロー |

### ワークフローノート

- これらのトップレベルワークフローツールはまず `result.summary` を返し、次の一手が明確な場合は `summary.nextActions` も含めます。
- `analyze-symbol task="api-overview"` は、`classNameMapping` 未指定時に `sourceMapping` を既定値として引き継ぎます。どちらも未指定のときだけ `obfuscated` にフォールバックします。
- `find-mapping` は `sourceMapping="obfuscated"` のとき、`dhl` のような短い難読化クラス ID も受け付けます。その他のクラスマッピング検索は引き続き完全修飾名を前提とします。
- `trace-symbol-lifecycle` は厳密照合では引き続き別フィールドの `descriptor` を推奨しますが、`symbol` に誤ってインライン署名が含まれていても `Class.method` 部分を先に切り出して解析します。
- `search-class-source` は既定で `queryMode="auto"` を使い、`foo.bar`、`foo_bar`、`foo$bar` のような区切り文字付きクエリもインデックス経路のまま扱います。明示的な全文部分文字列スキャンが必要な場合は `queryMode="literal"` を使ってください。
- 公開パラメータに固定で安全な既定値がある場合、`tools/list` は JSON Schema の `default` フィールドにその値を出します。
- エラー回復用の `suggestedCall` は、指定値がすでにツール既定動作と同じパラメータを省略し、意味を変えずに再試行呼び出しを小さく保ちます。

### あるバージョンの Minecraft ソースを確認する

```json
{
  "tool": "inspect-minecraft",
  "arguments": {
    "task": "class-source",
    "subject": {
      "kind": "class",
      "className": "net.minecraft.server.Main",
      "artifact": {
        "type": "resolve-target",
        "target": {
          "kind": "version",
          "value": "1.21.10"
        }
      }
    }
  }
}
```

### シンボルのマッピングまたは存在確認を行う

```json
{
  "tool": "analyze-symbol",
  "arguments": {
    "task": "map",
    "subject": {
      "kind": "method",
      "owner": "net.minecraft.server.Main",
      "name": "tickServer"
    },
    "version": "1.21.10",
    "sourceMapping": "mojang",
    "targetMapping": "intermediary",
    "signatureMode": "name-only"
  }
}
```

### Mod JAR を要約する

```json
{
  "tool": "analyze-mod",
  "arguments": {
    "task": "summary",
    "subject": {
      "kind": "jar",
      "jarPath": "/path/to/mymod-1.0.0.jar"
    }
  }
}
```

### ワークスペースを検証する

```json
{
  "tool": "validate-project",
  "arguments": {
    "task": "project-summary",
    "subject": {
      "kind": "workspace",
      "projectPath": "/workspace/modid",
      "discover": ["mixins", "access-wideners"]
    },
    "preferProjectVersion": true,
    "preferProjectMapping": true
  }
}
```

## ドキュメント

- [詳細なリクエスト例（英語）](examples.md)
- [ツール / 設定リファレンス（英語）](tool-reference.md)
- [英語版 README](../README.md)

## ツール一覧

明確に狙っている専用操作がない限り、まずは以下のトップレベルワークフローツールから始めてください。より低レベルなツールも、絞り込んだ追加調査や自動化向けに引き続き利用できます。

### トップレベルワークフローツール

<!-- BEGIN GENERATED TOOL TABLE: v3-entry-tools -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `inspect-minecraft` | バージョン、アーティファクト、クラス、ファイル、検索クエリ、ワークスペースから開始し、最適な Minecraft 調査フローへ振り分ける | `task?`, `subject?`, `detail?`, `include?`, `limit?`, `cursor?`, `includeSnapshots?` | `result.summary`, `versions?`, `subject`, `artifact?`, `class?`, `source?`, `members?`, `search?`, `file?`, `files?` |
| `analyze-symbol` | シンボル存在確認、名前空間マッピング、ライフサイクル追跡、ワークスペースシンボル解析、API 概要の単一エントリーポイント | `task`, `subject`, `version?`, `sourceMapping?`, `targetMapping?`, `projectPath?`, `classNameMapping?`, `signatureMode?`, `nameMode?`, `includeKinds?`, `maxRows?`, `maxCandidates?`, `detail?`, `include?` | `result.summary`, `match?`, `candidates?`, `ambiguity?`, `matrix?`, `workspace?` |
| `compare-minecraft` | バージョンペア比較、クラスシグネチャ比較、レジストリ比較、移行向け概要を提供 | `task?`, `subject`, `detail?`, `include?`, `subject.kind="class".sourcePriority?`, `maxClassResults?`, `maxEntriesPerRegistry?`, `includeFullDiff?`, `limit?` | `result.summary`, `comparison`, `classes?`, `classDiff?`, `registry?`, `migration?` |
| `analyze-mod` | Mod 要約、デコンパイル / 検索フロー、クラスソース、安全なリマップ preview/apply のためのメタデータ優先エントリーポイント | `task`, `subject`, `query?`, `searchType?`, `targetMapping?`, `outputJar?`, `executionMode?`, `includeFiles?`, `maxFiles?`, `maxLines?`, `maxChars?`, `limit?`, `detail?`, `include?` | `result.summary`, `metadata?`, `decompile?`, `hits?`, `source?`, `operation?` |
| `validate-project` | ワークスペース要約と、Mixin / Access Widener の直接検証をまとめたプロジェクト単位の検証エントリー | `task`, `subject`, `version?`, `mapping?`, `sourcePriority?`, `scope?`, `preferProjectVersion?`, `preferProjectMapping?`, `sourceRoots?`, `configPaths?`, `minSeverity?`, `hideUncertain?`, `explain?`, `warningMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `includeIssues?`, `detail?`, `include?` | `result.summary`, `project`, `workspace?`, `issues?` |
| `manage-cache` | ユーザー向けのキャッシュ要約、一覧、検証、preview 付き削除 / prune / rebuild、明示的な apply 操作 | `action`, `cacheKinds?`, `selector?`, `executionMode?`, `detail?`, `include?`, `limit?`, `cursor?` | `result.summary`, `stats?`, `cacheEntries?`, `operation?`, `meta.pagination.nextCursor?` |
<!-- END GENERATED TOOL TABLE: v3-entry-tools -->

### ソース探索

Minecraft バージョンの参照、ソースアーティファクトの解決、デコンパイル済みソースコードの読み取り / 検索を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: source-exploration -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `list-versions` | Mojang マニフェストとローカルキャッシュから利用可能な Minecraft バージョンを一覧表示 | `includeSnapshots?`, `limit?` | `result.latest`, `result.releases[]`, `meta.warnings[]` |
| `resolve-artifact` | `version` / `jar` / `coordinate` からソースアーティファクトを解決 | `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `artifactId`, `origin`, `mappingApplied`, `qualityFlags[]`, `artifactContents`, `adjacentSourceCandidates?`, `sampleEntries?`, `warnings[]` |
| `find-class` | アーティファクト内で簡易名または完全修飾クラス名を解決 | `className`, `artifactId`, `limit?` | `matches[]`, `total`, `warnings[]` |
| `get-class-source` | アーティファクトターゲットからクラスソースを取得し、必要に応じてその場で解決する（デフォルトは `mode=metadata`） | `className`, `target`, `mode?`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?`, `startLine?`, `endLine?`, `maxLines?`, `maxChars?`, `outputFile?` | `mode`, `sourceText`, `returnedRange`, `truncated`, `charsTruncated?`, `outputFile?`, `artifactId`, `returnedNamespace`, `artifactContents`, マッピング / 来歴メタデータ |
| `get-class-members` | バイトコードからクラスのフィールド / メソッド / コンストラクタを取得 | `className`, `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `access?`, `includeSynthetic?`, `includeInherited?`, `memberPattern?`, `maxMembers?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `members.{constructors,fields,methods}`, `counts`, `truncated`, `context`, `returnedNamespace`, `artifactContents`, `warnings[]` |
| `search-class-source` | インデックス化されたクラスソースをシンボル / テキスト / パスで検索 | `artifactId`, `query`, `intent?`, `match?`, `packagePrefix?`, `fileGlob?`, `symbolKind?`, `queryMode?`, `limit?`, `cursor?` | `hits[]`, `nextCursor?`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `get-artifact-file` | バイト上限付きでソースファイル全体を読み取る | `artifactId`, `filePath`, `maxBytes?` | `content`, `contentBytes`, `truncated`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `list-artifact-files` | インデックス化されたソースファイルパスをカーソルページネーション付きで一覧表示 | `artifactId`, `prefix?`, `limit?`, `cursor?` | `items[]`, `nextCursor?`, `mappingApplied`, `artifactContents`, `warnings[]` |
| `index-artifact` | 既存アーティファクトのインデックスメタデータを再構築 | `artifactId`, `force?` | `reindexed`, `reason`, `counts`, `indexedAt`, `durationMs` |
<!-- END GENERATED TOOL TABLE: source-exploration -->

### バージョン比較とシンボル追跡

Minecraft バージョン間でのクラス / レジストリ変更比較と、時系列でのシンボル存在追跡を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: version-comparison-symbol-tracking -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `trace-symbol-lifecycle` | `Class.method` が Minecraft のどのバージョンで存在するかを追跡（`descriptor` 省略時は name-only lookup） | `symbol`, `descriptor?`, `fromVersion?`, `toVersion?`, `mapping?`, `sourcePriority?`, `includeSnapshots?`, `maxVersions?`, `includeTimeline?` | `presence.firstSeen`, `presence.lastSeen`, `presence.missingBetween[]`, `presence.existsNow`, `timeline?`, `warnings[]` |
| `diff-class-signatures` | 2 つのバージョン間で 1 つのクラスを比較し、メンバー差分を返す | `className`, `fromVersion`, `toVersion`, `mapping?`, `sourcePriority?`, `includeFullDiff?` | `classChange`, `constructors/methods/fields.{added,removed,modified}`, `modified`, `modified[].{key,changed,from?,to?}`, `summary`, `warnings[]` |
| `compare-versions` | 2 つのバージョン間でクラス / レジストリ変更を比較 | `fromVersion`, `toVersion`, `category?`, `packageFilter?`, `maxClassResults?` | `classes`, `registry`, `summary`, `warnings[]` |
<!-- END GENERATED TOOL TABLE: version-comparison-symbol-tracking -->

### マッピングとシンボル

名前空間間でのシンボル名変換と、シンボル存在確認を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: mapping-symbols -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `find-mapping` | クラス / フィールド / メソッドのシンボルについて、名前空間間のマッピング候補を検索 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `disambiguation?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `ambiguityReasons?`, `provenance?`, `meta.warnings[]` |
| `resolve-method-mapping-exact` | owner + name + descriptor の厳密一致で 1 つのメソッドマッピングを解決 | `version`, `name`, `owner`, `descriptor`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `provenance?`, `meta.warnings[]` |
| `get-class-api-matrix` | 1 つのクラス API をマッピングマトリクス（`obfuscated/mojang/intermediary/yarn`）として表示 | `version`, `className`, `classNameMapping`, `includeKinds?`, `sourcePriority?`, `maxRows?` | `classIdentity`, `rows[]`, `rowCount`, `rowsTruncated?`, `ambiguousRowCount?`, `meta.warnings[]` |
| `resolve-workspace-symbol` | Gradle ワークスペース（`build.gradle/.kts`）でコンパイル時に見えるシンボル名を解決 | `projectPath`, `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `workspaceDetection`, `meta.warnings[]` |
| `check-symbol-exists` | クラス / フィールド / メソッドの厳密な存在確認 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `nameMode?`, `signatureMode?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `meta.warnings[]` |
<!-- END GENERATED TOOL TABLE: mapping-symbols -->

### NBT ユーティリティ

型付き JSON 表現を使って、Java Edition の NBT バイナリデータをデコード、パッチ、エンコードするツール群です。

<!-- BEGIN GENERATED TOOL TABLE: nbt-utilities -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `nbt-to-json` | Java Edition の NBT バイナリ（`base64`）を型付き JSON にデコード | `nbtBase64`, `compression?` (`none`, `gzip`, `auto`) | `typedJson`, `meta.compressionDetected`, `meta.inputBytes` |
| `nbt-apply-json-patch` | RFC 6902 パッチ（`add/remove/replace/test`）を型付き NBT JSON に適用 | `typedJson`, `patch` | `typedJson`, `meta.appliedOps`, `meta.testOps`, `meta.changed` |
| `json-to-nbt` | 型付き JSON を Java Edition の NBT バイナリ（`base64`）へ再エンコード | `typedJson`, `compression?` (`none`, `gzip`) | `nbtBase64`, `meta.outputBytes`, `meta.compressionApplied` |
<!-- END GENERATED TOOL TABLE: nbt-utilities -->

### Mod 解析

Mod JAR からのメタデータ抽出、Mod ソースのデコンパイル、Mod コード検索、Mod 名前空間のリマッピングを行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: mod-analysis -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `analyze-mod-jar` | Mod JAR から Mod メタデータ / 依存関係 / エントリポイントを抽出 | `jarPath`, `includeClasses?` | `modId`, `loader`, `jarKind`, `dependencies`, `entrypoints`, `mixinConfigs`, class stats |
| `decompile-mod-jar` | Mod JAR をデコンパイルし、必要に応じて 1 つのクラスソースを返す | `jarPath`, `className?`, `includeFiles?`, `maxFiles?` | `outputDir`, `fileCount`, `files?`, `returnedFileCount?`, `filesTruncated?`, `filesOmitted?`, `source?`, `warnings[]` |
| `get-mod-class-source` | デコンパイル済み Mod キャッシュから 1 つのクラスソースを読み取る | `jarPath`, `className`, `maxLines?`, `maxChars?`, `outputFile?` | `className`, `content`, `totalLines`, `truncated?`, `charsTruncated?`, `outputFilePath?`, `warnings[]` |
| `search-mod-source` | デコンパイル済み Mod ソースを class / method / field / content で検索 | `jarPath`, `query`, `searchType?`, `limit?` | `hits[]`, `totalHits`, `truncated`, `warnings[]` |
| `remap-mod-jar` | Fabric / Quilt Mod JAR を yarn / mojang 名へリマップする。`targetMapping="mojang"` で Mojang マップ済み入力はコピー扱い | `inputJar`, `targetMapping`, `mcVersion?`, `outputJar?` | `outputJar`, `mcVersion`, `fromMapping`, `targetMapping`, `resolvedTargetNamespace`, `warnings[]` |
<!-- END GENERATED TOOL TABLE: mod-analysis -->

### バリデーション

Mixin ソースや Access Widener ファイルを、対象 Minecraft バージョンに対して検証するツール群です。

<!-- BEGIN GENERATED TOOL TABLE: validation -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `validate-mixin` | 対象 Minecraft バージョンに対して Mixin ソースを解析 / 検証 | `input`, `sourceRoots?`, `version`, `mapping?`, `sourcePriority?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `minSeverity?`, `hideUncertain?`, `warningMode?`, `preferProjectMapping?`, `reportMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `explain?`, `includeIssues?` | `mode`, `results[].validationStatus`, `summary.partial`, `issueSummary?`, `provenance?`, `incompleteReasons?`, `toolHealth?`, `confidenceScore?`, `confidenceBreakdown?` |
| `validate-access-widener` | 対象バージョンに対して Access Widener の内容を解析 / 検証 | `content`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |
<!-- END GENERATED TOOL TABLE: validation -->

### レジストリと診断

生成済みレジストリデータの取得と、サーバーのランタイム状態の確認を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: registry-diagnostics -->
| ツール | 役割 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `get-registry-data` | 生成済みレジストリスナップショット（ブロック / アイテム / エンティティなど）を取得 | `version`, `registry?`, `includeData?`, `maxEntriesPerRegistry?` | `registries`, `data?`, `entryCount`, `returnedEntryCount?`, `registryEntryCounts?`, `dataTruncated?`, `warnings[]` |
| `get-runtime-metrics` | ランタイムカウンターとレイテンシスナップショットを確認 | none | `result.*` runtime metrics, `meta` envelope |
<!-- END GENERATED TOOL TABLE: registry-diagnostics -->

詳細なパラメータ制約、移行メモ、リソースの挙動、環境変数の完全な一覧は [tool-reference.md](tool-reference.md) を参照してください。

## リソース

固定リソース:

- `mc://versions/list`
- `mc://metrics`

テンプレートリソース:

- `mc://source/{artifactId}/{className}`
- `mc://artifact/{artifactId}/files/{filePath}`
- `mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}`
- `mc://artifact/{artifactId}/members/{className}`
- `mc://artifact/{artifactId}`

完全なリソース一覧とレスポンス挙動は [tool-reference.md#resources](tool-reference.md#resources) を参照してください。

## レスポンスモデル

ツールと JSON リソースは、標準の `{ result?, error?, meta }` エンベロープを返します。テキストリソース（`class-source` と `artifact-file`）は、成功時は生テキスト、失敗時は構造化 JSON を返します。

エンベロープの正確なフィールドとエラー形式は [tool-reference.md#response-envelope](tool-reference.md#response-envelope) を参照してください。

## よく使う環境変数

ここでは変更頻度の高い設定だけを示します。完全な一覧は [tool-reference.md#environment-variables](tool-reference.md#environment-variables) を参照してください。

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `MCP_CACHE_DIR` | `~/.cache/minecraft-modding-mcp` | ダウンロードと SQLite のキャッシュルート |
| `MCP_SOURCE_REPOS` | Maven Central + Fabric + Forge + NeoForge | カンマ区切りの Maven リポジトリ URL |
| `MCP_MAPPING_SOURCE_PRIORITY` | `loom-first` | マッピングソース優先度（`loom-first` または `maven-first`） |
| `MCP_ENABLE_INDEXED_SEARCH` | `true` | `search-class-source` のインデックス検索を有効化 |
| `MCP_VINEFLOWER_JAR_PATH` | 未設定 | Vineflower JAR パスを上書き |
| `MCP_TINY_REMAPPER_JAR_PATH` | 未設定 | tiny-remapper JAR パスを上書き |
| `MCP_MAX_SEARCH_HITS` | `200` | 検索結果の最大件数 |
| `MCP_MAX_CACHE_BYTES` | `2147483648` | キャッシュ総量の最大バイト数 |

## 開発

リポジトリ要件:

- Node.js 22+
- `pnpm`
- ローカルでリマップやデコンパイルを実行する場合は Java

リポジトリをセットアップして起動:

```bash
pnpm install
pnpm dev
```

配布形態をビルド:

```bash
pnpm build
pnpm start
```

常に実行:

```bash
pnpm check
pnpm test
```

必要に応じて実行:

- `pnpm test:manual:stdio-smoke`: MCP トランスポート、登録、手動ワークフローの変更時
- `pnpm test:manual:package-smoke`: パッケージインストールや配布形態の検証時
- `pnpm test:perf`: 検索、インデックス、性能に影響する変更時
- `pnpm test:coverage` または `pnpm test:coverage:lcov`: カバレッジ確認時（`lines=80`, `branches=70`, `functions=80`）
- `pnpm validate`: ローカルの完全検証スイートを実行する場合

## ライセンス

[MIT](../LICENSE)
