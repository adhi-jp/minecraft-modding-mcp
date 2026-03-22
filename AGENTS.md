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
- Once the next release section is cut, remove any empty `## [Unreleased]` heading instead of leaving a blank placeholder at the top of the file.
- Before editing CHANGELOG release sections, verify commit/tag boundaries (`git log --oneline --decorate` and `git tag` with remote-tracking tags) so entries map to the correct release window.
- Editing an already-tagged release section is allowed only with explicit user instruction and a documented history-rewrite/release-correction plan.

## Release Changelog Consistency Gate (MUST)
- During release preparation, you MUST verify that every CHANGELOG bullet planned for the release exactly matches the current implementation state; treat this as a blocking gate.
- Required procedure before release tagging/publishing:
  - Build a checklist from the target CHANGELOG section (`Added`/`Changed`/`Fixed`/`Performance`/`Documentation`).
  - For each checklist item, collect concrete evidence from code/tests/docs (for example: symbol/parameter presence via `rg`, behavior validation via targeted tests, and contract text in README).
  - If any bullet is unverifiable, stale, or contradicted by code/tests, update CHANGELOG and/or implementation in the same change set until all items reconcile.
  - Record the verification evidence in the release work log/PR notes; do not proceed on assumption-only validation.
- Never finalize a release with unresolved CHANGELOG-to-implementation drift.

## Platform and Path Safety (MUST)
- Preserve WSL/Windows path normalization behavior for filesystem and JAR paths.
- Any path-normalization fix MUST include regression tests for boundary cases.

## Commit Rules (MUST)
- Use Conventional Commits.
- Breaking changes MUST use `!` in the type/scope summary and include a `BREAKING CHANGE:` footer.
- Keep commits logically scoped; do not mix unrelated changes.
- Do not force-add ignored files or otherwise commit files outside the agreed commit scope unless the user explicitly instructs you to include those extra files.
- If the user explicitly asks to commit ignored or otherwise out-of-scope files, first suggest reviewing `.gitignore` so repository policy matches the intended commit behavior.

## CHANGELOG Content Rules (MUST)
- CHANGELOG entries MUST describe user-facing changes only.
- Do NOT record CI/CD pipeline changes, internal refactoring notes, implementation memos, workflow tweaks, or other changes that are invisible to end users.
- Examples of entries to exclude: "Codecov workflow temporarily disabled", "Added a mandatory AGENTS release-prep step", internal build script changes.

## Prohibitions
- Do not introduce public naming changes (tool names or parameters) without explicit migration documentation.
- Do not ship temporary behavior toggles without documented removal criteria.
- Do not change repository policy in code without updating this file in the same change set.
