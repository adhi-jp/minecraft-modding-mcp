# Summary Output — 日本語レンダリング例

**Status**: illustrative example only. The authoritative translation contract lives in `skills/codex-review-cycle/SKILL.md` §Language — this file demonstrates how to apply those rules in Japanese. For German, Korean, or other languages, read SKILL.md §Language directly; this file is not a template to translate.

`SKILL.md` §Summary Output Template で定義された **finding-block 形式** を日本語で render した例を以下に示す。テーブル形式や区切り線つきラベル形式は SKILL.md で禁止されているため、このサンプルは扱わない。

## Cycle 要約（finding-block 形式）

````markdown
### Cycle N レビュー結果 (variant: adversarial-review, target: code)

#### F1 · high · must-fix · valid — Missing null check on userId
- **ファイル**: `src/auth/login.ts:42`
- **Claude のメモ**: DoD 必須機能への違反；コア正しさが崩れる
- **推奨アクション**: 修正を適用する
- **codex 推奨（原文）**: <codex recommendation verbatim — 原文のまま、日本語化しない>

#### F4 · medium · minimal-hygiene · valid — --url-query value leaks to URL
- **ファイル**: `src/curl.rs:130`
- **Claude のメモ**: value consume + warn のみ；意味論は未実装
- **推奨アクション**: 1 行 hygiene を適用
- **codex 推奨（原文）**: <codex recommendation verbatim>

#### F5 · medium · reject-out-of-scope · valid — Implement --json shorthand body
- **ファイル**: `src/curl.rs:120`
- **Claude のメモ**: DoD explicit out-of-scope: cURL 7.82+ 新規機能
- **推奨アクション**: スキップ（ledger 送り）
- **codex 推奨（原文）**: <codex recommendation verbatim>

#### F2 · medium · reject-noise · partially-valid — Consider adding retry logic
- **ファイル**: `src/api/user.ts:88`
- **Claude のメモ**: 曖昧；具体的な失敗モードなし
- **推奨アクション**: スキップ
- **codex 推奨（原文）**: <codex recommendation verbatim>

#### F3 · low · reject-noise · invalid — Rename process to handler
- **ファイル**: `docs/plan.md:15`
- **Claude のメモ**: plan target 上の detailed-design nitpick
- **推奨アクション**: スキップ
- **codex 推奨（原文）**: <codex recommendation verbatim>
````

## Finding の並び順

`must-fix` → `minimal-hygiene` → `reject-out-of-scope` → `reject-noise` の scope 順。同一 scope 内は severity（`high` → `medium` → `low`）、同一 severity 内は codex の出力順を保持する。選択可能な finding が上に集まるため、user は却下分を読み飛ばさずに操作対象へ辿り着ける。

## 翻訳規則（抜粋）

翻訳規則の完全版は SKILL.md §Language を参照。日本語 render 時の該当対応:

- **verbatim を保つ**:
  - 見出し行の `<codex title verbatim>` 本文
  - `codex 推奨（原文）` bullet の引用本文
  - `Severity` / `Scope` / `Validity` の keyword（`high` / `medium` / `low` / `must-fix` / `minimal-hygiene` / `reject-out-of-scope` / `reject-noise` / `valid` / `partially-valid` / `invalid`）
  - `File:Line` のファイルパスと行番号
  - stop-signal `Status` keyword（`ACTIVE` / `ADVISORY` / `WARNING` / `silent`）
  - 技術識別子（`fingerprint`, `cluster_id`, field 名など）
  - `cycle N` のサイクルインデックス（`/N` 分母は v1.7.0 で廃止）
- **日本語化する**:
  - 見出し `### Cycle N レビュー結果 ...`
  - bullet ラベル（`ファイル` / `Claude のメモ` / `推奨アクション` / `codex 推奨（原文）` 等）
  - `Claude のメモ` 本文
  - `推奨アクション` の値（`修正を適用する` / `1 行 hygiene を適用` / `スキップ` / `スキップ（ledger 送り）` 等）
  - stop signal footer の見出し・evidence 説明文
  - 終了メッセージ・fleet-rate warning・degraded-mode warning
  - `AskUserQuestion` の各フィールド

## 見出し中黒点 (`·`) の扱い

`F<n> · <severity> · <scope> · <validity> — <title>` の中黒点は視覚的セパレータで、SKILL.md は `·` (U+00B7) のみを許可する。`|`、カンマ、半角ハイフンで置換しない。日本語 render でも同じ文字を使う。

