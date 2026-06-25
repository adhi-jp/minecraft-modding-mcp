# Localized Labels

Use this reference when rendering item-review output, interpreting user item
decisions or identifier shortcuts, counting persistence thresholds, reflecting
decisions into the plan, or summarizing review results.

## Language Selection

Match the user's active language for prose. Preserve file paths, commands,
identifiers, and review-state paths exactly.

When the user's active language is Japanese, use the exact labels in the
Japanese label set below. When the user's active language is not Japanese, use a
natural translation for prose and keep the four decision states semantically
equivalent to approved, revise-before-execution, held, and deleted. Do not
translate file paths, commands, identifiers, or `.<plan-name>.review.md`.
Use the same stable choice identifiers in every language.

## Japanese Label Set

Use this exact per-item output shape:

```text
判定: <問題なし | 要修正 | 要確認 | ブロッカー>
指摘:
- <finding or "なし">
推奨アクション: <recommended action>
ユーザー選択肢:
- 1 承認: <meaning for this item>
- 2 修正: <meaning for this item>
- 3 保留: <meaning for this item>
- 4 削除: <meaning for this item>
```

AI judgment labels:

- `問題なし`: no material issue found for this item.
- `要修正`: the item should be revised before execution.
- `要確認`: the item needs a user decision or clarification before execution.
- `ブロッカー`: review cannot safely continue for this item until a blocking
  conflict or missing information is resolved.

User decision labels:

- `承認`: keep the item for execution.
- `修正`: keep the item only after revision before execution.
- `保留`: keep the item visible as unresolved after final plan reflection.
- `削除`: remove the item from the executable plan only after final reflection
  confirmation.

User decision identifiers:

- `1`: `承認`.
- `2`: `修正`.
- `3`: `保留`.
- `4`: `削除`.

Accept surrounding prose or punctuation when exactly one label or identifier is
unambiguous, such as `2でお願いします`. If a reply contains multiple choices or a
label and identifier that map to different decisions, ask the user to clarify.
Identifiers are shortcuts only for the current item decision; they are not final
reflection confirmation, scope approval, or permission to start implementation.

`修正` and `保留` are the revise-or-hold decisions for the temporary review-file
threshold. After identifier normalization, `2` counts as `修正` and `3` counts
as `保留`.

## Reflection Semantics

For every language, final reflection semantics are:

- Approved items remain executable plan content.
- Revise-before-execution items remain only with the accepted revision or with a
  clear revise-before-execution marker if the user has not supplied final
  wording.
- Held items remain visible as unresolved.
- Deleted items are removed from the executable plan.
