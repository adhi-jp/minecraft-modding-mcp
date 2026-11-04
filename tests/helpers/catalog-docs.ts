/**
 * Documentation data for the tool tables (helper module, not a test file):
 * the one-line purpose of each catalog tool in English and Japanese, and the
 * renderers for the generated tables in README.md and docs/README-ja.md. The
 * catalog table follows the catalog spec order, with a "replaces" column from
 * the alias inventory; the alias table follows the alias inventory and names
 * the catalog tools that replace each deprecated 8.x tool.
 */
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { ALIAS_TOOL_INVENTORY, type AliasToolInventoryEntry } from "../../src/tools/inventory.ts";

export type DocLocale = "en" | "ja";

export const CATALOG_TABLE_BEGIN = "<!-- BEGIN GENERATED TOOL TABLE: catalog -->";
export const CATALOG_TABLE_END = "<!-- END GENERATED TOOL TABLE: catalog -->";
export const ALIAS_TABLE_BEGIN = "<!-- BEGIN GENERATED TOOL TABLE: aliases -->";
export const ALIAS_TABLE_END = "<!-- END GENERATED TOOL TABLE: aliases -->";

export const CATALOG_TOOL_PURPOSES: Readonly<Record<string, Readonly<Record<DocLocale, string>>>> = {
  "version-list": {
    en: "List Minecraft versions from Mojang metadata and mark the locally cached ones",
    ja: "Mojang のメタデータから Minecraft バージョンを一覧し、ローカルにキャッシュ済みのものを示す"
  },
  "artifact-resolve": {
    en: "Resolve a version, JAR, coordinate, workspace, or dependency target to a reusable artifact",
    ja: "バージョン・JAR・座標・ワークスペース・依存関係のターゲットを再利用できるアーティファクトに解決する"
  },
  "artifact-index": {
    en: "Rebuild the cached file and symbol index of an artifact",
    ja: "アーティファクトのファイル / シンボルのキャッシュ済みインデックスを再構築する"
  },
  "file-list": {
    en: "List file paths inside an artifact with cursor pagination",
    ja: "アーティファクト内のファイルパスをカーソル付きページングで一覧する"
  },
  "file-read": {
    en: "Read one file inside an artifact with a byte limit",
    ja: "アーティファクト内の 1 ファイルをバイト上限付きで読む"
  },
  "class-find": {
    en: "Find fully qualified class names from a simple or qualified name, including nested JARs",
    ja: "単純名または完全修飾名から、ネストされた JAR も含めて完全修飾クラス名を探す"
  },
  "source-read": {
    en: "Read the source of 1-50 classes (outline, line window, or full file) from Minecraft, dependency, or mod JARs",
    ja: "Minecraft・依存関係・Mod の JAR から 1〜50 クラスのソース (アウトライン・行範囲・全文) を読む"
  },
  "source-export": {
    en: "Write the source of 1-50 classes as `.java` files under an output directory",
    ja: "1〜50 クラスのソースを出力ディレクトリ配下に `.java` ファイルとして書き出す"
  },
  "member-list": {
    en: "List the bytecode constructors, fields, and methods of 1-50 classes with paging",
    ja: "1〜50 クラスのバイトコード上のコンストラクタ・フィールド・メソッドをページング付きで一覧する"
  },
  "source-search": {
    en: "Search an artifact's indexed source for declarations by name, text inside files, or file paths, with paging",
    ja: "アーティファクトのインデックス化されたソースから、名前による宣言・ファイル内のテキスト・ファイルパスをページング付きで検索する"
  },
  "symbol-check": {
    en: "Check whether 1-50 classes, fields, or methods exist in a Minecraft version's mappings",
    ja: "1〜50 個のクラス・フィールド・メソッドが Minecraft バージョンのマッピングに存在するか確認する"
  },
  "symbol-map": {
    en: "Map 1-50 class, field, or method names between namespaces, strictly by descriptor, or to a workspace's compile names",
    ja: "1〜50 個のクラス・フィールド・メソッド名を名前空間の間で変換する (ディスクリプタでの厳密一致、ワークスペースのコンパイル時の名前への変換にも対応)"
  },
  "class-mappings": {
    en: "List one class and its members with their names in all four namespaces, with paging",
    ja: "1 クラスとそのメンバーの 4 名前空間すべての名前をページング付きで一覧する"
  },
  "symbol-trace": {
    en: "Find the Minecraft versions in which a method exists",
    ja: "メソッドが存在する Minecraft バージョンを調べる"
  },
  "version-compare": {
    en: "Count, and on request list, the classes, registry entries, and libraries added or removed between two Minecraft versions",
    ja: "2 つの Minecraft バージョン間で追加・削除されたクラス・レジストリエントリ・ライブラリを数える (求めれば一覧も返す)"
  },
  "class-diff": {
    en: "Diff one class's constructors, methods, and fields between two Minecraft versions",
    ja: "1 クラスのコンストラクタ・メソッド・フィールドを 2 つの Minecraft バージョン間で比較する"
  },
  "registry-read": {
    en: "Read a version's generated registries: names and entry counts, and the entries on request",
    ja: "バージョンの生成済みレジストリを読む: 名前とエントリ数、求めればエントリも返す"
  },
  "mod-inspect": {
    en: "Read a mod JAR's loader, metadata, entrypoints, mixin configs, dependencies, and nested JARs, and on request its class names",
    ja: "Mod の JAR のローダー・メタデータ・エントリポイント・Mixin 設定・依存関係・ネストされた JAR を読む (求めればクラス名も返す)"
  },
  "mod-search": {
    en: "Search a mod JAR's Java source for class names, method and field declarations, or text",
    ja: "Mod の JAR の Java ソースからクラス名・メソッドとフィールドの宣言・テキストを検索する"
  },
  "mod-remap": {
    en: "Remap a Fabric or Quilt mod JAR to Yarn or Mojang names (preview unless `apply` is set)",
    ja: "Fabric / Quilt の Mod の JAR を Yarn または Mojang の名前にリマップする (`apply` を指定しない限りプレビュー)"
  },
  "project-validate": {
    en: "Find and validate a Loom workspace's mixin configs, access wideners, and on request access transformers, with each file's status",
    ja: "Loom ワークスペースの Mixin 設定・Access Widener (求めれば Access Transformer も) を見つけて検証し、ファイルごとの状態を返す"
  },
  "mixin-validate": {
    en: "Validate Mixin source, files, configs, or a project's discovered configs against a Minecraft version's bytecode",
    ja: "Mixin のソース・ファイル・設定、またはプロジェクトで見つけた設定を Minecraft バージョンのバイトコードに照らして検証する"
  },
  "access-validate": {
    en: "Validate one access widener or access transformer, given as text or a file, entry by entry against a Minecraft version's bytecode",
    ja: "1 つの Access Widener または Access Transformer (テキストまたはファイル) を、エントリごとに Minecraft バージョンのバイトコードに照らして検証する"
  },
  "mixin-verify-target": {
    en: "Check that a mixin's target method or field exists in a JAR and get @Shadow, @Accessor, or @Invoker advice",
    ja: "Mixin の対象メソッドまたはフィールドが JAR に存在するか確認し、@Shadow・@Accessor・@Invoker のどれを使うかの助言を得る"
  },
  "nbt-decode": {
    en: "Decode Java Edition NBT bytes (base64, gzip or uncompressed) into a typed JSON document",
    ja: "Java Edition の NBT バイト列 (base64、gzip または非圧縮) を型付き JSON ドキュメントにデコードする"
  },
  "nbt-encode": {
    en: "Encode a typed NBT JSON document into Java Edition NBT bytes as base64, optionally gzip-compressed",
    ja: "型付き NBT JSON ドキュメントを Java Edition の NBT バイト列 (base64、gzip 圧縮も可) にエンコードする"
  },
  "nbt-patch": {
    en: "Apply RFC 6902 add, remove, replace, and test operations to a typed NBT JSON document",
    ja: "型付き NBT JSON ドキュメントに RFC 6902 の add・remove・replace・test 操作を適用する"
  },
  "cache-manage": {
    en: "Summarize, list, verify, and delete the server's cache entries (delete previews unless `apply` is set)",
    ja: "サーバーのキャッシュエントリを集計・一覧・検証・削除する (削除は `apply` を指定しない限りプレビュー)"
  },
  "server-metrics": {
    en: "Read the server's runtime counters, including per-tool call counts and durations",
    ja: "ツールごとの呼び出し回数と所要時間を含む、サーバーのランタイムカウンタを読む"
  }
};