## stop signal footer の日本語例

```markdown
**有効な stop signal**:

| シグナル               | 状態     | 根拠                                                     |
|-----------------------|----------|--------------------------------------------------------|
| hygiene-only-stretch  | ACTIVE   | cycles N-1, N で適用された finding はすべて minimal-hygiene |
| file-bloat            | ADVISORY | src/curl_import.rs: 1500 → 2310 lines (baseline の 1.54 倍) |

_評価未実施（metrics 未提供）: reactive-testing_
```

列ヘッダーは §Language 契約に従い日本語化する（`Signal` → `シグナル`、`Status` → `状態`、`Evidence` → `根拠`）。permissive な「訳して良い」ではなく mandatory — sample は renderer 向けの operational guidance なので、英語ヘッダーのまま残すと契約違反の render を誘発する。列本文の stop-signal 名と `Status` keyword (`ACTIVE` / `ADVISORY` / `WARNING` / `silent`)、`file:line` と数値は原文維持。Evidence 欄の説明文は日本語化する。`_評価未実施（metrics 未提供）: …_` の行は、footer が `not evaluated` 行しか持たない場合のコンパクト one-liner で使う（SKILL.md §Summary Output Template 参照）。

## 終了メッセージの日本語例

SKILL.md §Termination Criteria の render 順に従い、(1) verdict headline → (2) variant body → (3) Verification Disclaimer → (4) Applied-Fixes List → (5) 残存行（該当時）→ (6) Review assessment → (7) soft-reset（working-tree / no-cycle-commits ではゼロ出力）の順で 1 本に繋げる。末尾に自由記述の Summary / recap 段落を追加しない。

### Case A clean（残存なし、2 サイクルで終端）

```
✅ クリーン終了 · サイクル 2 · 1 件の修正を適用 · トレンド: 収束

⚠️ 自動検証は実行していません。このスキルは user の代わりにテスト・lint・build を走らせません。いずれの終了 variant（クリーン終了／残存ありで終了／上限到達）に達しても、それは codex の finding 列挙が停止条件に達したことのみを意味し、コードが正しい、diff が出荷可能である、または上記の残存／未解決 finding が些末であるとは保証しません。リリース前に diff を確認し、必要な検証（テスト、型チェック、lint、build、手動動作確認）を各自で実行してください。

適用した修正（サイクル別）:
- サイクル 1:
  - F1 (must-fix) Identifier cache ignores Character.m_name changes
- サイクル 2: なし
```

### Case A residuals（user-declined が残った状態で終端、user 拡張で 3 サイクル実行した例）

```
⚠️ 残存ありで終了 · サイクル 3 · 2 件適用 / 1 件残存 · トレンド: 安定

⚠️ 自動検証は実行していません。このスキルは user の代わりにテスト・lint・build を走らせません。いずれの終了 variant（クリーン終了／残存ありで終了／上限到達）に達しても、それは codex の finding 列挙が停止条件に達したことのみを意味し、コードが正しい、diff が出荷可能である、または上記の残存／未解決 finding が些末であるとは保証しません。リリース前に diff を確認し、必要な検証（テスト、型チェック、lint、build、手動動作確認）を各自で実行してください。

適用した修正（サイクル別）:
- サイクル 1:
  - F1 (must-fix) Missing null check on userId
- サイクル 2:
  - F4 (minimal-hygiene) --url-query value leaks to URL
- サイクル 3: なし

user が却下した有効な finding（終端まで残存）:
- F2 (must-fix) Consider adding retry logic — src/api/user.ts:88, 却下されたサイクル: 2
diff 範囲外で skip された finding（終端まで残存）:
- なし
```

### Case B user-elected（最終サイクル assessment で user が `レビューを終了する` を選択）

