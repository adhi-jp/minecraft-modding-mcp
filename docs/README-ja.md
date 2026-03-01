# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

> [English version / 英語版](../README.md)

---

`@adhisang/minecraft-modding-mcp` は、AI アシスタントに Minecraft のソースコード・マッピング・Mod ツーリングへの深いアクセスを提供する [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) サーバーです。

デコンパイルされた Minecraft ソースの探索、4つの命名空間（`official`、`mojang`、`intermediary`、`yarn`）間でのシンボル名変換、Fabric/Forge/NeoForge Mod JAR の解析・デコンパイル、Mixin と Access Widener ファイルのバリデーション、NBT データの読み書きとパッチ、生成済みレジストリスナップショットのクエリなど — Claude Desktop、VS Code、その他の MCP 対応クライアント向けに設計された構造化ツール＆リソースインターフェースを通じて、これらすべての操作を行えます。

**28 ツール** | **7 リソース** | **4 名前空間マッピング** | **SQLite キャッシュ**

## 特徴 (Features)

- **ソースコード探索** — デコンパイルされた Minecraft ソースを行レベルの精度で閲覧・検索し、カーソルページネーション付きでファイル一覧を取得
- **マルチマッピング変換** — クラス・フィールド・メソッド名を `official`、`mojang`、`intermediary`、`yarn` 名前空間間で変換
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

GitHub Actions のアップロードワークフロー: `.github/workflows/codecov.yml`（`v*` タグ時および手動実行でトリガー）。

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
| `resolve-artifact` | `version` / `jar` / `coordinate` からソースアーティファクトを解決 | `targetKind`, `targetValue`, `mapping?`, `sourcePriority?`, `allowDecompile?` | `artifactId`, `origin`, `mappingApplied`, `qualityFlags[]`, `adjacentSourceCandidates?`, `warnings[]` |
| `get-class-source` | `artifactId` またはオンデマンド解決でクラスソースを取得（行フィルタ付き） | `className`, `artifactId?`, `targetKind?`, `targetValue?`, `startLine?`, `endLine?`, `maxLines?` | `sourceText`, `returnedRange`, `truncated`, `artifactId`, マッピング/来歴メタデータ |
| `get-class-members` | バイトコードからクラスのフィールド/メソッド/コンストラクタを取得 | `className`, `artifactId?`, `targetKind?`, `targetValue?`, `mapping?`, `access?`, `includeInherited?`, `maxMembers?` | `members.{constructors,fields,methods}`, `counts`, `truncated`, `context`, `warnings[]` |
| `search-class-source` | インデックス化されたクラスソースからシンボル/テキスト/パスを検索 | `artifactId`, `query`, `intent?`, `match?`, `packagePrefix?`, `fileGlob?`, `symbolKind?`, `snippetLines?`, `includeDefinition?`, `includeOneHop?`, `limit?`, `cursor?` | `hits[]`, `relations?`, `nextCursor?`, `totalApprox`, `mappingApplied` |
| `get-artifact-file` | バイトガード付きでソースファイル全体を読み取り | `artifactId`, `filePath`, `maxBytes?` | `content`, `contentBytes`, `truncated`, `mappingApplied` |
| `list-artifact-files` | カーソルページネーション付きでインデックス化されたソースファイルパスを一覧表示 | `artifactId`, `prefix?`, `limit?`, `cursor?` | `items[]`, `nextCursor?`, `mappingApplied` |
| `index-artifact` | 既存アーティファクトのインデックスメタデータを再構築 | `artifactId`, `force?` | `reindexed`, `reason`, `counts`, `indexedAt`, `durationMs` |

### バージョン比較＆シンボル追跡 (Version Comparison & Symbol Tracking)

Minecraft バージョン間でのクラス/レジストリの変更比較と、シンボルの存在を時系列で追跡するツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `trace-symbol-lifecycle` | `Class.method` が Minecraft バージョン間でいつ存在するかを追跡 | `symbol`, `descriptor?`, `fromVersion?`, `toVersion?`, `mapping?`, `sourcePriority?`, `maxVersions?`, `includeTimeline?` | `presence.firstSeen`, `presence.lastSeen`, `presence.missingBetween[]`, `presence.existsNow`, `timeline?`, `warnings[]` |
| `diff-class-signatures` | 2つのバージョン間で1つのクラスを比較しメンバーの差分を返す | `className`, `fromVersion`, `toVersion`, `mapping?`, `sourcePriority?` | `classChange`, `constructors/methods/fields.{added,removed,modified}`, `summary`, `warnings[]` |
| `compare-versions` | 2つのバージョン間のクラス/レジストリの変更を比較 | `fromVersion`, `toVersion`, `category?`, `packageFilter?`, `maxClassResults?` | `classesDiff`, `registryDiff`, `summary`, `warnings[]` |

### マッピング＆シンボル (Mapping & Symbols)

