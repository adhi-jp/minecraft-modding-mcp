# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

> [English version / 英語版](../README.md)

---

`@adhisang/minecraft-modding-mcp` は、AI アシスタントに Minecraft のソースコード・マッピング・Mod ツーリングへの深いアクセスを提供する [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) サーバーです。

デコンパイルされた Minecraft ソースの探索、4つの命名空間（`obfuscated`、`mojang`、`intermediary`、`yarn`）間でのシンボル名変換、Fabric/Forge/NeoForge Mod JAR の解析・デコンパイル、Mixin と Access Widener ファイルのバリデーション、NBT データの読み書きとパッチ、生成済みレジストリスナップショットのクエリなど — Claude Desktop、VS Code、その他の MCP 対応クライアント向けに設計された構造化ツール＆リソースインターフェースを通じて、これらすべての操作を行えます。

**29 ツール** | **7 リソース** | **4 名前空間マッピング** | **SQLite キャッシュ**

## 特徴 (Features)

- **ソースコード探索** — デコンパイルされた Minecraft ソースを行レベルの精度で閲覧・検索し、カーソルページネーション付きでファイル一覧を取得
- **マルチマッピング変換** — クラス・フィールド・メソッド名を `obfuscated`、`mojang`、`intermediary`、`yarn` 名前空間間で変換
- **シンボルライフサイクル追跡** — メソッドやフィールドが Minecraft バージョン間でいつ追加・削除・変更されたかを追跡
- **Mod JAR 解析** — Fabric/Forge/NeoForge Mod JAR からメタデータ、依存関係、エントリポイント、Mixin 設定を抽出
- **Mixin & Access Widener バリデーション** — Mixin ソースと `.accesswidener` ファイルを対象 Minecraft バージョンに対して検証
- **NBT ラウンドトリップ** — NBT バイナリを型付き JSON にデコードし、RFC 6902 パッチを適用し、NBT に再エンコード
- **レジストリデータ** — 任意の Minecraft バージョンの生成済みレジストリスナップショット（ブロック、アイテム、エンティティなど）をクエリ
- **バージョン比較** — 2つの Minecraft バージョン間でクラスシグネチャとレジストリエントリの差分を取得
- **JAR リマッピング** — Fabric Mod JAR を `intermediary` から `yarn` または `mojang` 名前空間にリマップ
- **MCP リソース** — バージョン一覧、クラスソース、アーティファクトメタデータ、マッピングに URI ベースでアクセス

## クイックスタート (Quick Start)

### 前提条件
- Node.js 22+
- pnpm

### ユーザー向け（インストール済みパッケージ）
```bash
npx @adhisang/minecraft-modding-mcp
```

### CLI エージェントツール (CLI Agent Tools)

#### Claude Code

```bash
claude mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
claude mcp list
```

#### OpenAI Codex CLI

```bash
codex mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
codex mcp list
```

stdio トランスポートは改行区切り JSON と `Content-Length` フレーミングの両方を自動判別するため、Codex と改行ベースの MCP クライアントで同じサーバー起動コマンドを利用できます。

サーバーは MCP ハンドシェイクとツール検出中のコールドスタートを軽減するため、重量級のソース/インデックスサービスを最初の MCP リクエストまで遅延初期化します。
クライアント互換の起動安定性を優先するため、起動直後に `SourceService` を先行初期化することは行いません。

#### Gemini CLI

`~/.gemini/settings.json` に以下を追加します:

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

その後、Gemini CLI 上で次のコマンドを実行します:

```text
/mcp list
```

### 開発者向け（リポジトリ）
```bash
pnpm install
```

### 実行（開発モード）
```bash
pnpm dev
```

### ビルド＋実行（配布形態）
```bash
pnpm build
pnpm start
```

### 検証
```bash
pnpm check
pnpm test
pnpm test:coverage
```

### カバレッジ (Coverage)
```bash
pnpm test:coverage
```

カバレッジしきい値: `lines=80`, `branches=70`, `functions=80`。

Codecov へアップロードする LCOV 出力を生成:

```bash
pnpm test:coverage:lcov
```

GitHub Actions のアップロードワークフロー: `.github/workflows/codecov.yml`（現在は一時的に無効化中。再有効化時は `v*` タグ時および手動実行でトリガー）。

### MCP クライアント設定 (MCP Client Configuration)

#### Claude Desktop

`claude_desktop_config.json` に以下を追加します:

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

ワークスペースの `.vscode/mcp.json` に以下を追加します:

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

#### カスタム環境変数

環境変数を指定してデフォルト設定をオーバーライドできます:

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

## ツール一覧 (Tool Surface)

### ソースコード探索 (Source Exploration)

