---
version: 3.1.0
name: vibe-debug
description: Use when debugging or repairing existing features from rough agent-assisted coding reports, regressions, failed prior fixes, repeated "still broken" feedback, source-only debugging stalls, unobserved runtime state, tool or automation failures, environment-specific failures, runtime artifact mismatches, security boundary surprises, or fixes that feel wrong.
---

# Vibe Debug

## Overview

Turn rough bug reports into verified repair work. Preserve the user's wording as
product evidence, then translate it into observable symptoms, expected
behavior, unknowns, proof paths, and closure criteria before changing code.

This skill is self-contained. Use useful project rules, docs, tools, and
available skills when they clearly apply, but do not require any other skill to
debug, fix, verify, or hand off the issue.

## When to Use

Use this for existing-feature repair when the user reports any of these:

- "Still broken", "not fixed", "looks wrong", "feels wrong", or similarly rough
  feedback after real use.
- A regression, failed previous fix, repeated symptom, environment-specific
  behavior, stale runtime artifact, tool failure, or automation failure.
- A bug where the first report is an example rather than a full reproduction.
- Debugging is drifting into broad source reading, repeated patching, or
  approach changes while runtime ordering, artifacts, cleanup, or environment
  state remains unobserved.
- A fix that might affect existing behavior, contracts, state, permissions,
  artifacts, lifecycle, or user-visible output.

Examples are not boundaries. Name the abstract dimension before the concrete
domain example: UI/web, auth origin, asset path, encoding, worker, deploy
artifact, animation, or async cleanup. Do not turn that domain into a universal
requirement for unrelated bugs.

## When Not to Use

- Greenfield feature work with no existing behavior or reported symptom.
- Pure review cycles where an active review workflow is already sufficient.
- General commit, history rewrite, or release decisions unless they are part of
  debug/fix closure and separately authorized for the exact operation.
- One-line mechanical edits where no symptom, regression, or existing behavior
  is at stake.

## Core Rule

The user's report is valuable evidence of experience, not a verified root
cause. Investigate available code, tests, logs, screenshots, docs, artifacts,
history, and tool output before asking questions. Ask only questions that change
the fix, proof path, risk acceptance, or current-scope closure.

Use probes only when they provide better proof than more static work. First run
bounded triage: nearest code, relevant tests, existing logs, artifacts, and the
expected-behavior source. After triage, propose the smallest diagnostic probe or
equivalent runtime observation before changing behavior again when multiple
live-state hypotheses remain, static proof would sprawl across interacting
surfaces, evidence contradicts the original approach, or the next source-only
patch would be a guess.

Stop before implementation when the current issue lacks any of these:

- A reproducible symptom, isolation proof, source trace, or exact manual proof
  path.
- An authoritative expected behavior source.
- A verification path that can observe the claimed fix.
- Current-scope closure criteria for each reported symptom.

Explain blockers in user-impact terms: what the user could still see, lose,
misconfigure, trust incorrectly, or be unable to verify.

## Minimum Visible Output

Keep the workflow visible even when the immediate answer is short, blocked,
refuses an unsafe shortcut, has no local files to inspect, or handles only
debug/fix closure such as repository history. Do not replace the ledger with
general advice or a promise to fill it in later.

Before asking a narrowing question, stopping, delegating, or handing a check to
the user, include a compact current-scope record:

- Current slice: preserve the user's wording, then state the observable
  behavior or operation decision, expected source or missing source, unknowns,
  proof or preflight path, and closure criteria.
- Ledger: one row per unresolved symptom, hypothesis, failed tool decision, or
  closure decision. Use the debug-ledger fields when the row is a repair
  symptom. When repair is already verified and only repository mutation or
  cleanup remains, do not reopen the repair; record a closure-decision row with
  source evidence, owned and ambiguous paths, affected history/index state,
  required consent, preflight path, and status.
- Claim labels: separate verified facts, hypotheses, expert judgment, expected
  outcomes, and proof results for implementation-affecting claims.
- Existing behavior or state: name the user-visible output, internal state,
  persistence/lifecycle, external contract, runtime artifact, tool contract, or
  repository history/index state that must be preserved, changed
  intentionally, is unknown, or is not applicable.

If the only available evidence is the prompt, plan, or supplied fixture, say
that explicitly and reason from it before asking for the smallest missing
decision. A narrow question is not a substitute for the current-scope record.

## Delegated Diagnosis

