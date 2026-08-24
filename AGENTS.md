# AGENTS.md

## Purpose and Scope
- This file defines mandatory operating rules for agents working in this repository.
- When tradeoffs conflict, prioritize public API compatibility, verification evidence, and release safety.

## Core Release Policy
- From version 1.0.0 onward, the public MCP tool surface follows semantic versioning. Breaking changes require a major version bump.
- Do not bump any version unless explicitly instructed by the user. Version bump timing is decided by the user.

## Public MCP Contract (MUST)
- Treat the public contract as compatibility-bound: tool names, input parameter names/types/requiredness, and response envelope shape.
- Public MCP tool responses MUST use the standard envelope: `{ result?, error?, meta }`.
- Input validation failures MUST map to `ERR_INVALID_INPUT` and MUST NOT be reported as `ERR_INTERNAL`.
- Do not add compatibility aliases for renamed public tools or parameters unless explicitly requested by the user and documented with a removal plan.

## Change Coupling Rules (MUST)
- Any user-visible or public API change MUST update `README.md`, `CHANGELOG.md`, and relevant tests in the same change set.
- Do not defer documentation or test updates to follow-up commits.

## Verification Gate (MUST)
- Before claiming completion for production changes, run:
  - `pnpm check`
  - `pnpm test`
- When MCP transport/tool registration or manual workflows change, also run `pnpm test:manual:stdio-smoke` when environment permits.
- For search/index/performance-sensitive changes, run the repository performance validation suite.
- Do not claim "done", "fixed", or "passing" without fresh command output evidence.

## Release Safety (MUST)
- Release and publish workflows MUST use a clean build to prevent stale `dist` artifacts from being shipped.
- `package.json` release-facing contracts (`files`, `engines`, `bin`, and release scripts) MUST match implemented behavior and tests.
- Baseline runtime/tooling for this repository is Node.js 22+ and `pnpm`.

## Changelog and Tag Safety (MUST)
- Treat `origin` release tags (`vX.Y.Z`) as the source of truth for published versions.
- Do not record new changes under any CHANGELOG version heading whose tag already exists on `origin`.
- For all commits after the latest `origin` release tag, record changes only under `## [Unreleased]` until the next release is cut.
- Keep `## [Unreleased]` as a permanent heading: when the next release section is cut, insert `## [X.Y.Z] - YYYY-MM-DD` below it and leave `## [Unreleased]` in place, empty, so the next change always has a heading to land under.
- Cutting a release section is a rewrite for the end-user reader, not a copy of `## [Unreleased]`. See CHANGELOG Content Rules → Work-log detail and the release cut.
- Before editing CHANGELOG release sections, verify commit/tag boundaries (`git log --oneline --decorate` and `git tag` with remote-tracking tags) so entries map to the correct release window.
- Editing an already-tagged release section is allowed only with explicit user instruction and a documented history-rewrite/release-correction plan.

## Release Changelog Consistency Gate (MUST)
- During release preparation, you MUST verify that every CHANGELOG bullet planned for the release exactly matches the current implementation state; treat this as a blocking gate.
- Required procedure before release tagging/publishing:
  - Build a checklist from the target CHANGELOG section (`Added`/`Changed`/`Fixed`/`Performance`/`Documentation`).
  - For each checklist item, collect concrete evidence from code/tests/docs (for example: symbol/parameter presence via `rg`, behavior validation via targeted tests, and contract text in README).
  - If any bullet is unverifiable, stale, or contradicted by code/tests, update CHANGELOG and/or implementation in the same change set until all items reconcile.
  - Record the verification evidence in the release work log/PR notes; do not proceed on assumption-only validation.
  - Restructure every promoted entry for the end-user reader, then run `pnpm check:changelog` and resolve every finding. Do not proceed while it fails.
- Never finalize a release with unresolved CHANGELOG-to-implementation drift.

## Platform and Path Safety (MUST)
- Preserve WSL/Windows path normalization behavior for filesystem and JAR paths.
- Any path-normalization fix MUST include regression tests for boundary cases.