Minecraft バージョンの一覧取得、ソースアーティファクトの解決、デコンパイルされたソースの読み取り・検索を行うツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `list-versions` | Mojang マニフェスト＋ローカルキャッシュから利用可能な Minecraft バージョンを一覧表示 | `includeSnapshots?`, `limit?` | `result.latest`, `result.releases[]`, `meta.warnings[]` |
| `resolve-artifact` | `version` / `jar` / `coordinate` からソースアーティファクトを解決 | `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `artifactId`, `origin`, `mappingApplied`, `qualityFlags[]`, `artifactContents`, `adjacentSourceCandidates?`, `sampleEntries?`, `warnings[]` |
| `find-class` | アーティファクト内で簡易名または FQCN からクラスを解決 | `className`, `artifactId`, `limit?` | `matches[]`, `total`, `warnings[]` |
| `get-class-source` | アーティファクト target からクラスソースを取得（デフォルト `mode=metadata`） | `className`, `target`, `mode?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?`, `startLine?`, `endLine?`, `maxLines?`, `maxChars?`, `outputFile?` | `mode`, `sourceText`, `returnedRange`, `truncated`, `charsTruncated?`, `outputFile?`, `artifactId`, `returnedNamespace`, `artifactContents`, マッピング/来歴メタデータ |
| `get-class-members` | バイトコードからクラスのフィールド/メソッド/コンストラクタを取得 | `className`, `target`, `mapping?`, `access?`, `includeInherited?`, `maxMembers?`, `strictVersion?` | `members.{constructors,fields,methods}`, `counts`, `truncated`, `context`, `returnedNamespace`, `artifactContents`, `warnings[]` |
| `search-class-source` | インデックス化されたクラスソースからシンボル/テキスト/パスを検索 | `artifactId`, `query`, `intent?`, `match?`, `packagePrefix?`, `fileGlob?`, `symbolKind?`, `queryMode?`, `limit?`, `cursor?` | `hits[]`, `nextCursor?`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `get-artifact-file` | バイトガード付きでソースファイル全体を読み取り | `artifactId`, `filePath`, `maxBytes?` | `content`, `contentBytes`, `truncated`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `list-artifact-files` | カーソルページネーション付きでインデックス化されたソースファイルパスを一覧表示 | `artifactId`, `prefix?`, `limit?`, `cursor?` | `items[]`, `nextCursor?`, `mappingApplied`, `artifactContents`, `warnings[]` |
| `index-artifact` | 既存アーティファクトのインデックスメタデータを再構築 | `artifactId`, `force?` | `reindexed`, `reason`, `counts`, `indexedAt`, `durationMs` |

### バージョン比較＆シンボル追跡 (Version Comparison & Symbol Tracking)

Minecraft バージョン間でのクラス/レジストリの変更比較と、シンボルの存在を時系列で追跡するツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `trace-symbol-lifecycle` | `Class.method` が Minecraft バージョン間でいつ存在するかを追跡 | `symbol`, `descriptor?`, `fromVersion?`, `toVersion?`, `mapping?`, `sourcePriority?`, `maxVersions?`, `includeTimeline?` | `presence.firstSeen`, `presence.lastSeen`, `presence.missingBetween[]`, `presence.existsNow`, `timeline?`, `warnings[]` |
| `diff-class-signatures` | 2つのバージョン間で1つのクラスを比較しメンバーの差分を返す | `className`, `fromVersion`, `toVersion`, `mapping?`, `sourcePriority?`, `includeFullDiff?` | `classChange`, `constructors/methods/fields.{added,removed,modified}`, `modified`, `modified[].{key,changed,from?,to?}`, `summary`, `warnings[]` |
| `compare-versions` | 2つのバージョン間のクラス/レジストリの変更を比較 | `fromVersion`, `toVersion`, `category?`, `packageFilter?`, `maxClassResults?` | `classes`, `registry`, `summary`, `warnings[]` |

### マッピング＆シンボル (Mapping & Symbols)

名前空間間でのシンボル名変換とシンボルの存在確認を行うツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `find-mapping` | クラス/フィールド/メソッドのシンボルに対するマッピング候補を名前空間間で検索 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `disambiguation?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `ambiguityReasons?`, `provenance?`, `meta.warnings[]` |
| `resolve-method-mapping-exact` | owner+name+descriptor の厳密マッチングで1つのメソッドマッピングを解決 | `version`, `name`, `owner`, `descriptor`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `provenance?`, `meta.warnings[]` |
| `get-class-api-matrix` | 1つのクラス API をマッピングマトリクスとして表示（`obfuscated/mojang/intermediary/yarn`） | `version`, `className`, `classNameMapping`, `includeKinds?`, `sourcePriority?`, `maxRows?` | `classIdentity`, `rows[]`, `rowCount`, `rowsTruncated?`, `ambiguousRowCount?`, `meta.warnings[]` |
| `resolve-workspace-symbol` | Gradle ワークスペース（`build.gradle/.kts`）のコンパイル時可視シンボル名を解決 | `projectPath`, `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `workspaceDetection`, `meta.warnings[]` |
| `check-symbol-exists` | クラス/フィールド/メソッドの厳密な存在確認 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `nameMode?`, `signatureMode?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `meta.warnings[]` |

### NBT ユーティリティ (NBT Utilities)

型付き JSON 表現を使用して Java Edition NBT バイナリデータのデコード、パッチ、エンコードを行うツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `nbt-to-json` | Java Edition NBT バイナリ（`base64`）を型付き JSON にデコード | `nbtBase64`, `compression?` (`none`, `gzip`, `auto`) | `typedJson`, `meta.compressionDetected`, `meta.inputBytes` |
| `nbt-apply-json-patch` | RFC 6902 パッチ（`add/remove/replace/test`）を型付き NBT JSON に適用 | `typedJson`, `patch` | `typedJson`, `meta.appliedOps`, `meta.testOps`, `meta.changed` |
| `json-to-nbt` | 型付き JSON を Java Edition NBT バイナリ（`base64`）にエンコード | `typedJson`, `compression?` (`none`, `gzip`) | `nbtBase64`, `meta.outputBytes`, `meta.compressionApplied` |

### Mod 解析 (Mod Analysis)

Mod JAR からのメタデータ抽出、Mod ソースのデコンパイル、Mod コードの検索、Mod 名前空間のリマッピングを行うツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `analyze-mod-jar` | Mod JAR から Mod メタデータ/依存関係/エントリポイントを抽出 | `jarPath`, `includeClasses?` | `modId`, `loader`, `jarKind`, `dependencies`, `entrypoints`, `mixinConfigs`, クラス統計 |
| `decompile-mod-jar` | Mod JAR をデコンパイルし、オプションで1つのクラスソースを返す | `jarPath`, `className?`, `includeFiles?`, `maxFiles?` | `outputDir`, `fileCount`, `files?`, `returnedFileCount?`, `filesTruncated?`, `filesOmitted?`, `source?`, `warnings[]` |
| `get-mod-class-source` | デコンパイル済みキャッシュから1つのクラスソースを読み取り | `jarPath`, `className`, `maxLines?`, `maxChars?`, `outputFile?` | `className`, `content`, `totalLines`, `truncated?`, `charsTruncated?`, `outputFilePath?`, `warnings[]` |
| `search-mod-source` | デコンパイル済み Mod ソースをクラス/メソッド/フィールド/コンテンツで検索 | `jarPath`, `query`, `searchType?`, `limit?` | `hits[]`, `totalHits`, `truncated`, `warnings[]` |
| `remap-mod-jar` | Fabric Mod JAR を intermediary から yarn/mojang 名にリマップ | `inputJar`, `targetMapping`, `mcVersion?`, `outputJar?` | `outputJar`, `mcVersion`, `fromMapping`, `targetMapping`, `resolvedTargetNamespace`, `warnings[]` |

### バリデーション (Validation)

Mixin ソースと Access Widener ファイルを対象 Minecraft バージョンに対してバリデーションするツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `validate-mixin` | Mixin ソースを対象 Minecraft バージョンに対してパース/バリデーション | `input`, `sourceRoots?`, `version`, `mapping?`, `sourcePriority?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `minSeverity?`, `hideUncertain?`, `warningMode?`, `preferProjectMapping?`, `reportMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `explain?`, `includeIssues?` | `mode`, `results[].validationStatus`, `summary.partial`, `issueSummary?`, `provenance?`, `incompleteReasons?`, `toolHealth?`, `confidenceScore?`, `confidenceBreakdown?` |
| `validate-access-widener` | Access Widener コンテンツを対象バージョンに対してパース/バリデーション | `content`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |

