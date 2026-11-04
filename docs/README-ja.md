# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node.js >=22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

**[English](../README.md)** | 日本語

> **注記**: このプロジェクトはすべてバイブコーディング（AI 支援開発、正式仕様書なし）で作成されています。

---

`@adhisang/minecraft-modding-mcp` は、AI 支援の Minecraft Modding ワークフロー向け MCP サーバーです。エージェントが Minecraft ソースを調査し、マッピングを解決し、バージョン差分を比較し、Mod JAR を解析し、Mixin / Access Widener / Access Transformer ファイルを検証し、NBT やレジストリデータを扱う場面で使えます。

stdio で動作し、Claude Desktop、Claude Code、VS Code、Codex CLI、Gemini CLI などの MCP 対応クライアントから利用できます。

**29 カタログツール** + **41 非推奨の 8.x ツール** | **9 リソース** | **4 マッピング名前空間** | **SQLite ベースのキャッシュ**

## 特長

- **ソース探索**: デコンパイル済み Minecraft ソースを、行単位の文脈付きで閲覧・一覧・検索
- **マッピング対応のシンボル操作**: クラス、フィールド、メソッド名を `obfuscated`、`mojang`、`intermediary`、`yarn` の間で変換
- **バージョン比較**: Minecraft バージョン間のクラスシグネチャ、レジストリ項目、移行向け概要を比較
- **Mod JAR 解析**: Fabric、Forge、NeoForge のメタデータ、エントリポイント、Mixin 設定、依存関係、ソース、リマップのプレビューを確認
- **プロジェクト検証**: Mixin ソース、`.accesswidener` ファイル、Forge / NeoForge の Access Transformer ファイルを対象バージョンに対して検証
- **NBT、レジストリ、キャッシュ、診断**: NBT ペイロードのパッチ適用、生成済みレジストリデータの確認、キャッシュや実行時状態の管理
- **MCP リソース**: バージョン、クラスソース、アーティファクトメタデータ、マッピングを URI ベースのリソースとして公開

## クイックスタート

### パッケージ利用者向け

要件:

- Node.js 22.13.0+
- デコンパイル / リマップ処理には、`PATH` 上の Java 17+ が必要です（Loom のソース jar がないバージョンの Minecraft ソースの読み取り、Mod JAR のデコンパイル、`mod-remap`（8.x では `remap-mod-jar`））。既定の Vineflower は Java 17 を必要としますが、サーバーは `java` が起動できるかだけを確認し、バージョンは確認しません。`registry-read` と `version-compare` のレジストリ比較（8.x ツールでは `get-registry-data` と、`compare-versions` / `compare-minecraft` のレジストリ差分）は Minecraft サーバーのデータジェネレーターを実行するため、その Minecraft リリースが必要とする Java バージョン（1.21.x では Java 21）が必要です。

ローカルでサーバーを起動:

```bash
npx -y @adhisang/minecraft-modding-mcp
```

各 MCP クライアント設定でも同じコマンドを使います。環境によって自動 JAR ダウンロードがブロックされる場合は、その設定内で `MCP_VINEFLOWER_JAR_PATH` と `MCP_TINY_REMAPPER_JAR_PATH` を指定してください。

### クライアント設定

CLI クライアントでは、パッケージ起動コマンドをそのまま登録できます。

Claude Code:

```bash
claude mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
```

OpenAI Codex CLI:

```bash
codex mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
```

登録後に `claude mcp list` または `codex mcp list` を実行し、サーバーが利用可能になっていることを確認します。

stdio トランスポートは、改行区切り形式と `Content-Length` フレーミングの両方を自動判別します。そのため、Codex と標準的な MCP クライアントで同じサーバー起動コマンドを利用できます。