```markdown
⚠️ 上限到達 · サイクル 2 · 3 件適用 / 2 件未解決 · トレンド: 安定

⚠️ 自動検証は実行していません。このスキルは user の代わりにテスト・lint・build を走らせません。いずれの終了 variant（クリーン終了／残存ありで終了／上限到達）に達しても、それは codex の finding 列挙が停止条件に達したことのみを意味し、コードが正しい、diff が出荷可能である、または上記の残存／未解決 finding が些末であるとは保証しません。リリース前に diff を確認し、必要な検証（テスト、型チェック、lint、build、手動動作確認）を各自で実行してください。

適用した修正（サイクル別）:
- サイクル 1:
  - F1 (must-fix) Race condition in session refresh flow
  - F2 (minimal-hygiene) Log message leaks request id
- サイクル 2:
  - F3 (must-fix) Token refresh skips error propagation

- 実行サイクル数: 2
- 適用した finding 数: 3
- 上限時点で有効かつ未解決の finding 数: 2

### 未解決の有効な finding

<Summary Output Template の finding-block を、適用されなかった valid / partially-valid のみでフィルタして再掲>

### 次の手段

- 追加作業後に `codex-review-cycle` を再実行する、
- 未解決の finding を手動で対処する、または
- 既知の残存として明示的に受容する。
```

### Final-cycle Assessment（サイクル 2 終端、user 判断プロンプト前に表示）

`SKILL.md` §Final-cycle Assessment で定義されたブロックの日本語例。サイクル 2 の fix phase 完了後、終了判断 `AskUserQuestion` を出す前にこのブロックを render する。

````markdown
### 最終サイクル評価

#### このランで対応した指摘

- サイクル 1:
  - F1 (must-fix) Race condition in session refresh flow
    - 不変条件: refresh トークン取得は同一 user について排他化される
    - 確認した surface: `auth/refresh.ts`, `auth/session.ts` の同期パス両方
    - 残存: なし
    - 次サイクル攻撃面: 同一 user で並列 refresh が発生したとき deadlock しない再保証
  - F2 (minimal-hygiene) Log message leaks request id
    - 不変条件: log line は request id を含めない
    - 確認した surface: `logger.ts` の error / warn パス
    - 残存: なし
    - 次サイクル攻撃面: closed
- サイクル 2:
  - F3 (must-fix) Token refresh skips error propagation
    - 不変条件: refresh のエラーは呼び出し元へ伝搬する
    - 確認した surface: `auth/refresh.ts` の throw / Promise.reject パス
    - 残存: token 失効時の UI 通知パス（次サイクルで対応提案）
    - 次サイクル攻撃面: accepted residual

#### 残存している指摘

- F4 (must-fix) Consider rate-limiting refresh attempts — src/auth/refresh.ts:88, 却下されたサイクル: 2
- F5 (minimal-hygiene) Add request-id to error message — src/api/user.ts:140, 却下されたサイクル: 1

#### Claude の判断

**トレンド**: 安定 — サイクル 1 で 5 件、サイクル 2 で 3 件 selectable があり、適用は 3 件、却下が 2 件で残った。
**残存サマリ**: user-declined 2 件（must-fix 1 件、minimal-hygiene 1 件）、diff 範囲外 skip は 0 件。
**スコープ健全性**: 警告 — サイクル 2 の finding が直前サイクルで追加した文言の精緻化を求めている。
**検証ギャップ**: 1 件の適用済み fix が codex によって再レビューされていません — End を選ぶと再レビュー無しで出荷します。 Continue または別の視点でレビューを選ぶと cycle 3 で再評価されます。
**推奨**: レビューを終了する — スコープ健全性の警告が出ているため、次サイクルは本質的な修正より自己誘発の精緻化を増やす可能性が高い。

[AskUserQuestion]
質問: サイクル 2 が完了しました。レビューを終了する／同じ focus でもう 1 サイクル実行する／別の視点でもう 1 サイクル実行する のどれにしますか？
ヘッダー: 最終サイクル判断
オプション:
- レビューを終了する — Phase 2 終了処理へ進む（残存 finding は Case B として render）
- レビューを続ける（サイクル 3 を実行） — 同じ focus で codex を再呼び出し、`<previous_fixes>` に今サイクルの applied envelope を carry
- 別の視点でレビューする（サイクル 3 を `<angle_request>` 付きで実行） — codex に別アングルを依頼
````

### Final-cycle Assessment 用語対応