### レジストリ＆診断 (Registry & Diagnostics)

生成済みレジストリデータのクエリとサーバーランタイム状態の検査を行うツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `get-registry-data` | 生成済みレジストリスナップショット（blocks/items/entities 等）を取得 | `version`, `registry?`, `includeData?`, `maxEntriesPerRegistry?` | `registries`, `data?`, `entryCount`, `returnedEntryCount?`, `registryEntryCounts?`, `dataTruncated?`, `warnings[]` |
| `get-runtime-metrics` | ランタイムカウンターとレイテンシスナップショットを検査 | なし | `result.*` ランタイムメトリクス, `meta` エンベロープ |

### ツール制約事項 (Tool Constraints)

`resolve-artifact` は `target: { kind, value }` を受け取ります。
`get-class-source` は `target` を必須とし、`target.type="artifact"` で既に解決済みの `artifactId` を選択し、`target.type="resolve"` で `{ kind, value }` を直接渡します。
`get-class-members` も同じ `target` オブジェクト形状を必須とし、`.class` エントリを読むためにバイナリ JAR（`binaryJarPath`）が必要です。
エラーの `suggestedCall` も、旧 `targetKind` / `targetValue` ではなく同じ `target` オブジェクト形状を返します。
正の整数パラメータは JSON 数値に加えて `"10"` のような数値文字列も受け付けます。
この数値文字列の coercion は、ドキュメント化されたトップレベルのツール引数にのみ適用されます。ネストされた `typedJson` payload や JSON Patch の `value` オブジェクトはそのまま保持されます。
`resolve-artifact`、`get-class-source`、`get-class-members`、`search-class-source`、`get-artifact-file`、`list-artifact-files` は `artifactContents` を返し、アーティファクトが `source-jar` 由来か `decompiled-binary` 由来か、resources がインデックスされているか（現状は `resourcesIncluded=false`）、source coverage が常に `full` または `partial` のどちらかであることを確認できます。
`get-class-source`、`get-class-members`、`search-class-source`、`get-artifact-file` は `returnedNamespace` を返します。raw のインデックス名前空間を示す `mappingApplied` と比較することで、返却値が要求 mapping へ remap 済みかどうかを判断できます。
`list-artifact-files` は `assets/` や `data/` の prefix を調べたとき、現行インデックスが Java ソースのみで non-Java resources を含まないことを warning で返します。
`get-class-source` と `get-class-members` は、artifact metadata に version が無い場合でも `preferProjectVersion=true` と `projectPath` があれば `gradle.properties` から version を補完できます。
重い解析系ツール（`trace-symbol-lifecycle`、`diff-class-signatures`、`compare-versions`、`find-mapping`、`resolve-method-mapping-exact`、`get-class-api-matrix`、`get-registry-data`）は stdio transport を守るためサーバ内部で直列化されます。キューが一杯のときは `ERR_LIMIT_EXCEEDED` で即座に失敗します。
CLI の stdio entrypoint は supervised worker process として動作します。worker が予期せず終了した場合でも wrapper が再起動し、現在の session 用 MCP initialize を replay して同じ stdio 接続を継続します。すでに実行中だった request は transport 全断ではなく、再試行可能な JSON-RPC internal error として失敗します。
`find-mapping`、`resolve-method-mapping-exact`、`resolve-workspace-symbol`、`check-symbol-exists` は `maxCandidates` で `candidates[]` を上限付きにできます。`candidateCount` は切り詰め前の総候補数を返し、`candidatesTruncated=true` で切り詰めを示します。
`get-class-api-matrix` は `maxRows` を受け付けます。`rowCount` は切り詰め前の総行数を返し、`rowsTruncated=true` で切り詰めを示します。
`diff-class-signatures` は `includeFullDiff=false` をサポートし、`modified[]` から `from` / `to` のスナップショットを省略して `key` と `changed` のみを返せます。
`validate-mixin` は `input.mode` が `inline` / `path` / `paths` / `config` / `project` のいずれかである必要があります。`input.path` / `input.paths[]` はファイル読み取り前にホスト/WSL パス形式へ正規化されます。`input.configPaths[]` は mixin config JSON を読み込み、バッチ検証用のソースファイルを自動検出します（`sourceRoots[]` で探索ルートを上書き可能。未指定時は `src/main/java`、`src/client/java`、`common/src/{main,client}/java`、`fabric/src/{main,client}/java`、`neoforge/src/{main,client}/java`、`forge/src/{main,client}/java`、`quilt/src/{main,client}/java` などを自動検出）。`input.mode="project"` を使うと `input.path` 配下の `**/*.mixins.json` を再帰探索し、`projectPath` 既定値もその workspace root に合わせて config ベースの一括検証を実行します。
`validate-mixin` は常に `mode`、`results[]`、`summary` を返し、単一入力モードでも 1 要素の `results[]` 配列を使います。
`validate-mixin` は `includeIssues=false` をサポートし、サマリを維持したまま各結果の `issues[]` を省略できます。レスポンスを小さくしたい場合は `reportMode=compact` と `warningMode=aggregated` を併用してください。
`reportMode=summary-first` は共有 provenance、warnings、incomplete reason をトップレベルへ集約し、重複する per-result metadata を削ります。
`validate-mixin` の各結果は `validationStatus`（`full` / `partial` / `invalid`）に加え、`summary.membersValidated`、`summary.membersSkipped`、`summary.membersMissing` を返します。`quickSummary` も issue 件数だけでなくメンバー検証カバレッジを含みます。
`validate-mixin` のバッチ `summary` には `partial` が追加され、完全に通った結果とツール制約つきの部分成功を区別できます。
`validate-mixin` は、target metadata を十分に取得できない場合に `validation-incomplete` を返します。
`validate-mixin` のレスポンスには `confidenceBreakdown` が追加され、base score と減点理由を確認できます。
`validate-mixin` の各結果には、マッピングフォールバック時に `provenance.resolutionNotes?` が含まれます。
`validate-mixin` の provenance には `requestedScope` / `appliedScope` と `requestedSourcePriority` / `appliedSourcePriority` が含まれ、フォールバックや再試行の実際の適用結果を確認できます。
`scope="loader"` は現時点では `scope="merged"` と同じ解決クラスを使います。
`validate-mixin` は、マッピング/署名解決の制約で `loom-first` の結果が partial になった場合、自動で `sourcePriority="maven-first"` に再試行し、その事実を warning と provenance note に残します。
`validate-mixin` は `@Invoker` をメソッドのみ、`@Accessor` をフィールドのみに対して検証します。
`validate-mixin` パーサーは `.class` リテラルターゲットと `targets = "..."` / `targets = {"a", "b"}` の文字列形式を両方サポートします。
`validate-mixin` パーサーは `@Shadow` / `@Accessor` と宣言の間にある複数行アノテーションを処理し、宣言行からインラインアノテーションを除去します。
`validate-mixin` はクラスマッピング失敗時に `target-mapping-failed`（warning、uncertain）と `target-not-found`（error）を区別します。
`validate-mixin` の issues と `structuredWarnings` には `category`（`mapping`、`configuration`、`validation`、`resolution`、`parse`）が含まれ、設定やツーリングの制約と実際の検証エラーを区別します。
`validate-mixin` は `minSeverity`、`hideUncertain`、`warningCategoryFilter` による後段フィルタリングをサポートし、`treatInfoAsWarning=false` で `structuredWarnings` の info レベル項目を抑制できます。
`validate-mixin` の各結果には、各メンバーの解決状態（`resolved` / `not-found`）を追跡する `resolvedMembers?` が含まれます。
`validate-mixin` に `explain=true` を指定すると、各 issue に `explanation` と `suggestedCall`（tool + params）が追加され、エージェント駆動のリカバリを支援します。生成される `check-symbol-exists` 向け recovery payload は、そのツールの公開 schema に収まる引数だけを返します。
Schema validation failure でも標準の `ERR_INVALID_INPUT` エンベロープを返し、`fieldErrors`、`hints`、および raw source をそのまま `input` に渡してしまったような典型的な `validate-mixin` ミス向けの mode 補正済み `suggestedCall` を含みます。
bare string の `target` を渡した場合も `ERR_INVALID_INPUT` と schema-valid な `suggestedCall` を返します。
`validate-mixin` の summary は `processingErrors`、`totalValidationErrors`、`totalValidationWarnings` を使用し、非推奨の `summary.errors` は削除されました。
`check-symbol-exists` は、Maven tiny mapping fallback が成功した場合に raw な `No Loom tiny mapping files matched version ...` warning を繰り返さず、fallback したことだけを短い warning で返します。
`resolve-artifact` は `target.kind=version` かつ `mapping=mojang` の場合のみ `projectPath` から Loom キャッシュ探索を行います。マッピング失敗時は `searchedPaths`、`candidateArtifacts`、`recommendedCommand` をエラー詳細に含みます。
`resolve-artifact` は `scope`（`vanilla` / `merged` / `loader`）と `preferProjectVersion=true` をサポートし、`target.kind=version` のとき `gradle.properties` の `minecraft_version` / `mc_version` / `minecraftVersion` で `target.value` を上書きできます。
`resolve-artifact` は `target.kind=coordinate` のとき、`ERR_SOURCE_NOT_FOUND` を返す前にローカル Maven リポジトリ、ローカル Gradle `modules-2` キャッシュ、設定済み `MCP_SOURCE_REPOS` を探索します。
`resolve-artifact` はソース JAR が解決された場合にのみ `sampleEntries` を含みます。デコンパイル専用パスでは未設定です。
`resolve-artifact` は、merged Loom ソース候補に `net.minecraft` が含まれない場合に `qualityFlags=["partial-source-no-net-minecraft"]` と warning を返します。`get-class-source` はその sibling `*-sources.jar` をバイナリフォールバック時に迂回し、実際にバイナリアーティファクトへ到達できるようになりました。
`find-class` はタイプシンボル（`class` / `interface` / `enum` / `record`）のみを返し、完全修飾名の検索は正確な FQCN / file path で絞り込むことで同名クラスが多い場合の偽陰性を避けます。
`find-class` は、`obfuscated` アーティファクトに deobfuscated な Mojang クラス名らしい名前で問い合わせた場合、説明付き warning を返します。
`find-class` は、`partial-source-no-net-minecraft` が付いたアーティファクトに対する vanilla らしいクエリで非 vanilla の一致を抑制し、無関係な modded class を返す代わりに warning を返します。
`search-class-source` のデフォルト `limit` は `20` です。
`search-class-source` の `queryMode` は検索戦略を制御します。`auto`（デフォルト）はインデックストークン検索に加え、区切り文字クエリではリテラルフォールバックを行い、`token` はインデックストークン検索のみ、`literal` は部分文字列スキャンのみです。
`search-class-source` の `match=regex` は `query.length <= 200` と厳格な結果上限 `100` を適用します。
`search-class-source` は snippets、行ウィンドウ、relation expansion、`totalApprox` を含まない compact な file hit のみを返します。
検索結果ファイルの中身を確認するには `get-artifact-file` または `get-class-source` を使用してください。
`search-class-source` の `symbolKind` は `intent=symbol` の場合のみサポートされます。
`get-artifact-file` のバイト切り詰めは UTF-8 文字境界を保持し、`maxBytes` がマルチバイト文字の途中で切れた場合でも置換文字（`�`）の破損を防ぎます。
`search-class-source` の `fileGlob` は `*`、`**`、`?` をサポートし、`net/minecraft/**/*.java` のような再帰パターンを使えます。
`get-class-source` のフォールバック照合はパッケージ互換性を強制し、他パッケージの同名クラスしか存在しない場合は `ERR_CLASS_NOT_FOUND` を返します。
`get-class-source` は、ソースバックされたアーティファクトが partial な場合（例: `net.minecraft` を含まない merged Loom sources）、sibling のバイナリアーティファクトへフォールバックします。それでもソースを生成できない場合は partial-source の文脈を保ったエラーを返し、`find-class` ではなく `get-class-api-matrix` を案内します。
`get-class-source` は、フォールバックで返した source text の名前空間が要求された mapping と異なる場合に warning を返します。source text 自体は remap しません。
`get-class-source` の `mode` はデフォルトで `metadata`（symbol outline のみ）です。`mode=snippet` は行範囲や max の指定がない場合に `maxLines=200` を自動設定し、`mode=full` はソース全体を返します。`outputFile` は選択されたテキストを書き出し、そのパスを `outputFile` に返します。
`resolve-artifact` / `get-class-source` の decompile fallback は、Vineflower のフラグを位置引数 `<input-jar> <output-dir>` より前に渡すことで、正しい JAR での偽 `ERR_DECOMPILER_FAILED` を防ぎます。
`resolve-artifact` は `target.kind=jar` の場合、正確な sibling `"<jar-basename>-sources.jar"` だけを自動採用します。他の隣接 `*-sources.jar` は `adjacentSourceCandidates` として情報のみ返し、自動選択はしません。
解決済みアーティファクトが `*-sources.jar` 由来の場合、`get-class-members` は source jar を bytecode として扱わず、sibling の binary jar（例: `minecraft-merged-<version>.jar`）を保持します。また、member 名を要求 mapping に戻す前に、解決済みアーティファクトの名前空間でクラスを検索します。
`target.kind=coordinate` で classifier 付き（`group:artifact:version:classifier`）の場合、ローカル Maven の source lookup はまず `<artifact>-<version>-<classifier>-sources.jar`、次に `<artifact>-<version>-sources.jar` を確認します。
Mod 系ツールの `jarPath` 入力は、存在確認・キャッシュキー生成・処理の前に正規のローカル `.jar` ファイルパスへ正規化されます。
`search-mod-source` は `query.length <= 200` と `limit <= 200` を適用します。
`search-mod-source` は source-only jar を検出し、デコンパイルせず `.java` エントリを直接検索します。
`get-mod-class-source` は `maxLines`、`maxChars`、`outputFile` をサポートし、`get-class-source` と揃えた切り詰め動作を行います。`outputFile` を指定した場合、書き出されたファイルにも切り詰め結果が反映されます。
`decompile-mod-jar` は `includeFiles=false` で全クラス一覧を省略でき、`maxFiles` で一覧件数を制限できます。`returnedFileCount`、`filesTruncated`、`filesOmitted` で整形結果を明示します。
`find-mapping` は `status=ambiguous` のとき、候補を一意に解決できなかった理由を説明する `ambiguityReasons` を返します。
`get-class-api-matrix` は、1 行以上で ambiguity fallback が発生した場合に `ambiguousRowCount` を返します。
`check-symbol-exists` はデフォルトで厳密な FQCN クラス入力を要求します。`nameMode=auto` を指定すると短いクラス名を許可し、曖昧一致は `status=ambiguous` を返します。
`check-symbol-exists` は `signatureMode=name-only` で descriptor なしの owner+name マッチングをサポートします。単一一致は `resolved`、複数オーバーロードは全候補付きの `ambiguous` を返します。
`check-symbol-exists` は常に最初に入力形状を検証し、マッピングデータが使えない状況でも、不正なシンボル組み合わせには `ERR_INVALID_INPUT` を返します。
`get-registry-data` は `includeData=false` でレジストリ名と件数だけを返せます。`maxEntriesPerRegistry` は各レジストリで返す entry 数を制限しつつ、完全な `entryCount` と `registryEntryCounts` は保持します。
移行メモ:
- `resolve-artifact` の `targetKind` + `targetValue` は `target: { kind, value }` に置き換えてください。
- `get-class-source` / `get-class-members` のトップレベル `artifactId` / `targetKind` / `targetValue` は `target: { type: "artifact", artifactId }` または `target: { type: "resolve", kind, value }` に置き換えてください。
- `resolve-method-mapping-exact` は method 専用になり、`kind` は受け付けなくなりました。
- `validate-mixin` の `source` / `sourcePath` / `sourcePaths` / `mixinConfigPath` / `sourceRoot` は、`input.mode` と `input.source` / `input.path` / `input.paths[]` / `input.configPaths[]`、および `sourceRoots[]` に置き換えてください。workspace 直下から `*.mixins.json` を自動探索したい場合は `input.mode="project"` を使ってください。`summary.errors` の代わりに `summary.processingErrors` を使用してください。
- `search-class-source` から `snippetLines`、`includeDefinition`、`includeOneHop` は削除されました。レスポンスは compact な `hits[]` と `nextCursor?` のみを返し、`symbolKind` は `intent=symbol` のときだけ使えます。
`remap-mod-jar` は Java のインストールが必要で、Fabric / Quilt Mod のみサポートします。

