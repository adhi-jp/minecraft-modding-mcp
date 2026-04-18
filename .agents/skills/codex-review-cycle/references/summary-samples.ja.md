# Summary Output — 日本語レンダリング例

**Status**: illustrative example only. The authoritative translation contract lives in `skills/codex-review-cycle/SKILL.md` §Language — this file demonstrates how to apply those rules in Japanese. For German, Korean, or other languages, read SKILL.md §Language directly; this file is not a template to translate.

## Cycle 要約テーブル

```markdown
### Cycle N レビュー結果 (variant: <review|adversarial-review>, target: <code|plan>)

| ID | Severity | File:Line            | Title (codex verbatim)          | Validity          | Scope              | Claude のメモ                              | 推奨アクション          |
|----|----------|----------------------|---------------------------------|-------------------|--------------------|------------------------------------------|--------------------|
| F1 | high     | src/auth/login.ts:42 | Missing null check on userId    | valid             | must-fix           | DoD 必須機能への違反；コア正しさ            | 適用する            |
| F2 | medium   | src/api/user.ts:88   | Consider adding retry logic     | partially-valid   | reject-noise       | 曖昧；具体的な失敗モードなし                  | スキップ             |
| F3 | low      | docs/plan.md:15      | Rename process to handler       | invalid           | reject-noise       | plan target 上の detailed-design           | スキップ             |
| F4 | medium   | src/curl.rs:130      | --url-query value leaks to URL  | valid             | minimal-hygiene    | value consume + warn；意味論は未実装        | 1 行 hygiene を適用 |
| F5 | medium   | src/curl.rs:120      | Implement --json shorthand body | valid             | reject-out-of-scope| DoD explicit out-of-scope: cURL 7.82+ 新規 | スキップ（ledger 送り）|

**推奨事項（各 finding）:**

- **F1**: <codex recommendation verbatim>
- **F2**: <codex recommendation verbatim>
```

## 翻訳規則（抜粋）

翻訳規則の完全版は SKILL.md §Language を参照。以下は日本語で render する際の該当対応:

- **verbatim に保つ**: `Title (codex verbatim)` 列本文、`推奨事項` 節の各 `<codex recommendation verbatim>`、`Severity`、`File:Line`、scope category 名、validity 値、stop-signal `Status` keyword、技術識別子、`cycle N` / `N/3`。
- **日本語化する**: 見出し、列ヘッダー (`Claude のメモ` / `推奨アクション` 等)、`Claude のメモ` 本文、`推奨アクション` 値、終了メッセージ、stop signal footer の evidence 説明文、AskUserQuestion 各フィールド。

## stop signal footer の日本語例

```markdown
**Active stop signals**:

| Signal                | Status   | Evidence                                                |
|-----------------------|----------|--------------------------------------------------------|
| hygiene-only-stretch  | ACTIVE   | cycles N-1, N で適用された finding はすべて minimal-hygiene |
| file-bloat            | ADVISORY | src/curl_import.rs: 1500 → 2310 lines (baseline の 1.54 倍) |

_Not evaluated (metrics missing): reactive-testing_
```

`Signal` / `Status` 列の値は英語 keyword（`ACTIVE` / `ADVISORY` / `WARNING` / `silent`）を維持する。Evidence 欄は日本語で説明して良いが、ファイルパスと数値は原文維持。

## 終了メッセージの日本語例

```
3 サイクルすべて完了しました。

⚠️ 自動検証は実行していません。このスキルは user の代わりにテスト・lint・build を走らせません。"resolved" は「codex が 0 件を返し、残存もなかった」のみを意味します。リリース前に diff を確認し、必要な検証（テスト、型チェック、lint、build、手動動作確認）を各自で実行してください。

適用した修正（サイクル別）:
- Cycle 1: <finding タイトル一覧 または "なし">
- Cycle 2: ...
- Cycle 3: ...
```