| 英語 canonical | 本ファイルの日本語訳 |
|----------------|---------------------|
| `Final-cycle assessment` | 最終サイクル評価 |
| `Findings addressed in this run` | このランで対応した指摘 |
| `Outstanding findings` | 残存している指摘 |
| `Claude's judgment` | Claude の判断 |
| `Trend` | トレンド |
| `Residuals summary` | 残存サマリ |
| `Scope-health` | スコープ健全性 |
| `healthy` | 健全 |
| `warning` | 警告 |
| `Verification gap` | 検証ギャップ |
| `Recommendation` | 推奨 |
| `Invariant` | 不変条件 |
| `Surfaces checked` | 確認した surface |
| `Residuals` | 残存 |
| `Next-cycle attack` | 次サイクル攻撃面 |
| `End the review` | レビューを終了する |
| `Continue reviewing (run cycle N+1)` | レビューを続ける（サイクル `<N+1>` を実行） |
| `Run a new-angle review (cycle N+1 with angle_request)` | 別の視点でレビューする（サイクル `<N+1>` を `<angle_request>` 付きで実行） |
| `Final-cycle decision` | 最終サイクル判断 |

## 翻訳対応（本ファイルで使った訳語）

`SKILL.md` §Language が authoritative。本サンプルで採用した日本語訳を以下に列挙する（他プロジェクトで流用する場合は §Language に従って調整可）:

| 英語 canonical | 本ファイルの日本語訳 |
|----------------|---------------------|
| `Clean termination` | クリーン終了 |
| `Terminated with residuals` | 残存ありで終了 |
| `Cap reached` | 上限到達 |
| `cycles` | サイクル |
| `fix(es) applied` | 件の修正を適用 |
| `applied` | 件適用 |
| `residual` | 件残存 |
| `unresolved` | 件未解決 |
| `trend` | トレンド |
| `converging` | 収束 |
| `stable` | 安定 |
| `cascading` | 連鎖 |
| `Applied fixes by cycle` | 適用した修正（サイクル別） |
| `Cycle <N>` | サイクル `<N>` |
| `none` | なし |
| `User-declined valid findings carried to termination` | user が却下した有効な finding（終端まで残存） |
| `Out-of-diff skipped findings carried to termination` | diff 範囲外で skip された finding（終端まで残存） |
| `declined in cycle <N>` | 却下されたサイクル: `<N>` |
| `Cycles run` | 実行サイクル数 |
| `Findings applied` | 適用した finding 数 |
| `Findings still valid and unresolved at cap` | 上限時点で有効かつ未解決の finding 数 |
| `Unresolved valid findings` | 未解決の有効な finding |
| `No unresolved findings.` | 未解決の finding はありません。 |
| `Next steps` | 次の手段 |

## verdict headline の render 規則

- `✅` / `⚠️` emoji はそのまま。翻訳も省略もしない。
- verdict キーワード（`クリーン終了` / `残存ありで終了` / `上限到達`）は日本語化する。英語のまま残すと §Language 契約違反。
- 数字 (`2`, `1`, `3`, ...) は literal、中黒点 `·` (U+00B7) も verbatim。`/N` 形式の分母は v1.7.0 で廃止（cap が user 拡張で動的変化するため）。
- trend キーワード（`収束` / `安定` / `連鎖`）は日本語化し、Review assessment の Trend センテンス冒頭と一致させる（SKILL.md §Review Assessment 参照）。

## Verification Disclaimer の固定化

`⚠️ 自動検証は実行していません。…` の段落は SKILL.md §Verification Disclaimer 指定の **固定 boilerplate**。以下の内容を埋め込むのは禁止（日本語でも同じ禁止が効く）:

- run 固有の手動テスト提案（例: 「tamed-rename シナリオの smoke test を検討してください」）
- 現 run でのビルド・テスト結果の言及（例: 「`dotnet build` は 0 error / 0 warning でした」）
- variant 固有の framing（例: 「`resolved` は …」「残存が運ばれて …」「上限に達して …」）— disclaimer 本体は 3 variant すべてで true である必要がある
- `（テスト、型チェック、lint、build、手動動作確認）` の括弧内を run 固有の内容で置換すること

run 固有の推奨は §19 Review assessment の「推奨される次のアクション」側に集約する。Disclaimer 本体はテンプレートのまま繰り返し render する（Case A / Case B で短縮しない）。

## Applied-Fixes List の禁止事項

- 実装詳細 prose（例: `BaseName を CachedIdentifier に追加し ...`）
- 理由・原因の説明（例: `A-5 と A-6 の invalidation が非対称だったため ...`）
- コード片・識別子の引用
- `... のため修正`・`... して対処した` などの解説

上記はいずれも `F<n> (<scope_category>) <codex title verbatim>` の 3 要素を超える情報であり、git log と §19 Suggested next action が受け持つ領域である。