## リソース (Resources)

MCP リソースは URI ベースで Minecraft データへのアクセスを提供します。リソースプロトコルをサポートする任意の MCP クライアントから利用できます。

### 固定リソース (Fixed Resources)

| リソース | URI | 説明 |
| --- | --- | --- |
| `versions-list` | `mc://versions/list` | 利用可能な全 Minecraft バージョンをメタデータ付きで一覧表示 |
| `runtime-metrics` | `mc://metrics` | MCP サーバーのランタイムメトリクスとパフォーマンスカウンター |

### テンプレートリソース (Template Resources)

| リソース | URI テンプレート | 説明 |
| --- | --- | --- |
| `class-source` | `mc://source/{artifactId}/{className}` | 解決済みアーティファクト内のクラスの Java ソースコード |
| `artifact-file` | `mc://artifact/{artifactId}/files/{filePath}` | 解決済みアーティファクト内のファイルの生コンテンツ |
| `find-mapping` | `mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}` | 2つの命名空間間のマッピングを検索 |
| `class-members` | `mc://artifact/{artifactId}/members/{className}` | クラスのコンストラクタ、メソッド、フィールドを一覧表示 |
| `artifact-metadata` | `mc://artifact/{artifactId}` | 解決済みアーティファクトのメタデータ |