名前空間間でのシンボル名変換とシンボルの存在確認を行うツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `find-mapping` | クラス/フィールド/メソッドのシンボルに対するマッピング候補を名前空間間で検索 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `targetMapping`, `sourcePriority?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `provenance?`, `meta.warnings[]` |
| `resolve-method-mapping-exact` | owner+name+descriptor の厳密マッチングで1つのメソッドマッピングを解決 | `version`, `kind` (`method`), `name`, `owner`, `descriptor`, `sourceMapping`, `targetMapping`, `sourcePriority?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `provenance?`, `meta.warnings[]` |
| `get-class-api-matrix` | 1つのクラス API をマッピングマトリクスとして表示（`official/mojang/intermediary/yarn`） | `version`, `className`, `classNameMapping`, `includeKinds?`, `sourcePriority?` | `classIdentity`, `rows[]`, `meta.warnings[]` |
| `resolve-workspace-symbol` | Gradle ワークスペース（`build.gradle/.kts`）のコンパイル時可視シンボル名を解決 | `projectPath`, `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `workspaceDetection`, `meta.warnings[]` |
| `check-symbol-exists` | クラス/フィールド/メソッドの厳密な存在確認 | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `meta.warnings[]` |

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
| `analyze-mod-jar` | Mod JAR から Mod メタデータ/依存関係/エントリポイントを抽出 | `jarPath`, `includeClasses?` | `modId`, `loader`, `dependencies`, `entrypoints`, `mixinConfigs`, クラス統計 |
| `decompile-mod-jar` | Mod JAR をデコンパイルし、オプションで1つのクラスソースを返す | `jarPath`, `className?` | `outputDir`, `fileCount`, `files?`, `source?`, `warnings[]` |
| `get-mod-class-source` | デコンパイル済みキャッシュから1つのクラスソースを読み取り | `jarPath`, `className` | `className`, `content`, `totalLines`, `warnings[]` |
| `search-mod-source` | デコンパイル済み Mod ソースをクラス/メソッド/フィールド/コンテンツで検索 | `jarPath`, `query`, `searchType?`, `limit?` | `hits[]`, `totalHits`, `truncated`, `warnings[]` |
| `remap-mod-jar` | Fabric Mod JAR を intermediary から yarn/mojang 名にリマップ | `inputJar`, `targetMapping`, `mcVersion?`, `outputJar?` | `outputJar`, `mcVersion`, `fromMapping`, `targetMapping`, `resolvedTargetNamespace`, `warnings[]` |

### バリデーション (Validation)

Mixin ソースと Access Widener ファイルを対象 Minecraft バージョンに対してバリデーションするツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `validate-mixin` | Mixin ソースを対象 Minecraft バージョンに対してパース/バリデーション | `source`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |
| `validate-access-widener` | Access Widener コンテンツを対象バージョンに対してパース/バリデーション | `content`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |

### レジストリ＆診断 (Registry & Diagnostics)

生成済みレジストリデータのクエリとサーバーランタイム状態の検査を行うツール群です。

| ツール | 機能 | 主な入力 | 主な出力 |
| --- | --- | --- | --- |
| `get-registry-data` | 生成済みレジストリスナップショット（blocks/items/entities 等）を取得 | `version`, `registry?` | `registries`（全部または選択）, `warnings[]` |
| `get-runtime-metrics` | ランタイムカウンターとレイテンシスナップショットを検査 | なし | `result.*` ランタイムメトリクス, `meta` エンベロープ |

### ツール制約事項 (Tool Constraints)

`get-class-source` は `artifactId` または `targetKind`+`targetValue` のいずれかが必要です。両方を指定するとエラーになります。
`get-class-members` は `artifactId` または `targetKind`+`targetValue` のいずれかが必要で、`.class` エントリを読み取るためにバイナリ JAR（`binaryJarPath`）が必要です。
`search-class-source` はデフォルトで `limit: 20` を使用します。`snippetLines` のデフォルトは `8` で `1..80` にクランプされます。`includeDefinition` と `includeOneHop` のデフォルトは `false` です。
`search-class-source` の `match=regex` は `query.length <= 200` と厳格な結果上限 `100` を適用します。
`resolve-artifact` の `targetKind=jar` は、正確な隣接 `"<jar-basename>-sources.jar"` のみを自動採用します。その他の隣接 `*-sources.jar` ファイルは `adjacentSourceCandidates` として情報のみ返され、自動選択されません。
Mod ツールの `jarPath` 入力は、存在確認・キャッシュキー・処理の前に正規のローカル `.jar` ファイルパスに正規化されます。
`search-mod-source` は `query.length <= 200` と `limit <= 200` を適用します。
`remap-mod-jar` は Java のインストールが必要で、Fabric/Quilt Mod のみサポートします。

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

## レスポンスエンベロープ (Response Envelope)

すべてのツールは以下のいずれかを返します:

- 成功: `{ result: { ... }, meta: { requestId, tool, durationMs, warnings[] } }`
- 失敗: `{ error: { type, title, detail, status, code, instance, fieldErrors?, hints? }, meta: { requestId, tool, durationMs, warnings[] } }`

## 使用例 (Examples)

### ソースコード探索 (Source Exploration)

#### Minecraft バージョンからアーティファクトを解決
```json
{
  "tool": "resolve-artifact",
  "arguments": {
    "targetKind": "version",
    "targetValue": "1.21.10",
    "mapping": "official",
    "allowDecompile": true
  }
}
```

#### 行範囲を指定してクラスソースを取得
```json
{
  "tool": "get-class-source",
  "arguments": {
    "artifactId": "<artifact-id>",
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
    "match": "exact",
    "includeOneHop": true
  }
}
```

#### クラスメンバー一覧を取得
```json
{
  "tool": "get-class-members",
  "arguments": {
    "artifactId": "<artifact-id>",
    "className": "net.minecraft.server.Main",
    "mapping": "official",
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
    "mapping": "official"
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

### マッピング＆シンボル (Mapping & Symbols)

#### マッピング候補を検索
```json
{
  "tool": "find-mapping",
  "arguments": {
    "version": "1.21.10",
    "kind": "class",
    "name": "a.b.C",
    "sourceMapping": "official",
    "targetMapping": "mojang",
    "sourcePriority": "loom-first"
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
    "sourceMapping": "official",
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
    "kind": "method",
    "name": "f",
    "owner": "a.b.C",
    "descriptor": "(Ljava/lang/String;)V",
    "sourceMapping": "official",
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
    "classNameMapping": "official",
    "includeKinds": "class,field,method"
  }
}
```

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
    "sourceMapping": "official"
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
    "sourceMapping": "official"
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
    "className": "com.example.mymod.mixin.PlayerMixin"
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
    "source": "@Mixin(PlayerEntity.class)\npublic abstract class PlayerMixin {\n  @Inject(method = \"tick\", at = @At(\"HEAD\"))\n  private void onTick(CallbackInfo ci) {}\n}",
    "version": "1.21.10",
    "mapping": "yarn"
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
    "version": "1.21.10"
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
    "registry": "minecraft:block"
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
| `official` | Mojang 難読化名（例: `a`, `b`, `c`） |
| `mojang` | Mojang 逆難読化名 — `client_mappings.txt` 由来（例: `net.minecraft.server.Main`） |
| `intermediary` | Fabric 安定中間名（例: `net.minecraft.class_1234`, `method_5678`） |
| `yarn` | Fabric コミュニティ人間可読名（例: `net.minecraft.server.MinecraftServer`, `tick`） |

### ルックアップルール (Lookup Rules)

`find-mapping` は `official`、`mojang`、`intermediary`、`yarn` 間の検索をサポートします。

シンボルクエリ入力は `kind` + `name` + オプションの `owner`/`descriptor` を使用します:
- class: `kind=class`, `name=a.b.C`（FQCN のみ）
- field: `kind=field`, `owner=a.b.C`, `name=fieldName`
- method: `kind=method`, `owner=a.b.C`, `name=methodName`, `descriptor=(I)V`

`mapping: "mojang"` はソースバックのアーティファクトが必要です。デコンパイルパスのみ利用可能な場合、サーバーは `ERR_MAPPING_NOT_APPLIED` を返します。

`resolve-artifact`、`get-class-members`、`trace-symbol-lifecycle`、`diff-class-signatures` は `official | mojang | intermediary | yarn` を受け付けますが、以下の制約があります:
- `intermediary` / `yarn` は解決可能な Minecraft バージョンコンテキスト（例: `targetKind=version` やバージョン付き coordinate）が必要です。
- 非難読化バージョン（例: 26.1+）では、`intermediary` / `yarn` の要求は警告付きで `official` にフォールバックします。
- `mojang` はソースバックのアーティファクトが必要です。デコンパイル専用パスは `ERR_MAPPING_NOT_APPLIED` で拒否されます。

メソッドディスクリプタの精度は Tiny ベースのパス（`intermediary`/`yarn`）で最も高くなります。`official <-> mojang` の場合、Mojang の `client_mappings` には JVM ディスクリプタが含まれないため、ディスクリプタクエリは名前マッチングにフォールバックし警告を出す場合があります。

候補ランキングでは不十分で、ワークフローに厳密な `owner+name+descriptor` の確実性が必要な場合は `resolve-method-mapping-exact` を使用してください。
実際の Gradle Loom マッピングからコンパイル時可視名が必要な場合は `resolve-workspace-symbol` を使用してください。

## 環境変数 (Environment Variables)

### コア (Core)

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `MCP_CACHE_DIR` | `.cache/minecraft-modding-mcp` | ダウンロードと SQLite のキャッシュルート |
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
| トランスポート | stdio（MCP 標準） |
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
