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

以下の 6 つのトップレベルワークフローツールは、一般的な作業をカバーし、要約優先の結果を返します。エージェントや MCP クライアントが最初に使う既定の入口として最適です。

すべて `result.summary` を先に返し、次の一手が明確な場合は `summary.nextActions` も含めます。個別の選び分けは表と下の例から始め、細かな契約は英語の `tool-reference.md` を参照してください。

| ツール | 主な用途 |
| --- | --- |
| `inspect-minecraft` | バージョン、アーティファクト、クラス、ファイル、ソース検索 |
| `analyze-symbol` | シンボル存在確認、マッピング変換、ライフサイクル追跡、ワークスペースシンボル解決 |
| `compare-minecraft` | バージョン差分、クラス差分、レジストリ差分、移行向け概要 |
| `analyze-mod` | Mod メタデータ、デコンパイル / 検索フロー、クラスソース、安全なリマップのプレビュー / 実行 |
| `validate-project` | ワークスペース要約と、Mixin / Access Widener の直接検証 |
| `manage-cache` | キャッシュ一覧、検証、プレビュー / 実行によるクリーンアップワークフロー |

### ワークフローノート

ここでは高頻度の注意点だけを扱います。完全な落とし穴一覧、詳細な契約、移行メモ、環境変数は [tool-reference.md](tool-reference.md) を参照してください。

- `search-class-source` は既定で `queryMode="auto"` を使い、`foo.bar`、`foo_bar`、`foo$bar` のような区切り文字付きクエリもインデックス経路のまま扱います。明示的な全文部分文字列スキャンが必要な場合は `queryMode="literal"` を使ってください。
- アーティファクトが不明な場合は、`inspect-minecraft` で `subject.kind="workspace"` を使う方が安全です。アーティファクト文脈だけが不足しているときは、再試行しやすい `suggestedCall` が元の task を維持したまま返ります。
- `trace-symbol-lifecycle` の `symbol` には `Class.method` を指定します。厳密な overload 指定は別フィールドの `descriptor` を使ってください。
- ワークスペースのソースカバレッジが部分的な場合でも、バニラクラスを確認できます。`inspect-minecraft task="list-files"` は、その場合に部分的な結果とフォローアップガイダンスを返します。
- `analyze-mod` と `validate-project` は、構造化された `subject` と正規の `include` を要求します。古い string-subject / domain-include payload には `ERR_INVALID_INPUT` と、再試行しやすい `suggestedCall` を返します。

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

この日本語版はオンボーディング向けの概要です。詳細な例と完全なリファレンスは現時点では英語ドキュメントを参照してください。

- [詳細なリクエスト例（英語）](examples.md)
- [ツール / 設定リファレンス（英語）](tool-reference.md)
- [英語版 README](../README.md)

## ツール一覧

明確に狙っている専用操作がない限り、まずは以下のトップレベルワークフローツールから始めてください。より低レベルなツールも、絞り込んだ追加調査や自動化向けに引き続き利用できます。

### トップレベルワークフローツール

<!-- BEGIN GENERATED TOOL TABLE: v3-entry-tools -->
| ツール | 役割 |
| --- | --- |
| `inspect-minecraft` | バージョン、アーティファクト、クラス、ファイル、ソース本文、ワークスペース文脈の調査フローをまとめて扱う |
| `analyze-symbol` | シンボル存在確認、名前空間変換、ライフサイクル追跡、ワークスペースシンボル解決、API 概要をまとめて扱う |
| `compare-minecraft` | バージョン差分、クラス差分、レジストリ差分、移行向け概要を比較する |
| `analyze-mod` | Mod メタデータの要約、Mod コードのデコンパイル / 検索、クラスソース確認、リマップのプレビュー / 実行を扱う |
| `validate-project` | ワークスペース要約と、Mixin / Access Widener の直接検証を行う |
| `manage-cache` | キャッシュの一覧、検証、クリーンアップ / 再構築のプレビュー / 実行を行う |
<!-- END GENERATED TOOL TABLE: v3-entry-tools -->

### ソース探索

Minecraft バージョンの参照、ソースアーティファクトの解決、デコンパイル済みソースコードの読み取り / 検索を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: source-exploration -->
| ツール | 役割 |
| --- | --- |
| `list-versions` | Mojang メタデータとローカルキャッシュから利用可能な Minecraft バージョンを一覧表示する |
| `resolve-artifact` | バージョン、JAR パス、Maven 座標からソースアーティファクトを解決する |
| `find-class` | アーティファクト内で簡易名または完全修飾クラス名を探す |
| `get-class-source` | アーティファクトからクラスソースを読み取り、必要に応じて背後のアーティファクトを解決する |
| `get-class-members` | バイトコードからコンストラクタ、フィールド、メソッドを一覧化する |
| `search-class-source` | インデックス化されたクラスソースをシンボル、テキスト、パスで検索する |
| `get-artifact-file` | バイト上限付きでソースファイル全体を読み取る |
| `list-artifact-files` | インデックス化されたソースファイルパスをカーソルページネーション付きで一覧表示する |
| `index-artifact` | 既存アーティファクトのインデックスメタデータを再構築する |
<!-- END GENERATED TOOL TABLE: source-exploration -->