`versions-list`、`runtime-metrics`、`find-mapping`、`class-members`、`artifact-metadata` は、成功時に `{ result, meta }`、失敗時に `{ error, meta }` の構造化 JSON エンベロープを返します。
`class-source` と `artifact-file` は成功時は生テキストを保ちつつ、失敗時は構造化 JSON エラーを返します。

## レスポンスエンベロープ (Response Envelope)

すべてのツールは以下のいずれかを返します:

- 成功: `{ result: { ... }, meta: { requestId, tool, durationMs, warnings[] } }`
- 失敗: `{ error: { type, title, detail, status, code, instance, fieldErrors?, hints? }, meta: { requestId, tool, durationMs, warnings[] } }`

JSON リソースも同じ `result/error/meta` パターンに従います。テキストリソースは成功時にプレーンテキストを返します。
同じ JSON エンベロープは MCP の `structuredContent` にもミラーされ、失敗時は `isError=true` も設定されます。

## 使用例 (Examples)

### ソースコード探索 (Source Exploration)

#### Minecraft バージョンからアーティファクトを解決
```json
{
  "tool": "resolve-artifact",
  "arguments": {
    "target": {
      "kind": "version",
      "value": "1.21.10"
    },
    "mapping": "obfuscated",
    "allowDecompile": true,
    "projectPath": "/path/to/mod/workspace"
  }
}
```

