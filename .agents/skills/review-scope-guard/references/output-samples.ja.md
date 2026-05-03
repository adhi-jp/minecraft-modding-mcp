# Scope Triage Output — 日本語レンダリング例

**Status**: illustrative example only. The authoritative translation contract lives in `skills/review-scope-guard/SKILL.md` §Language — this file demonstrates how to apply those rules in Japanese. For German, Korean, or other languages, read SKILL.md §Language directly; this file is not a template to translate.

## Triage 判定テーブル

```markdown
### スコープ判定 (cycle N, DoD anchor: <intent 文>)

| ID | Severity | File:Line            | Title (verbatim)                | カテゴリ             | DoD anchor        | 判定理由                                  | アクション                  |
|----|----------|----------------------|---------------------------------|----------------------|-------------------|-----------------------------------------|----------------------------|
| F1 | high     | src/auth/login.ts:42 | Missing null check on userId    | must-fix             | Required features | コアパスの正しさ違反                       | 修正を適用                 |
| F2 | medium   | src/api/user.ts:88   | Consider adding retry logic     | reject-noise         | none              | 曖昧；具体的な失敗モードなし                | 却下（ノイズ）              |
| F3 | low      | docs/plan.md:15      | Rename process to handler       | reject-noise         | none              | plan target 上の detailed-design          | 却下（ノイズ）              |
| F4 | medium   | src/curl.rs:120      | Implement --json shorthand body | reject-out-of-scope  | Out-of-scope      | cURL 7.82+ 意味論は明示的に除外             | 却下（ledger 送り）         |
| F5 | medium   | src/curl.rs:130      | --url-query value leaks into URL| minimal-hygiene      | Quality bars      | value consume + warn；意味論は追加しない   | 1 行 hygiene を適用         |

### 推奨事項（各 finding、codex recommendation を redacted-verbatim 引用）

- **F1**: <codex recommendation redacted-verbatim — §Secret Hygiene 適用後の形を日本語化しない>
- **F2**: <同上>
- **F3**: <同上>
- **F4**: <同上>
- **F5**: <同上>

triage table の下にこの redacted-verbatim 引用ブロックを必ず付与する。非 secret 部分は省略・要約・翻訳せず、secret match は `[REDACTED:<type>]` に置換した形だけを出力する。

### このサイクル後の rejected ledger

<YAML ブロック — id / cluster_id / dedupe_token / reason / first_seen_cycle / last_seen_cycle / count は原文維持。`raw_fingerprint` は internal-only のため user-facing YAML には出さない。`dedupe_token` (8-char hex) は v1.3.1 で追加された caller-facing フィールドで、 §Secret Hygiene overlay 対象外 (構成要素が non-secret のため)>

### Active stop signals (cycle N)

| Signal                | Status   | Evidence                                                |
|-----------------------|----------|--------------------------------------------------------|
| ...                   | ...      | ...                                                    |

_Not evaluated (metrics missing): <リスト>_

⚠️ <N> 件の secret redaction を verbatim 出力に適用しました (種別: <comma-list of <type> values>).

**次のアクション**: <ACTIVE/WARNING 時のみ表示。ADVISORY のみならこの行は省略>
```

## 翻訳規則（抜粋）

翻訳規則の完全版は SKILL.md §Language を参照。以下は日本語で render する際の該当対応:

- **redacted-verbatim に保つ**: `Title (verbatim)` 列本文、**推奨事項（各 finding）本文の `<codex recommendation redacted-verbatim>`**、カテゴリ名、`Severity`、`File:Line`、`cluster_id`、ledger `id` (`L1` / `L2` …)、stop-signal 名と `Status` keyword、DoD anchor 固定語、cycle インデックス、**`[REDACTED:<type>]` リテラル全体**（`<type>` 値 `apikey` / `jwt` / `private-key` / `url-auth` / `secret-context` / `env-secret` も英文字のまま保持）。
- **日本語化する**: 見出し（「推奨事項（各 finding）」等、**ただし本文の `<codex recommendation redacted-verbatim>` は redacted-verbatim 保持**）、列ヘッダー (`カテゴリ` / `判定理由` / `アクション` 等)、判定理由本文、アクション値、次のアクション推奨テキスト、degraded-mode warning、redaction summary 行の散文部 (`<N> 件の secret redaction を verbatim 出力に適用しました (種別: …)` の和文部分。`[REDACTED:<type>]` リテラルおよび `<type>` 列挙値は和訳しない)。