When several independent hypotheses each need bounded read-only investigation
and the host exposes a delegation or sub-agent capability, fan the
investigations out instead of reading everything serially. The fan-out may run
as ad-hoc sub-agent calls or as one scripted orchestration run: a host
mechanism that runs the investigators under a single deterministic,
independently recorded run and returns their results. Do not require a
specific host orchestration tool.

Give each delegated unit one hypothesis-shaped question and a read-only
boundary: inspect code, tests, logs, artifacts, and history, and return
evidence with sources suitable for the debug ledger. Probes that mutate state,
temporary instrumentation, user-environment retests, edits, and ledger
ownership stay with the coordinator. A delegated finding enters the ledger as
recorded evidence for a hypothesis, not as the proven cause; the disconfirming
check and closure decisions still run in this workflow.

When the host lets you choose a delegated model and the user has not explicitly
fixed one, choose a fit-for-purpose model per hypothesis. Use a cheaper or
faster model for bounded file/log lookup or mechanical reproduction checks, and
use a higher-capability or larger-context model for contradicted prior fixes,
cross-layer diagnosis, security/data-loss risk, environment-sensitive behavior,
or other judgment-heavy hypotheses. Do not spend the top model on every narrow
reader, and do not downshift solely to save tokens when the investigation needs
stronger reasoning. Record any explicit user model override or the
capability/context reason for a non-default model when the host exposes that
metadata.

## Repository History Boundary

Debug proof authorizes only the verified repair slice. It does not authorize
staging, committing, stashing, resetting, amending, version changes, release
preparation, or any other index or history operation.

When debug/fix closure includes a request for repository mutation, first run a
dirty worktree and index preflight:

- Refresh staged, unstaged, and untracked state.
- Identify the paths that belong to the verified repair slice.
- Surface unrelated or ambiguous dirty paths before staging or cleanup.
- Require explicit operation-specific user consent naming the operation, such
  as stage, commit, stash, reset, squash, amend, release preparation, or version
  bump.

Generic permission to "fix it", a completed debug ledger, or a passing test is
not consent for repository history mutation. Do not stage, stash, reset, amend,
or otherwise mutate unrelated user changes. If ownership is ambiguous or a
release/history operation is requested without exact consent, stop with the
preflight evidence and the smallest decision needed.

## Reference Routing

Read these bundled references only when their details are needed:

- `references/debug-ledger.md` - ledger template, closure statuses, and
  repeated-attempt handling.
- `references/source-routing.md` - source-of-truth routing and tool-confidence
  ledger.
- `references/state-space-matrix.md` - state-space dimensions for static,
  dynamic, environment, representation, and lifecycle bugs.
- `references/probe-escalation.md` - temporary probes, traces, logs,
  assertions, runtime observations, and cleanup.
- `references/verification-handoff.md` - artifact freshness,
  verification-degradation, and user retest contracts.
- `references/continuity-and-recurrence.md` - resume handling and repeated-class
  self-review.

## Workflow

Before source edits or final repair claims, read
`references/debug-workflow.md`. That reference owns the detailed
inspect/reproduce/instrument/repair/verify/handoff loop and the proof
requirements inside the loop.

## Stop Conditions

Stop and report a blocker or ask the smallest plan-changing question when:

- Expected behavior has no source and the difference affects product behavior,
  data, permissions, security, external contracts, or user experience.
- The symptom cannot be reproduced, isolated, source-traced, or handed off with
  exact manual proof.
- A repeated report arrives and you cannot explain why the prior fix failed.
- A needed source, artifact, tool, or runtime path is unavailable and no
  alternate proof is credible.
- A needed diagnostic probe, trace, log, assertion, or runtime observation is
  unavailable and no source trace or alternate proof can observe the unknown.
- A current-scope existing-behavior dimension remains `unknown`.

## Finish Gate

Before ending:

- Every current-scope ledger item has status `fixed`, `not-reproduced`,
  `deferred`, `accepted-residual`, or `blocked`.
- Every `fixed` item has proof and artifact freshness when runtime artifacts are
  involved.
- Temporary probes are removed before finishing, or any retained diagnostic
  surface is intentional, disabled or bounded, documented, and verified not to
  expose secrets or user data.
- Every preserved or intentionally changed behavior dimension has verification
  or an explicit residual.
- Skipped or degraded checks are reported as non-proof with next action.
- User-side retests, when needed, include exact steps and expected observations.
- Staging, commit, stash, reset, amend, release, or other history operations
  were either absent, or explicitly consented after dirty worktree and index
  preflight and scoped to the verified repair slice.