const HEADERS: Readonly<Record<DocLocale, string>> = {
  en: "| Tool | Purpose | Replaces (8.x) |",
  ja: "| ツール | 役割 | 置き換える 8.x ツール |"
};

/**
 * The 8.x tools a catalog tool takes over: single-purpose tools first, then
 * multiplexed tools with the tasks taken over in parentheses.
 */
export function replacedEightXTools(catalogName: string): string[] {
  const replaced = ALIAS_TOOL_INVENTORY.filter((entry) => entry.replacedBy.includes(catalogName));
  const ordered = [
    ...replaced.filter((entry) => entry.tasks === undefined),
    ...replaced.filter((entry) => entry.tasks !== undefined)
  ];
  return ordered.map((entry) => {
    const tasks = Object.entries(entry.tasks ?? {})
      .filter(([, tool]) => tool === catalogName)
      .map(([task]) => `\`${task}\``);
    return tasks.length > 0 ? `\`${entry.name}\` (${tasks.join(", ")})` : `\`${entry.name}\``;
  });
}

/** The generated catalog table, without its markers. */
export function renderCatalogTable(locale: DocLocale): string {
  const rows = CATALOG_TOOL_SPECS.map((spec) => {
    const purpose = CATALOG_TOOL_PURPOSES[spec.name]?.[locale] ?? "";
    return `| \`${spec.name}\` | ${purpose} | ${replacedEightXTools(spec.name).join(", ")} |`;
  });
  return [HEADERS[locale], "| --- | --- | --- |", ...rows].join("\n");
}

