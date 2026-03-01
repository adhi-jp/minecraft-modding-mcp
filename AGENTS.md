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
- When MCP transport/tool registration or manual workflows change, also run `pnpm test:manual:mcp-use-smoke` when environment permits.
- For search/index/performance-sensitive changes, run the repository performance validation suite.
- Do not claim "done", "fixed", or "passing" without fresh command output evidence.

## Release Safety (MUST)
- Release and publish workflows MUST use a clean build to prevent stale `dist` artifacts from being shipped.
- `package.json` release-facing contracts (`files`, `engines`, `bin`, and release scripts) MUST match implemented behavior and tests.
- Baseline runtime/tooling for this repository is Node.js 22+ and `pnpm`.

## Platform and Path Safety (MUST)
- Preserve WSL/Windows path normalization behavior for filesystem and JAR paths.
- Any path-normalization fix MUST include regression tests for boundary cases.

## Commit Rules (MUST)
- Use Conventional Commits.
- Breaking changes MUST use `!` in the type/scope summary and include a `BREAKING CHANGE:` footer.
- Keep commits logically scoped; do not mix unrelated changes.

## Prohibitions
- Do not introduce public naming changes (tool names or parameters) without explicit migration documentation.
- Do not ship temporary behavior toggles without documented removal criteria.
- Do not change repository policy in code without updating this file in the same change set.