サーバーは MCP プロトコルリビジョン `2026-07-28`(`server/discover` とリクエスト単位 `_meta` によるステートレス動作)と、従来の `initialize` ベースのレガシープロトコル(`2025-11-25`〜`2024-10-07`)の両方を同一バイナリでサポートします。1 プロセスはクライアントの最初のシグナルで選択された era を提供します。どちらの era でも、`initialize` と `server/discover` の結果に AI エージェント向けの短い入門文を MCP の `instructions` として含めます(カタログツール、`target`、`mapping`、`{ result, meta }` 形式の応答の説明と、8.x ツールを提供している間はそれらが非推奨エイリアスであること。詳細は [docs/tool-reference.md → Tool catalog](tool-reference.md#tool-catalog))。ワイヤレベルの詳細は [docs/tool-reference.md → MCP Protocol Support](tool-reference.md#mcp-protocol-support) を参照してください。

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

ビルドが既定以外の Gradle User Home を使っている場合は、`artifact-resolve` に `gradleUserHome` を指定し、返された `artifactId` を再利用してください（非推奨の 8.x ツールは、キャッシュを使う呼び出しごとに受け取ります）。呼び出し単位の Gradle User Home として扱われ、MCP プロセスの Gradle User Home の代わりに `<gradleUserHome>/loom-cache` と `<gradleUserHome>/caches/fabric-loom` を検索します。`projectPath` 配下のプロジェクトローカルなキャッシュは引き続き検索対象です。

## まずここから

まずカタログツールを使ってください。各ツールは 1 種類の問いに答え、すべてが同じリクエスト語彙（`target`、`mapping`、`detail`）を共有します。応答は `{ result, meta }` または `{ error, meta }` で、次の一手は `meta.nextActions`、警告は `meta.warnings` に入ります。表でツールを選び、下の例と英語リファレンスで正確なペイロードを確認してください。

| ツール | 主な用途 |
| --- | --- |
| `artifact-resolve` | バージョン、JAR、座標、ワークスペース、依存関係を一度解決し、その `artifactId` を再利用する |
| `source-read` | Minecraft・依存関係・Mod の JAR から最大 50 クラスのソースを読む |
| `member-list` | バイトコードからコンストラクタ、フィールド、メソッドを一覧する |
| `source-search` | アーティファクトのソースから宣言、テキスト、ファイルパスを検索する |
| `symbol-check` | クラス、フィールド、メソッドが Minecraft バージョンに存在するかを確認する |
| `symbol-map` | クラス、フィールド、メソッドの名前を別の名前空間に変換する |
| `version-compare` | 2 つのバージョン間で変わったクラス、レジストリエントリ、ライブラリを調べる |
| `mod-inspect` | Mod の JAR のローダー、メタデータ、エントリポイント、Mixin 設定を読む |
| `project-validate` | ワークスペースの Mixin 設定と Access Widener をファイルごとに検証する |
| `cache-manage` | キャッシュの一覧、検証、プレビュー / 実行によるクリーンアップ |

### ワークフローノート

ここでは、オンボーディング中によく迷う判断だけを扱います。完全な注意点一覧、正確な契約、移行メモ、環境変数は [tool-reference.md](tool-reference.md) を参照してください。

- `artifact-resolve` で一度解決し、`result.artifact.artifactId` を `target: { kind: "artifact", artifactId }` としてほかのツールに渡してください。解決オプション（`sourcePriority`、`gradleUserHome`、`preferProjectVersion`、`strictVersion`）を受け取るのは `artifact-resolve` だけです。`allowDecompile` は `source-read` と `source-export` も受け取ります（既定値 `true`）。解決時やフォールバック時のソースのデコンパイルを拒否するには、`artifactId` を再利用するときも呼び出しごとに `false` を指定してください。オプションは呼び出し単位で、アーティファクトには保存されません。
- シンボルのツール、`class-diff`、`access-validate`、`mixin-verify-target` では、名前がどの名前空間で書かれているかを示す `mapping` が必須です。名前空間が推測されることはありません。
- `template: true` のない `meta.nextActions` の項目はそのまま送れます。`template: true` の項目は、`<placeholder>` の値を埋めてから送ってください。
- アーティファクトのダウンロードは 1 件あたり 512 MiB（`MCP_MAX_DOWNLOAD_BYTES`）、ネストした JAR のエントリは展開後 1 件あたり 64 MiB（`MCP_MAX_NESTED_JAR_ENTRY_BYTES`）が上限です。上限を超えるダウンロードは失敗し、すべてのリポジトリで上限を超えた場合は `ERR_REPO_FETCH_FAILED` が返り、その `context.repoFailureCode` は `ERR_LIMIT_EXCEEDED` です。上限を超えるネストした JAR はエラーも警告もなくスキップされ、ほかのネストした JAR は引き続き解決されます。`validate-project`、`project-validate`、`mixin-validate` にはキュー待ちを含めて 120 秒の期限があり（`MCP_VALIDATE_PROJECT_TIMEOUT_MS` で 10000〜600000 ミリ秒の範囲で変更可能）、超えると `ERR_TOOL_TIMEOUT` で失敗します。これらの呼び出しは 1 件ずつ単独で実行され、後続の呼び出しは完了を待ちます。詳細は [tool-reference.md](tool-reference.md) を参照してください。

### あるバージョンの Minecraft ソースを読む

```json
{
  "tool": "source-read",
  "arguments": {
    "target": { "kind": "version", "version": "1.21.10" },
    "classes": ["net.minecraft.server.Main"],
    "mode": "snippet"
  }
}
```

### シンボルを別の名前空間に変換する

```json
{
  "tool": "symbol-map",
  "arguments": {
    "target": { "kind": "version", "version": "1.21.10" },
    "mapping": "mojang",
    "toMapping": "intermediary",
    "symbols": [
      { "kind": "method", "className": "net.minecraft.server.MinecraftServer", "memberName": "tickServer" }
    ],
    "signatureMode": "name-only"
  }
}
```

### Mod JAR を要約する

```json
{
  "tool": "mod-inspect",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar"
  }
}
```

### ワークスペースを検証する

```json
{
  "tool": "project-validate",
  "arguments": {
    "projectPath": "/workspace/modid",
    "discover": ["mixins", "access-wideners", "access-transformers"]
  }
}
```

`project-validate` は既定では Mixin 設定と Access Widener を検出します。Access Transformer も検証したい場合は `discover` に `"access-transformers"` を追加してください。

## ドキュメント

この日本語版はオンボーディング向けの概要です。詳細な例と完全なリファレンスは現時点では英語ドキュメントを参照してください。

- [詳細なリクエスト例（英語）](examples.md)
- [ツール / 設定リファレンス（英語）](tool-reference.md)。どのツールを呼ぶべきか迷ったときは、まず [Tool catalog](tool-reference.md#tool-catalog) を確認してください。8.x ツールごとの置き換え先は [Migration from 8.x](tool-reference.md#migration-from-8x) にあります。
- [英語版 README](../README.md)

## ツール一覧

### カタログツール

カタログは、8.x ツールより前に一覧されるフラットな専用ツール群です。各カタログツールは 1 種類の問いに答え、すべてが同じリクエスト語彙を共有します。`target` オブジェクトで参照先（`artifact`、`version`、`jar`、`coordinate`、`workspace`、`dependency`）を指定し、`mapping` で名前空間を、`detail` で応答の詳しさを指定します。応答は答えを `result` に入れ、警告・次の一手・ページング・切り詰めを `meta` に入れます。`target` をアーティファクトに解決するツールは `result.artifact` を返し、その `artifactId` は `target: { kind: "artifact", artifactId }` として再利用できます。未知のキーや置き場所を誤ったキーは無視されず、`ERR_INVALID_INPUT` で失敗します。ソースとメンバーのツールは 1 回の呼び出しで 1〜50 個の `classes` を受け取り、クラスごとに `result.items` の 1 項目として報告します。これらは読み取り専用で、`source-export` だけが `outputDir` 配下に `.java` ファイルを書き込みます。`source-search` は 1 つのアーティファクトのインデックス化されたソースから、名前による宣言・ファイル内のテキスト・ファイルパスをページ単位で検索します。`mapping` はクエリの名前空間を表すため、Mojang のクラス名で難読化アーティファクト内のクラスを見つけられます。ヒットがなく、クエリを変換できなかった検索は `status: "unavailable"` になります。シンボルのツール（`symbol-check`、`symbol-map`、`class-mappings`、`symbol-trace`）は Minecraft バージョンのマッピングを読み、名前がどの名前空間で書かれているかを示す `mapping` が必須です。名前空間が推測されることはないため、Mojang 名が難読化名として検索されて「存在しない」と報告されることはありません。`symbol-check` と `symbol-map` は 1 回の呼び出しで 1〜50 個の `symbols` を受け取ります。比較のツールはバージョン間の差分や 1 バージョンの生成データを扱います。`version-compare` は `detail` で名前の一覧を求めない限り件数で答え、`class-diff` はシンボルのツールと同じく `mapping` が必須で、`registry-read` は `withData` を指定しない限りレジストリ名とエントリ数を返します。Mod のツールは Mod の JAR を `jarPath` で受け取ります。`mod-inspect` はメタデータを返し、`mod-search` はソースを検索し、`mod-remap` は Fabric / Quilt の JAR をリマップします (出力を書き込むのは `apply: true` のときだけです)。Mod のクラスは `target: { kind: "jar", jarPath }` を指定した `source-read` と `member-list` で読みます。検証のツールは Loom プロジェクトを Minecraft のバイトコードに照らして検証します。`mixin-validate` は `source`、`paths`、`configPaths`、`discover: true` のいずれか 1 つを受け取って Mixin クラスごとに報告し、`project-validate` はワークスペースの Mixin 設定と Access Widener を見つけて検証し、ファイルごとに報告します。どちらも省略した `version` と `mapping` を `projectPath` があるときに限りプロジェクトから読み取り、Mixin の名前空間を推測することはありません。読み取れないときは、テンプレートの次の一手を付けて `status: "blocked"` を返します。`access-validate` は `content` または `path` で受け取った 1 つの Access Widener / Access Transformer をエントリごとに検証し、`mixin-verify-target` は Mixin が対象とする 1 つのメソッドまたはフィールドを確認して `@Shadow`・`@Accessor`・`@Invoker` のどれを使うかを助言します。どちらも検証する名前の名前空間を示す `mapping` が必須で、`mixin-verify-target` は `autoRemap: false` を指定しない限り、その名前を JAR の名前空間に変換します。NBT のツールは Java Edition の NBT を変換します。`nbt-decode` は base64 の NBT バイト列を型付き JSON ドキュメントにし、`nbt-patch` はそのドキュメントに RFC 6902 の操作を適用し、`nbt-encode` はそれを base64 の NBT に書き戻します。`cache-manage` はサーバーのキャッシュエントリを集計・一覧・検証・削除します。`delete` には `selector` が必要で、`apply: true` を指定しない限りプレビューだけを行います。どのアクションも毎回エントリまたは件数を返します。`server-metrics` は、ツールごとの呼び出し回数を含むサーバーのランタイムカウンタを返します。入力・結果・8.x ツールからの対応は [tool-reference.md → Tool catalog](tool-reference.md#tool-catalog) を参照してください。8.x ツールは非推奨のエイリアスとして引き続き呼び出せます。

<!-- BEGIN GENERATED TOOL TABLE: catalog -->
| ツール | 役割 | 置き換える 8.x ツール |
| --- | --- | --- |
| `version-list` | Mojang のメタデータから Minecraft バージョンを一覧し、ローカルにキャッシュ済みのものを示す | `list-versions`, `inspect-minecraft` (`versions`) |
| `artifact-resolve` | バージョン・JAR・座標・ワークスペース・依存関係のターゲットを再利用できるアーティファクトに解決する | `resolve-artifact`, `inspect-minecraft` (`artifact`) |
| `artifact-index` | アーティファクトのファイル / シンボルのキャッシュ済みインデックスを再構築する | `index-artifact` |
| `file-list` | アーティファクト内のファイルパスをカーソル付きページングで一覧する | `list-artifact-files`, `inspect-minecraft` (`list-files`) |
| `file-read` | アーティファクト内の 1 ファイルをバイト上限付きで読む | `get-artifact-file`, `inspect-minecraft` (`file`) |
| `class-find` | 単純名または完全修飾名から、ネストされた JAR も含めて完全修飾クラス名を探す | `find-class`, `inspect-minecraft` (`class-overview`) |
| `source-read` | Minecraft・依存関係・Mod の JAR から 1〜50 クラスのソース (アウトライン・行範囲・全文) を読む | `batch-class-source`, `get-class-source`, `decompile-mod-jar`, `get-mod-class-source`, `inspect-minecraft` (`class-source`), `analyze-mod` (`class-source`) |
| `source-export` | 1〜50 クラスのソースを出力ディレクトリ配下に `.java` ファイルとして書き出す | `batch-class-source`, `get-class-source`, `get-mod-class-source` |
| `member-list` | 1〜50 クラスのバイトコード上のコンストラクタ・フィールド・メソッドをページング付きで一覧する | `batch-class-members`, `get-class-members`, `inspect-minecraft` (`class-members`), `analyze-mod` (`members`) |
| `source-search` | アーティファクトのインデックス化されたソースから、名前による宣言・ファイル内のテキスト・ファイルパスをページング付きで検索する | `search-class-source`, `inspect-minecraft` (`search`) |
| `symbol-check` | 1〜50 個のクラス・フィールド・メソッドが Minecraft バージョンのマッピングに存在するか確認する | `batch-symbol-exists`, `check-symbol-exists`, `analyze-symbol` (`exists`) |
| `symbol-map` | 1〜50 個のクラス・フィールド・メソッド名を名前空間の間で変換する (ディスクリプタでの厳密一致、ワークスペースのコンパイル時の名前への変換にも対応) | `batch-mappings`, `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, `analyze-symbol` (`map`, `exact-map`, `workspace`) |
| `class-mappings` | 1 クラスとそのメンバーの 4 名前空間すべての名前をページング付きで一覧する | `get-class-api-matrix`, `analyze-symbol` (`api-overview`) |
| `symbol-trace` | メソッドが存在する Minecraft バージョンを調べる | `trace-symbol-lifecycle`, `analyze-symbol` (`lifecycle`) |
| `version-compare` | 2 つの Minecraft バージョン間で追加・削除されたクラス・レジストリエントリ・ライブラリを数える (求めれば一覧も返す) | `compare-versions`, `compare-minecraft` (`versions`, `registry-diff`, `migration-overview`) |
| `class-diff` | 1 クラスのコンストラクタ・メソッド・フィールドを 2 つの Minecraft バージョン間で比較する | `diff-class-signatures`, `compare-minecraft` (`class-diff`) |
| `registry-read` | バージョンの生成済みレジストリを読む: 名前とエントリ数、求めればエントリも返す | `get-registry-data` |
| `mod-inspect` | Mod の JAR のローダー・メタデータ・エントリポイント・Mixin 設定・依存関係・ネストされた JAR を読む (求めればクラス名も返す) | `analyze-mod-jar`, `decompile-mod-jar`, `analyze-mod` (`summary`, `decompile`) |
| `mod-search` | Mod の JAR の Java ソースからクラス名・メソッドとフィールドの宣言・テキストを検索する | `search-mod-source`, `analyze-mod` (`search`) |
| `mod-remap` | Fabric / Quilt の Mod の JAR を Yarn または Mojang の名前にリマップする (`apply` を指定しない限りプレビュー) | `remap-mod-jar`, `analyze-mod` (`remap`) |
| `project-validate` | Loom ワークスペースの Mixin 設定・Access Widener (求めれば Access Transformer も) を見つけて検証し、ファイルごとの状態を返す | `validate-project` (`project-summary`) |
| `mixin-validate` | Mixin のソース・ファイル・設定、またはプロジェクトで見つけた設定を Minecraft バージョンのバイトコードに照らして検証する | `validate-mixin`, `validate-project` (`mixin`) |
| `access-validate` | 1 つの Access Widener または Access Transformer (テキストまたはファイル) を、エントリごとに Minecraft バージョンのバイトコードに照らして検証する | `validate-access-widener`, `validate-access-transformer`, `validate-project` (`access-widener`, `access-transformer`) |
| `mixin-verify-target` | Mixin の対象メソッドまたはフィールドが JAR に存在するか確認し、@Shadow・@Accessor・@Invoker のどれを使うかの助言を得る | `verify-mixin-target` |
| `nbt-decode` | Java Edition の NBT バイト列 (base64、gzip または非圧縮) を型付き JSON ドキュメントにデコードする | `nbt-to-json` |
| `nbt-encode` | 型付き NBT JSON ドキュメントを Java Edition の NBT バイト列 (base64、gzip 圧縮も可) にエンコードする | `json-to-nbt` |
| `nbt-patch` | 型付き NBT JSON ドキュメントに RFC 6902 の add・remove・replace・test 操作を適用する | `nbt-apply-json-patch` |
| `cache-manage` | サーバーのキャッシュエントリを集計・一覧・検証・削除する (削除は `apply` を指定しない限りプレビュー) | `manage-cache` |
| `server-metrics` | ツールごとの呼び出し回数と所要時間を含む、サーバーのランタイムカウンタを読む | `get-runtime-metrics` |
<!-- END GENERATED TOOL TABLE: catalog -->

### 26.1+ のバージョンの名前

`26.1+` のような難読化されていないリリースでは、ランタイム jar に含まれるままの名前（`obfuscated` 名前空間）がすでに Mojang 名です。`mapping` は `obfuscated` と `mojang` のどちらも受け付け、どちらも同じ名前を読みます。`source-read`、`member-list` など `target` をアーティファクトに解決するツールは、どちらを指定しても、また `mapping` を省略しても `result.artifact.mappingApplied: "mojang"` と報告し、`artifact-resolve` に `detail: "full"` を指定すると `provenance.unobfuscatedRuntime: true` が表示されます。`artifact-resolve` は `requestedMapping` を書き換えないため、`requestedMapping: "obfuscated"` と `mappingApplied: "mojang"` が並ぶのは同一の名前を指すだけで、フォールバックではありません。`mapping: "mojang"` はランタイム / デコンパイルの経路を直接使い、Loom のソース jar の探索を省きます。`intermediary` や `yarn` で解決したターゲットは、警告付きでランタイムの名前にフォールバックし `mojang` と報告します。`symbol-trace` は指定された名前空間をそのまま報告します。対象はバージョンターゲット、Minecraft ランタイムの座標、および自身の内容（26.1+ の `id` を持つトップレベルの `version.json`、`net/minecraft/SharedConstants.class`、`.java` ソースなし）から 26.1+ の Minecraft ランタイム jar と分かる `jar` ターゲットです（[tool-reference.md → Lookup Rules](tool-reference.md#lookup-rules)）。バージョンが `26.x` に見えるだけの依存 jar は `obfuscated` のままです。`cache-manage` は各エントリが記録されたときのラベルを書き換えずに表示し、`access-validate` は検証に使ったバニラ jar を `provenance` で `obfuscated` と報告します。詳しくは [tool-reference.md → Namespace Definitions](tool-reference.md#namespace-definitions) を参照してください。

### 非推奨の 8.x ツール

以下の 8.x ツールは 8.x の入力を引き続き受け付ける非推奨のエイリアスで、早くとも 10.0.0 で削除され、`MCP_DEPRECATED_TOOLS=off` を設定すると除外されます（詳細は [tool-reference.md → Deprecated 8.x tools](tool-reference.md#deprecated-8x-tools)）。

<!-- BEGIN GENERATED TOOL TABLE: aliases -->
| 8.x ツール | 置き換え先 |
| --- | --- |
| `list-versions` | `version-list` |
| `inspect-minecraft` | `versions` → `version-list`, `artifact` → `artifact-resolve`, `class-overview` → `class-find`, `class-source` → `source-read`, `class-members` → `member-list`, `search` → `source-search`, `file` → `file-read`, `list-files` → `file-list` |
| `analyze-symbol` | `exists` → `symbol-check`, `map` → `symbol-map`, `exact-map` → `symbol-map`, `lifecycle` → `symbol-trace`, `workspace` → `symbol-map`, `api-overview` → `class-mappings` |
| `compare-minecraft` | `versions` → `version-compare`, `class-diff` → `class-diff`, `registry-diff` → `version-compare`, `migration-overview` → `version-compare` |
| `analyze-mod` | `summary` → `mod-inspect`, `decompile` → `mod-inspect`, `search` → `mod-search`, `class-source` → `source-read`, `members` → `member-list`, `remap` → `mod-remap` |
| `validate-project` | `project-summary` → `project-validate`, `mixin` → `mixin-validate`, `access-widener` → `access-validate`, `access-transformer` → `access-validate` |
| `manage-cache` | `cache-manage` |
| `verify-mixin-target` | `mixin-verify-target` |
| `batch-class-source` | `source-read`, `source-export` |
| `batch-class-members` | `member-list` |
| `batch-symbol-exists` | `symbol-check` |
| `batch-mappings` | `symbol-map` |
| `resolve-artifact` | `artifact-resolve` |
| `find-class` | `class-find` |
| `get-class-source` | `source-read`, `source-export` |
| `get-class-members` | `member-list` |
| `search-class-source` | `source-search` |
| `get-artifact-file` | `file-read` |
| `list-artifact-files` | `file-list` |
| `trace-symbol-lifecycle` | `symbol-trace` |
| `diff-class-signatures` | `class-diff` |
| `find-mapping` | `symbol-map` |
| `resolve-method-mapping-exact` | `symbol-map` |
| `get-class-api-matrix` | `class-mappings` |
| `resolve-workspace-symbol` | `symbol-map` |
| `check-symbol-exists` | `symbol-check` |
| `nbt-to-json` | `nbt-decode` |
| `nbt-apply-json-patch` | `nbt-patch` |
| `json-to-nbt` | `nbt-encode` |
| `index-artifact` | `artifact-index` |
| `get-runtime-metrics` | `server-metrics` |
| `validate-mixin` | `mixin-validate` |
| `validate-access-widener` | `access-validate` |
| `validate-access-transformer` | `access-validate` |
| `analyze-mod-jar` | `mod-inspect` |
| `get-registry-data` | `registry-read` |
| `compare-versions` | `version-compare` |
| `decompile-mod-jar` | `mod-inspect`, `source-read` |
| `get-mod-class-source` | `source-read`, `source-export` |
| `search-mod-source` | `mod-search` |
| `remap-mod-jar` | `mod-remap` |
<!-- END GENERATED TOOL TABLE: aliases -->

詳細なパラメータ制約、移行メモ、リソースの挙動、環境変数の完全な一覧は [tool-reference.md](tool-reference.md) を参照してください。

## 開発

リポジトリ要件:

- Node.js 22.13.0+
- `pnpm`
- ローカルでリマップやデコンパイルを実行する場合は Java 17+

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

- `pnpm test:file <path...>`: 通常テストをファイル指定で絞り込む場合
- `pnpm test:grep <name-pattern>`: 通常テストを再帰的に集め、テスト名で絞り込む場合
- `pnpm test:manual:stdio-smoke`: MCP トランスポート、登録、手動ワークフローの変更時
- `pnpm test:manual:package-smoke`: パッケージインストールや配布形態の検証時
- `pnpm test:perf`: 検索、インデックス、性能に影響する変更時
- `pnpm test:coverage` または `pnpm test:coverage:lcov`: カバレッジ確認時（`lines=80`, `branches=70`, `functions=80`）
- `pnpm validate`: ローカルの完全検証スイートを実行する場合

通常の `.test.ts` ファイルは `tests/` 配下のドメイン別ディレクトリ（例: `source-service/`, `entry-tools/`, `mapping/`, `mixin/`, `tools/`, `aliases/`, `contracts/`, `utils/`）に置きます。ヘルパー専用モジュールは `tests/helpers` に残し、手動 smoke、性能、リソースのファイルは既存の専用ディレクトリに残します。

## ライセンス

[MIT](../LICENSE)