const ALIAS_HEADERS: Readonly<Record<DocLocale, string>> = {
  en: "| 8.x tool | Replaced by |",
  ja: "| 8.x ツール | 置き換え先 |"
};

/**
 * The catalog tools that replace one deprecated 8.x tool: its `replacedBy`
 * list, or for a multiplexed tool one `` `task` → `tool` `` pair per task.
 */
export function aliasReplacementCell(entry: AliasToolInventoryEntry): string {
  if (entry.tasks !== undefined) {
    return Object.entries(entry.tasks)
      .map(([task, tool]) => `\`${task}\` → \`${tool}\``)
      .join(", ");
  }
  return entry.replacedBy.map((tool) => `\`${tool}\``).join(", ");
}

/** The generated alias table, without its markers. */
export function renderAliasTable(locale: DocLocale): string {
  const rows = ALIAS_TOOL_INVENTORY.map((entry) => `| \`${entry.name}\` | ${aliasReplacementCell(entry)} |`);
  return [ALIAS_HEADERS[locale], "| --- | --- |", ...rows].join("\n");
}

function generatedSection(document: string, begin: string, end: string): string | undefined {
  const start = document.indexOf(begin);
  const stop = document.indexOf(end);
  if (start < 0 || stop < start) return undefined;
  return document.slice(start + begin.length, stop).trim();
}

/** The text between the catalog table markers of a document, trimmed. */
export function generatedCatalogSection(document: string): string | undefined {
  return generatedSection(document, CATALOG_TABLE_BEGIN, CATALOG_TABLE_END);
}

/** The text between the alias table markers of a document, trimmed. */
export function generatedAliasSection(document: string): string | undefined {
  return generatedSection(document, ALIAS_TABLE_BEGIN, ALIAS_TABLE_END);
}