#### 行範囲を指定してクラスソースを取得
```json
{
  "tool": "get-class-source",
  "arguments": {
    "target": {
      "type": "artifact",
      "artifactId": "<artifact-id>"
    },
    "className": "net.minecraft.server.Main",
    "startLine": 50,
    "endLine": 180,
    "maxLines": 80
  }
}
```

#### メソッドシンボルで検索
```json
{
  "tool": "search-class-source",
  "arguments": {
    "artifactId": "<artifact-id>",
    "query": "tickServer",
    "intent": "symbol",
    "match": "exact"
  }
}
```

#### クラスメンバー一覧を取得
```json
{
  "tool": "get-class-members",
  "arguments": {
    "target": {
      "type": "artifact",
      "artifactId": "<artifact-id>"
    },
    "className": "net.minecraft.server.Main",
    "mapping": "obfuscated",
    "access": "all",
    "includeInherited": true,
    "maxMembers": 300
  }
}
```

#### プレフィックスフィルタ付きでアーティファクトファイルを一覧表示

特定パッケージ配下のソースファイルを一覧表示してプロジェクト構造を把握します:

```json
{
  "tool": "list-artifact-files",
  "arguments": {
    "artifactId": "<artifact-id>",
    "prefix": "net/minecraft/world/level/",
    "limit": 50
  }
}
```

### バージョン比較＆シンボル追跡 (Version Comparison & Symbol Tracking)

#### `Class.method` のライフサイクルを追跡
```json
{
  "tool": "trace-symbol-lifecycle",
  "arguments": {
    "symbol": "net.minecraft.server.Main.tickServer",
    "descriptor": "()V",
    "fromVersion": "1.20.1",
    "toVersion": "1.21.10",
    "includeTimeline": true
  }
}
```

#### 2つのバージョン間で1つのクラスの差分を取得
```json
{
  "tool": "diff-class-signatures",
  "arguments": {
    "className": "net.minecraft.server.Main",
    "fromVersion": "1.20.1",
    "toVersion": "1.21.10",
    "mapping": "obfuscated",
    "includeFullDiff": false
  }
}
```

#### 2つの Minecraft バージョンを比較

2つのリリース間で何が変わったかの概要を取得します。クラスの追加/削除やレジストリの差分を含みます:

```json
{
  "tool": "compare-versions",
  "arguments": {
    "fromVersion": "1.20.4",
    "toVersion": "1.21.10",
    "category": "all",
    "packageFilter": "net.minecraft.world",
    "maxClassResults": 100
  }
}
```

レジストリ差分は `result.registry` に返ります（`registryDiff` ではありません）。
`packageFilter` を指定した場合、`result.classes.addedCount`、`removedCount`、`unchanged` も同じフィルタ済みパッケージ集合に対する件数になります。

### マッピング＆シンボル (Mapping & Symbols)

#### マッピング候補を検索
```json
{
  "tool": "find-mapping",
  "arguments": {
    "version": "1.21.10",
    "kind": "class",
    "name": "a.b.C",
    "sourceMapping": "obfuscated",
    "targetMapping": "mojang",
    "sourcePriority": "loom-first",
    "maxCandidates": 10,
    "disambiguation": {
      "ownerHint": "net.minecraft"
    }
  }
}
```

#### ディスクリプタ付きでメソッドマッピングを検索
```json
{
  "tool": "find-mapping",
  "arguments": {
    "version": "1.21.10",
    "kind": "method",
    "name": "tick",
    "owner": "a.b.C",
    "descriptor": "(I)V",
    "sourceMapping": "obfuscated",
    "targetMapping": "intermediary"
  }
}
```

#### 厳密なメソッドマッピングの解決
```json
{
  "tool": "resolve-method-mapping-exact",
  "arguments": {
    "version": "1.21.10",
    "name": "f",
    "owner": "a.b.C",
    "descriptor": "(Ljava/lang/String;)V",
    "sourceMapping": "obfuscated",
    "targetMapping": "mojang"
  }
}
```

#### クラス API マッピングマトリクスを表示
```json
{
  "tool": "get-class-api-matrix",
  "arguments": {
    "version": "1.21.10",
    "className": "a.b.C",
    "classNameMapping": "obfuscated",
    "includeKinds": "class,field,method",
    "maxRows": 100
  }
}
```

上位候補だけ欲しい場合は `maxCandidates`、行数を抑えたい場合は `maxRows` を付けてください。

#### ワークスペースのコンパイル時可視シンボルを解決
```json
{
  "tool": "resolve-workspace-symbol",
  "arguments": {
    "projectPath": "/path/to/mod/workspace",
    "version": "1.21.10",
    "kind": "method",
    "name": "f",
    "owner": "a.b.C",
    "descriptor": "(Ljava/lang/String;)V",
    "sourceMapping": "obfuscated"
  }
}
```

#### シンボルの存在確認
```json
{
  "tool": "check-symbol-exists",
  "arguments": {
    "version": "1.21.10",
    "kind": "method",
    "name": "f",
    "owner": "a.b.C",
    "descriptor": "(I)V",
    "sourceMapping": "obfuscated"
  }
}
```

#### 短いクラス名で存在確認（`nameMode=auto`）
```json
{
  "tool": "check-symbol-exists",
  "arguments": {
    "version": "1.21.10",
    "kind": "class",
    "name": "Blocks",
    "nameMode": "auto",
    "sourceMapping": "mojang"
  }
}
```

### NBT ユーティリティ (NBT Utilities)

#### Java NBT base64 を型付き JSON にデコード
```json
{
  "tool": "nbt-to-json",
  "arguments": {
    "nbtBase64": "<base64-nbt>",
    "compression": "auto"
  }
}
```

#### 型付き NBT JSON にパッチを適用
```json
{
  "tool": "nbt-apply-json-patch",
  "arguments": {
    "typedJson": {
      "rootName": "Level",
      "root": { "type": "compound", "value": {} }
    },
    "patch": [
      { "op": "add", "path": "/root/value/name", "value": { "type": "string", "value": "Alex" } }
    ]
  }
}
```

