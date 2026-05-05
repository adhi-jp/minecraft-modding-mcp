---
version: 1.0.0
name: vibe-commit-message
description: Use when writing, revising, reviewing, or critiquing git commit messages, especially commit bodies, Conventional Commits, release commits, dependency updates, monorepo/package changes, i18n/localization commits, performance work, CI/build automation, security/data-loss fixes, agent-authored history, LLM-readable project history, or requests for vibe/AI-friendly commit context.
---

# Vibe Commit Message

## Overview

Write commit messages for future agents and maintainers, not for replaying the
diff. The subject says what the commit achieves. The body preserves the context,
requirements, constraints, tradeoffs, and deliberate non-goals that the patch
cannot reliably explain by itself.

Treat commit messages as durable prose. Before finalizing, check that the
message is concise, meaning-preserving, language-aware, standalone, faithful to
exact repository templates, preserves required warnings, and is free of invented
context.

This skill controls message content only. Follow the repository's existing
staging, commit, signing, release, and Conventional Commit rules. Do not create a
commit unless the user or active workflow has authorized committing.

## Core Rule

Do not transcribe the diff. Preserve the reasoning that the diff cannot reliably
explain.

Before writing a body, classify candidate information by value:

| Information type | Commit-body treatment |
| --- | --- |
| Obvious from `git show --stat`, filenames, or a skim of the patch | Omit unless it changes a public contract or is needed as a search anchor |
| User report, production symptom, failed workflow, issue requirement, release constraint, or compatibility promise | Include |
| Design choice between plausible alternatives | Include the chosen path and why |
| Field, command, env var, error code, API name, or tool name future callers search for | Include sparingly as anchors |
| Test file names, individual test cases, helper names, moved functions, or line-by-line mechanics | Usually omit |
| Mechanical sync, dependency bump, generated lock update, or catalog refresh without behavior details | Prefer subject-only; add one sentence only for limited scope or absent context |
| i18n, localization, or translated-copy change | Preserve locale, user-facing copy intent, and unchanged source/code scope; do not claim product behavior changed unless code changed |
| Monorepo or multiple package change | Include the shared contract, versioning, generated-client, or workflow reason; split packages when no shared reason exists |
| Release commit | Follow release convention; summarize release contract, breaking/migration status, and verification without duplicating the changelog |
| Performance, CI/build, publishing, security/privacy, or data-loss change | Include supplied workload, toolchain, threat boundary, destructive ordering, and guardrail evidence; do not invent measurements, security claims, or rollout status |
| Rollback flag, migration path, breaking change, preserved legacy behavior, or intentional no-op | Include |
| Known limitation, deferred follow-up, or risk accepted for this commit | Include |
| Verification that changes confidence or review risk | Include briefly |

If the available evidence does not explain why the change exists, do not invent
motivation. Write a smaller message from observable behavior and ask for missing
context only when the commit would be misleading without it.

## Message Shape

Use the repository's subject style. For Conventional Commits, prefer:

```text
type(scope): outcome
```

Use documented or recent-history `type` values. If no local list exists, use
common Conventional Commit types:
`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`,
`style`, or `revert`. Do not invent generic types such as `change`.

The subject should name the achieved behavior or contract, not the editing act:

- Good: `fix(cache): count remapped jars in eviction limits`
- Weak: `fix(cache): update source-service and tests`
- Good: `test(search): split source-service search slice`
- Weak: `test: move tests into another file`

For non-trivial commits, use a body with stable labels. Include only sections
that have real content:

```text
Context:
- What problem, user report, production symptom, review finding, release
  constraint, or agent failure triggered this?

Decision:
- What path was chosen, and what important alternative or constraint shaped it?

Behavior:
- What user-visible, API, CLI, schema, data, compatibility, or workflow contract
  changed?

Compatibility:
- What breaks, migrates, rolls back, remains intentionally unchanged, or keeps
  legacy behavior working?

Verification:
- What proof matters for confidence? Prefer behavioral coverage, reproduction,
  smoke result, benchmark, or unchanged coverage over a test-case inventory.

Out of scope:
- What was intentionally not solved, deferred, or still risky?
```

For small commits, use a short paragraph or no body. If the subject plus diff
already answer the future reader's questions, omit the body. For mechanical
syncs, dependency bumps, generated lock updates, or catalog refreshes without
behavior details, prefer subject-only; add one sentence only when it records
limited scope or missing context the subject cannot carry.

When the repository or workflow requires commit trailers such as
`Co-Authored-By` or `Signed-off-by`, keep them in a final footer block separated
from the prose body by a blank line. Avoid ending the body with a final
single-line `Key: value` paragraph such as `Verification: ...` immediately
before adding trailers with `git commit --trailer`; Git may treat that line as
part of the trailer block. Prefer labeled body sections with bullets before the
footer:

```text
Verification:
- `git diff --check` passed.

Co-Authored-By: Codex <noreply@openai.com>
```

## Writing Workflow