### バージョン比較とシンボル追跡

Minecraft バージョン間でのクラス / レジストリ変更比較と、時系列でのシンボル存在追跡を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: version-comparison-symbol-tracking -->
| ツール | 役割 |
| --- | --- |
| `trace-symbol-lifecycle` | `Class.method` が Minecraft のどのバージョンで存在するかを追跡する |
| `diff-class-signatures` | 2 つのバージョン間で 1 つのクラスを比較し、メンバー差分を返す |
| `compare-versions` | 2 つのバージョン間でクラスとレジストリの変更を比較する |
<!-- END GENERATED TOOL TABLE: version-comparison-symbol-tracking -->

### マッピングとシンボル

名前空間間でのシンボル名変換と、シンボル存在確認を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: mapping-symbols -->
| ツール | 役割 |
| --- | --- |
| `find-mapping` | クラス、フィールド、メソッドのシンボルに対するマッピング候補を調べる |
| `resolve-method-mapping-exact` | owner、name、descriptor の厳密一致で 1 つのメソッドマッピングを解決する |
| `get-class-api-matrix` | 1 つのクラス API を `obfuscated`、`mojang`、`intermediary`、`yarn` で見比べる |
| `resolve-workspace-symbol` | Gradle ワークスペースからコンパイル時に見えるシンボル名を解決する |
| `check-symbol-exists` | 名前空間内でクラス、フィールド、メソッドが存在するかを確認する |
<!-- END GENERATED TOOL TABLE: mapping-symbols -->

### NBT ユーティリティ

型付き JSON 表現を使って、Java Edition の NBT バイナリデータをデコード、パッチ、エンコードするツール群です。

<!-- BEGIN GENERATED TOOL TABLE: nbt-utilities -->
| ツール | 役割 |
| --- | --- |
| `nbt-to-json` | Java Edition の NBT バイナリを型付き JSON にデコードする |
| `nbt-apply-json-patch` | 型付き NBT JSON に RFC 6902 パッチを適用する |
| `json-to-nbt` | 型付き JSON を Java Edition の NBT バイナリへ再エンコードする |
<!-- END GENERATED TOOL TABLE: nbt-utilities -->

### Mod 解析

Mod JAR からのメタデータ抽出、Mod ソースのデコンパイル、Mod コード検索、Mod 名前空間のリマッピングを行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: mod-analysis -->
| ツール | 役割 |
| --- | --- |
| `analyze-mod-jar` | JAR から Mod メタデータ、依存関係、エントリポイント、Mixin 設定情報を抽出する |
| `decompile-mod-jar` | Mod JAR をデコンパイルし、必要に応じて 1 つのクラスソースを返す |
| `get-mod-class-source` | デコンパイル済み Mod キャッシュから 1 つのクラスソースを読み取る |
| `search-mod-source` | デコンパイル済み Mod ソースを class、method、field、content で検索する |
| `remap-mod-jar` | Fabric または Quilt の Mod JAR を `yarn` または `mojang` 名へリマップする |
<!-- END GENERATED TOOL TABLE: mod-analysis -->

### バリデーション

Mixin ソースや Access Widener ファイルを、対象 Minecraft バージョンに対して検証するツール群です。

<!-- BEGIN GENERATED TOOL TABLE: validation -->
| ツール | 役割 |
| --- | --- |
| `validate-mixin` | 対象 Minecraft バージョンに対して Mixin ソースを検証する |
| `validate-access-widener` | 対象 Minecraft バージョンに対して Access Widener の内容を検証する |
<!-- END GENERATED TOOL TABLE: validation -->

### レジストリと診断

生成済みレジストリデータの取得と、サーバーのランタイム状態の確認を行うツール群です。

<!-- BEGIN GENERATED TOOL TABLE: registry-diagnostics -->
| ツール | 役割 |
| --- | --- |
| `get-registry-data` | 生成済みレジストリスナップショットを読み取り、必要に応じてエントリデータも含める |
| `get-runtime-metrics` | ランタイムメトリクスとレイテンシスナップショットを確認する |
<!-- END GENERATED TOOL TABLE: registry-diagnostics -->

詳細なパラメータ制約、移行メモ、リソースの挙動、環境変数の完全な一覧は [tool-reference.md](tool-reference.md) を参照してください。

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