#### 型付き JSON を NBT base64 にエンコード
```json
{
  "tool": "json-to-nbt",
  "arguments": {
    "typedJson": {
      "rootName": "Level",
      "root": { "type": "compound", "value": {} }
    },
    "compression": "gzip"
  }
}
```

### Mod 解析ワークフロー (Mod Analysis Workflow)

一般的な Mod 解析ワークフローは、メタデータ抽出、デコンパイル、ソース読み取り、検索の順に進みます:

#### 1. Mod メタデータを解析

Mod JAR からローダー種別、Mod ID、依存関係、Mixin 設定を抽出します:

```json
{
  "tool": "analyze-mod-jar",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "includeClasses": true
  }
}
```

#### 2. Mod JAR をデコンパイル

全クラスをデコンパイルし、オプションで特定のクラスをインラインで取得します:

```json
{
  "tool": "decompile-mod-jar",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "includeFiles": false,
    "className": "com.example.mymod.MyMod"
  }
}
```

#### 3. デコンパイル済みソースから特定のクラスを読み取り

デコンパイル後は、再デコンパイルなしで任意のクラスを読み取れます:

```json
{
  "tool": "get-mod-class-source",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "className": "com.example.mymod.mixin.PlayerMixin",
    "maxLines": 120
  }
}
```

#### 4. デコンパイル済み Mod ソースを横断検索

デコンパイルされた Mod 全体からメソッド参照、フィールド使用、テキストパターンを検索します:

```json
{
  "tool": "search-mod-source",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "query": "onPlayerTick",
    "searchType": "method",
    "limit": 50
  }
}
```

#### 5. Mod JAR を読みやすい名前にリマップ

Fabric Mod を `intermediary` から `yarn` 名にリマップして可読性を向上させます:

```json
{
  "tool": "remap-mod-jar",
  "arguments": {
    "inputJar": "/path/to/mymod-1.0.0.jar",
    "targetMapping": "yarn",
    "mcVersion": "1.21.10"
  }
}
```

### バリデーション (Validation)

#### Mixin ソースのバリデーション

Mixin クラスソースの正確性を対象 Minecraft バージョンに対してチェックします:

```json
{
  "tool": "validate-mixin",
  "arguments": {
    "input": {
      "mode": "inline",
      "source": "@Mixin(PlayerEntity.class)\npublic abstract class PlayerMixin {\n  @Inject(method = \"tick\", at = @At(\"HEAD\"))\n  private void onTick(CallbackInfo ci) {}\n}"
    },
    "version": "1.21.10",
    "mapping": "yarn",
    "reportMode": "compact",
    "warningMode": "aggregated",
    "includeIssues": false
  }
}
```

#### 複数の Mixin ファイルをバッチバリデーション

同じバリデーション設定で複数の Mixin ソースファイルを一括検証します:

```json
{
  "tool": "validate-mixin",
  "arguments": {
    "input": {
      "mode": "paths",
      "paths": [
        "/path/to/PlayerMixin.java",
        "/path/to/WorldMixin.java"
      ]
    },
    "version": "1.21.10",
    "mapping": "yarn",
    "reportMode": "compact",
    "warningMode": "aggregated",
    "includeIssues": false
  }
}
```

#### プロジェクト内の Mixin を一括バリデーション

workspace root から `*.mixins.json` を自動探索し、参照されている Mixin を一度に検証します:

```json
{
  "tool": "validate-mixin",
  "arguments": {
    "input": {
      "mode": "project",
      "path": "/workspace/modid"
    },
    "version": "1.21.10",
    "projectPath": "/workspace/modid",
    "preferProjectVersion": true,
    "preferProjectMapping": true,
    "reportMode": "compact",
    "warningMode": "aggregated",
    "includeIssues": false
  }
}
```

#### Access Widener のバリデーション

Access Widener ファイルのエントリが対象バージョンに対して有効かチェックします:

```json
{
  "tool": "validate-access-widener",
  "arguments": {
    "content": "accessWidener v2 named\naccessible class net/minecraft/server/Main\naccessible method net/minecraft/server/Main tick ()V",
    "version": "1.21.10",
    "mapping": "yarn"
  }
}
```

### レジストリ＆診断 (Registry & Diagnostics)

#### バージョンの全レジストリを取得

Minecraft バージョンの生成済みレジストリ（ブロック、アイテム、エンティティなど）を一括取得します:

```json
{
  "tool": "get-registry-data",
  "arguments": {
    "version": "1.21.10",
    "includeData": false
  }
}
```

#### 特定のレジストリのみ取得

特定のレジストリタイプのみを取得します:

```json
{
  "tool": "get-registry-data",
  "arguments": {
    "version": "1.21.10",
    "registry": "minecraft:block",
    "maxEntriesPerRegistry": 50
  }
}
```

#### アーティファクトの強制再インデックス

キャッシュやツーリングの変更後にアーティファクトの検索インデックスを再構築します:

```json
{
  "tool": "index-artifact",
  "arguments": {
    "artifactId": "<artifact-id>",
    "force": true
  }
}
```

#### ランタイムメトリクスの検査

サーバーのパフォーマンスカウンター、キャッシュサイズ、レイテンシスナップショットを確認します:

```json
{
  "tool": "get-runtime-metrics",
  "arguments": {}
}
```

## マッピングポリシー (Mapping Policy)

### 名前空間の定義 (Namespace Definitions)

| 名前空間 | 説明 |
| --- | --- |
| `obfuscated` | Mojang 難読化名（例: `a`, `b`, `c`） |
| `mojang` | Mojang 逆難読化名 — `client_mappings.txt` 由来（例: `net.minecraft.server.Main`） |
| `intermediary` | Fabric 安定中間名（例: `net.minecraft.class_1234`, `method_5678`） |
| `yarn` | Fabric コミュニティ人間可読名（例: `net.minecraft.server.MinecraftServer`, `tick`） |

旧来の公開名前空間名 `official` は削除されました。いま `official` を送るとバリデーションエラーになり、`obfuscated` へ更新する必要があります。

### ルックアップルール (Lookup Rules)

`find-mapping` は `obfuscated`、`mojang`、`intermediary`、`yarn` 間の検索をサポートします。

シンボルクエリ入力は `kind` + `name` + オプションの `owner`/`descriptor` を使用します:
- class: `kind=class`, `name=a.b.C`（デフォルト FQCN）。存在確認のみの場合、`nameMode=auto` で短い名前（例: `C`）を許可できます。
- field: `kind=field`, `owner=a.b.C`, `name=fieldName`
- method: `kind=method`, `owner=a.b.C`, `name=methodName`, `descriptor=(I)V`