1. Inspect the commit scope before writing: staged diff or target commit, recent
   local message style, and any referenced issue, plan, changelog entry, release
   note, incident, or review finding that explains intent.
2. Identify the future reader's likely question: why this exists, how callers are
   affected, whether behavior changed, how to roll it back, or what remains
   unsafe.
3. If the commit bundles multiple changes, identify the cohesion reason: shared
   user workflow, shared public contract, shared rollback path, shared plumbing,
   or one verification/review surface. Split the commit when the only connection
   is "these were in the same plan" or "the agent touched them together."
   For shared plumbing, name the stable workflow or contract before naming any
   symbol. A prompt-supplied component, prop, helper, or file name is not a
   durable anchor merely because it appears in the prompt. Prefer workflow
   labels such as save path, header handoff, sample refresh, request parsing, or
   generated-client contract unless the symbol is public API, diagnostic output,
   or the only durable search term.
4. Draft the subject from the outcome.
5. Draft the body from non-diff context and durable anchors. Keep implementation
   names only when they are public contracts, diagnostics, commands, env vars, or
   durable search anchors.
6. Cut any bullet that a future agent could recover just as well from the diff,
   `git show --stat`, or test names.
7. Check that every claim is supported by the diff, supplied context, local
   evidence, or a primary source. Remove unsupported impact, reliability,
   performance, security, or user-benefit claims.

## Common Commit Shapes

- **i18n / localization.** Name the locale and copy intent. Preserve paths,
  locale tags, message keys, and source strings as identifiers. State when source
  strings or code are unchanged. Do not turn copy clarification into a product,
  security, or all-locales claim.
- **Monorepo / multiple packages.** Name the shared contract: API shape,
  generated client, version alignment, shared runtime behavior, or one
  verification surface. Say why the packages move together without phrasing it
  as "in one commit" or "as part of this commit." List package names only as
  search anchors. Split unrelated package edits.
- **Dependency update.** Include the supplied reason: security advisory, runtime
  compatibility, framework peer range, CI requirement, or API migration. For a
  lockfile-only or routine bump, prefer subject-only or one limited-scope
  sentence. Do not claim security, performance, or compatibility from the version
  bump itself.
- **Performance work.** Name the workload and constraint: hot path, corpus,
  cache boundary, ordering contract, benchmark, or resource ceiling. Include
  measured deltas only when supplied. Preserve compatibility or correctness
  invariants that were kept while optimizing.
- **CI / build / publishing automation.** Preserve the failing runner, toolchain,
  permission, package-manager, or registry constraint. Explain the chosen narrow
  fix instead of listing YAML steps. Do not claim deployment, publication, or
  security hardening unless that action or evidence is supplied.
- **Security, privacy, or data-loss fix.** Name the concrete failure mode,
  threat boundary, destructive ordering, credential/store invariant, or
  fail-closed behavior. Keep exact error codes, env vars, file names, or commands
  only when they are audit or recovery anchors. Do not turn a local invariant
  into a broad "secure" or "data safe" claim.
- **Release commit.** Follow the repository's release subject and trailer
  convention. Summarize the release contract: version, breaking changes,
  migration path, and verification. Do not paste the changelog, add unreleased
  behavior, or claim publishing/rollout unless supplied. For release preparation,
  prefer `chore(release): 1.4.0` or `chore(release): prepare v1.4.0`; avoid
  `publish`, `deploy`, `roll out`, `ship`, and `cut` in both subject and body
  unless that action happened. Use neutral body verbs such as `Prepares`,
  `Promotes Unreleased entries into`, `Records`, or `Includes`.

## What to Preserve

Commit bodies are most useful when they capture:

- The triggering failure mode: production restart loop, flaky smoke, OOM, stale
  release note, confused caller, broken CI environment.
- The caller or user impact: could not recover, saw the wrong namespace, lost a
  diagnostic, received a misleading contract.
- The constraint: public API compatibility, cache identity, release-history
  accuracy, sandbox behavior, cost, latency, unsafe destructive path, CI runner
  capability.
- The selected design: cooperative budget instead of hard cancellation,
  structural assertion instead of exact prose, route-handler auth instead of
  Express middleware, local toolchain pin instead of global upgrade.
- The cohesion reason when multiple changes land together: shared UI plumbing,
  one public contract, one migration path, one review finding class, or one
  verification surface.
- Compatibility and escape hatches: breaking change, migration, rollback env
  var, legacy envelope preserved, no data migration required.
- Deliberate exclusions: follow-up spec, unsupported platform, no broad refactor,
  no AbortSignal threading, no production benchmark.
- Verification signal: reproduced failure, regression test, manual smoke, CI
  check, benchmark delta, coverage unchanged, guardrail still passing.

## Durable References

Commit messages should stand alone after scratch plans, chat context, and review
cycle state disappear.

Keep durable repository or issue-system references: issue IDs, incident IDs,
ADRs, release versions, public API names, stable design docs, and commit SHAs.

Translate references that are likely to rot:

- Replace plan item numbers with the actual requirement or user workflow.
- Replace review finding IDs with the invariant or failure mode the finding
  exposed.