## Commit Rules (MUST)
- Use Conventional Commits.
- Breaking changes MUST use `!` in the type/scope summary and include a `BREAKING CHANGE:` footer.
- Keep commits logically scoped; do not mix unrelated changes.
- Do not commit files under `docs/specs/`, `docs/plans/`, or `docs/reports/`; keep specifications, implementation plans, and session reports out of repository history. `.gitignore` enforces all three, so a document that genuinely needs to ship belongs at a tracked path rather than force-added from one of these.
- Do not force-add ignored files or otherwise commit files outside the agreed commit scope unless the user explicitly instructs you to include those extra files.
- If the user explicitly asks to commit ignored or otherwise out-of-scope files, first suggest reviewing `.gitignore` so repository policy matches the intended commit behavior.

## CHANGELOG Content Rules (MUST)
- `CHANGELOG.md` is an END-USER document. Its reader consumes the published npm package and the MCP tool surface; they have no access to this repository, its tests, or its history.
- CHANGELOG entries MUST describe user-facing changes only.
- Do NOT record CI/CD pipeline changes, internal refactoring notes, implementation memos, workflow tweaks, or other changes that are invisible to end users.
- Examples of entries to exclude: "Codecov workflow temporarily disabled", "Added a mandatory AGENTS release-prep step", internal build script changes.

### Work-log detail and the release cut (MUST)
- While work is in flight, `## [Unreleased]` MAY carry work-log-grade detail: root-cause narratives, measured internals, and the evidence that made the entry writable. Recording it there is allowed.
- That allowance ENDS AT THE RELEASE CUT. Promoting `## [Unreleased]` entries into `## [X.Y.Z] - YYYY-MM-DD` is a REWRITE, not a move: the release commit MUST restructure every promoted entry for the end-user reader.
- A dated release section MUST NOT contain:
  - repository-internal paths — `tests/**`, `src/**`, `scripts/**`, `.github/**`, `dist/**`, `coverage/**`, test fixtures, or golden files;
  - proof-of-work markers such as `Verification:`, `Pinned by`, `Guarded by`, or enumerations of test suites and test file names;
  - implementation narrative that explains how this repository is built rather than what the reader now observes.
- User-facing paths MAY appear when the entry is about them: `docs/**`, `README.md`, and release-facing `package.json` fields.
- Every entry in a dated release section MUST answer, for a reader with no repository access: what behaves differently now, what it did before when that is needed to recognize the change, and what the reader must do about it.
- Keep measured numbers the reader can observe (timings, response counts, memory, sizes). Drop measurements that only describe internal structures.
- Length is a symptom, not the rule. An entry that needs many sentences to state one observable contract delta has not been restructured yet.
- Do NOT skip the restructuring because the `## [Unreleased]` wording is already accurate. Accuracy is not the bar; audience is. An accurate work log promoted verbatim is a policy violation.

### Release CHANGELOG gate (MUST)
- `pnpm check:changelog` mechanically audits the dated section matching the current `package.json` version. It is fail-closed and MUST pass before a release commit is finalized and before a release tag is pushed.
- The gate runs in `.github/workflows/changelog-gate.yml` on any change to `CHANGELOG.md`, `package.json`, `AGENTS.md` or the gate scripts, and again fail-closed in `.github/workflows/publish.yml`. A release whose section fails the gate cannot be published.
- Pushing a git tag is not itself gated by CI. The publish workflow is the fail-closed boundary, so run `pnpm check:changelog` locally before tagging rather than relying on a tag push to surface the failure.
- The gate is a FLOOR, not a substitute for the restructuring above: it detects internal references and outlier-length entries. It cannot detect an accurate-but-internal narrative that avoids those markers, so passing the gate does not mean the section is end-user-ready.
- Do NOT weaken the gate, add exceptions to it, or skip it to make a release pass. Fix `CHANGELOG.md` instead.

## Prohibitions
- Do not introduce public naming changes (tool names or parameters) without explicit migration documentation.
- Do not ship temporary behavior toggles without documented removal criteria.
- Do not promote `## [Unreleased]` entries into a dated release section verbatim; the release cut MUST restructure them for end users.
- Do not change repository policy in code without updating this file in the same change set.