`mapping: "mojang"` はソースバックのアーティファクトが必要です。デコンパイルパスのみ利用可能な場合、サーバーは `ERR_MAPPING_NOT_APPLIED` を返します。

`resolve-artifact`、`get-class-members`、`trace-symbol-lifecycle`、`diff-class-signatures` は `obfuscated | mojang | intermediary | yarn` を受け付けますが、以下の制約があります:
- `intermediary` / `yarn` は解決可能な Minecraft バージョンコンテキスト（例: `target.kind=version` やバージョン付き coordinate）が必要です。
- 非難読化バージョン（例: 26.1+）では、`intermediary` / `yarn` の要求は警告付きで `obfuscated` にフォールバックします。
- `mojang` はソースバックのアーティファクトが必要です。デコンパイル専用パスは `ERR_MAPPING_NOT_APPLIED` で拒否されます。

`find-class` や `get-class-source` が `obfuscated` アーティファクトに対して `net.minecraft.world.item.Item` のような名前でヒットしない場合、ツールは `obfuscated` が Mojang の難読化ランタイム名であることを警告し、`mapping="mojang"` での再試行または `find-mapping` による変換を勧めます。

メソッドディスクリプタの精度は Tiny ベースのパス（`intermediary`/`yarn`）で最も高くなります。`obfuscated <-> mojang` の場合、Mojang の `client_mappings` には JVM ディスクリプタが含まれないため、ディスクリプタクエリは名前マッチングにフォールバックし警告を出す場合があります。

候補ランキングでは不十分で、ワークフローに厳密な `owner+name+descriptor` の確実性が必要な場合は `resolve-method-mapping-exact` を使用してください。
`find-mapping` の `disambiguation.ownerHint` / `disambiguation.descriptorHint` を使用して、あいまいな候補セットを絞り込めます。
実際の Gradle Loom マッピングからコンパイル時可視名が必要な場合は `resolve-workspace-symbol` を使用してください。

## 環境変数 (Environment Variables)

### コア (Core)

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `MCP_CACHE_DIR` | `~/.cache/minecraft-modding-mcp` | ダウンロードと SQLite のキャッシュルート |
| `MCP_SQLITE_PATH` | `<cacheDir>/source-cache.db` | SQLite データベースパス |
| `MCP_SOURCE_REPOS` | Maven Central + Fabric + Forge + NeoForge | カンマ区切りの Maven リポジトリ URL |
| `MCP_LOCAL_M2` | `~/.m2/repository` | ローカル Maven リポジトリパス |
| `MCP_ENABLE_INDEXED_SEARCH` | `true` | `search-class-source` のインデックスクエリパスを有効化 |
| `MCP_MAPPING_SOURCE_PRIORITY` | `loom-first` | マッピングソース優先度（`loom-first` または `maven-first`） |
| `MCP_VERSION_MANIFEST_URL` | Mojang マニフェスト URL | テスト/プライベートミラー用のマニフェストエンドポイントオーバーライド |

### リミット＆チューニング (Limits & Tuning)

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `MCP_MAX_CONTENT_BYTES` | `1000000` | ファイル読み取り操作の最大バイト数 |
| `MCP_MAX_SEARCH_HITS` | `200` | 検索結果の最大件数 |
| `MCP_MAX_ARTIFACTS` | `200` | キャッシュアーティファクトの最大数 |
| `MCP_MAX_CACHE_BYTES` | `2147483648` | キャッシュ総量の最大バイト数 |
| `MCP_FETCH_TIMEOUT_MS` | `15000` | HTTP リクエストタイムアウト（ミリ秒） |
| `MCP_FETCH_RETRIES` | `2` | HTTP リクエストリトライ回数 |

### デコンパイル＆リマッピング (Decompilation & Remapping)

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `MCP_VINEFLOWER_JAR_PATH` | 未設定 | 外部 Vineflower JAR パス（未設定時は自動ダウンロード） |
| `MCP_TINY_REMAPPER_JAR_PATH` | 未設定 | 外部 tiny-remapper JAR パス（未設定時は自動ダウンロード） |
| `MCP_REMAP_TIMEOUT_MS` | `600000` | リマップ操作タイムアウト（ミリ秒） |
| `MCP_REMAP_MAX_MEMORY_MB` | `4096` | リマップ操作の最大 JVM ヒープ（MB） |

### NBT

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `MCP_MAX_NBT_INPUT_BYTES` | `4194304` | `nbt-to-json` が受け付ける最大デコード済み NBT 入力バイト数 |
| `MCP_MAX_NBT_INFLATED_BYTES` | `16777216` | `nbt-to-json` が受け付ける最大 gzip 展開後バイト数 |
| `MCP_MAX_NBT_RESPONSE_BYTES` | `8388608` | NBT ツールの最大レスポンスペイロードバイト数 |

## アーキテクチャ (Architecture)

| コンポーネント | 技術 |
| --- | --- |
| ランタイム | Node.js 22+（ネイティブ `node:sqlite`） |
| トランスポート | stdio（MCP 標準、改行区切り + `Content-Length` を自動判別） |
| ストレージ | SQLite — アーティファクトメタデータ、ソースインデックス、マッピングキャッシュ |
| デコンパイル | [Vineflower](https://github.com/Vineflower/vineflower)（自動ダウンロード） |
| リマッピング | [tiny-remapper](https://github.com/FabricMC/tiny-remapper)（Java が必要） |
| マッピングソース | Mojang `client_mappings.txt`、Fabric Loom ワークスペース、Maven Tiny v2 |

サーバーは stdio 上で通信する単一の長寿命プロセスとして動作します。アーティファクト（ソース JAR、バイナリ JAR、マッピングファイル）はオンデマンドでダウンロードされ、SQLite にキャッシュされます。検索インデックスは最初のクエリ時に遅延構築され、以降の呼び出しのために永続化されます。

## 開発ノート (Development Notes)

- `SourceService` がアーティファクトの解決、取り込み、ソースクエリの正規実装です。
- `version` 解決は Mojang クライアント JAR をキャッシュにダウンロードし、`jar` や `coordinate` ターゲットと同じ取り込みフローにルーティングします。
- ツールレスポンスは常に `{ result?, error?, meta }` でラップされます。
- `meta` には `requestId`、`tool`、`durationMs`、`warnings[]` が含まれます。

## ライセンス (License)

[MIT](../LICENSE)