- Replace "3 review cycles" with the specific class of defects fixed, unless the
  review-cycle count itself is an audit requirement.
- Replace "per the plan" with the concrete scope or acceptance criterion.

When a plan or review reference explains why unrelated-looking changes are
bundled, preserve that as a cohesion reason instead of as a bare identifier.

## What to Cut

Remove or compress:

- File-by-file change logs.
- "Add/update/remove" bullets that mirror filenames or symbols.
- Mechanical refresh bodies that only restate subject-level facts.
- Long lists of fields, tests, imports, or private implementation names
  (components, props, helpers, files, functions).
- Prompt-supplied private names that only explain how the patch was wired. Turn
  them into a workflow or contract label instead.
- Claims that every test case was added unless the test matrix itself is the
  commit's contract.
- Generic benefits such as "improves reliability", "enhances maintainability",
  "makes future work easier", "faster", or "more secure" without concrete
  evidence.
- Prompt or conversation leaks: `as requested`, `per the plan`, `above`,
  `Claude noticed`, `this commit`, `in this commit`, `in one commit`.
- Bare scratch references: `plan item 8.3`, `cycle 2 F1`, `the backlog file`,
  or deleted local note paths when they are not durable citations.

## Examples

### Incident or production symptom

Prefer:

```text
feat(validate-mixin,supervisor): return structured restart diagnostics

Context:
- `validate-mixin` could restart the MCP worker before callers learned which
  stage, namespace, or input caused the failure.

Decision:
- Add cooperative stage budgets and a typed restart envelope so callers can
  narrow the request or report a real crash instead of parsing a generic retry.

Compatibility:
- Legacy JSON-RPC errors remain for non-tool calls; env flags can disable the new
  budget and restart-envelope paths.

Out of scope:
- Hard cancellation of hung downstream awaits and `validate-project`
  partial-success are separate follow-ups.
```

Avoid a long field inventory unless those fields are the public contract a caller
must search for.

### Internal test refactor

Prefer:

```text
test(search): split source-service search coverage

The source-service test file had become the slowest and largest local feedback
surface. Move the search-specific cases and shared metric readers into a focused
slice while keeping total coverage unchanged.
```

Avoid listing every moved helper and test name; the rename and stat already show
that.

### Thin evidence

When the diff shows behavior but no rationale:

```text
fix(parser): preserve fractional Retry-After values

Use numeric parsing that keeps fractional seconds instead of truncating them.
No rollout, incident, or benchmark context was supplied.
```

Do not invent an outage, customer impact, or performance reason.

### Mechanical sync

Prefer subject-only when it carries the whole change:

```text
chore(skills): refresh bundled catalog and lock hashes
```

If one important limitation would otherwise be lost:

```text
chore(skills): refresh bundled catalog and lock hashes

No upstream behavior details were supplied beyond the catalog refresh.
```

Avoid a body that only says the same thing as the subject in longer words.

### Release commit

Prefer a neutral release-preparation subject. If a required footer trailer is
present, keep it after a blank line:

```text
chore(release): 1.4.0

Release contract:
- Prepares 1.4.0 with the contact CSV import parser and upload preview UI.

Compatibility:
- No breaking changes or migration steps.

Verification:
- `pnpm test` and `pnpm build` passed.

Co-Authored-By: Codex <noreply@openai.com>
```

Do not add footer trailers such as `Co-Authored-By` unless the repository or
workflow requires them. Avoid `publish`, `deploy`, `roll out`, `ship`, or `cut`
in the subject or body unless the supplied context says that action happened.
For preparation-only commits, write `Prepares 1.4.0`, `Records 1.4.0`, or
`Promotes Unreleased entries into 1.4.0`, not `Cuts 1.4.0`.

### Bundled plan or review work

Prefer:

```text
feat(requests): add empty-state onboarding and JSON save formatting

Context:
- Both changes touch the request-editor save path, header handoff, and sample
  refresh, so one review can cover the same user workflow.

Decision:
- Auto-format only JSON on save; XML and HTML remain manual because formatting
  can change whitespace-sensitive wire bytes.

Out of scope:
- Broader markup reflow and unrelated onboarding channels remain separate.
```

Avoid anchoring the body on `plan item 11.8`, `8.3`, or review-cycle finding IDs
unless those identifiers remain durable after the commit lands. Also avoid
private prop or component names such as `BodyEditor headers prop` when a workflow
label like header handoff carries the same meaning.

## Review Checklist

Before finalizing a commit message, verify:

- The subject is a standalone outcome in the repo's style.
- The body answers why, why this shape, compatibility, verification, or non-goals
  better than the diff can.
- Implementation-detail bullets are removed unless they are durable search
  anchors or public contracts.
- Breaking changes, rollback paths, migrations, and known limitations are visible
  when present.
- Unsupported impact claims and prompt-context references are gone.
- Required trailers are separated from the prose body by a blank line and the
  body does not end with a single-line `Key: value` paragraph immediately before
  a `git commit --trailer` footer is added.
