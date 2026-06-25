---
version: 3.0.0
name: vibe-debug
description: Use when debugging or repairing existing features from rough vibe-coding reports, regressions, failed prior fixes, repeated "still broken" feedback, source-only debugging stalls, unobserved runtime state, tool or automation failures, environment-specific failures, runtime artifact mismatches, security boundary surprises, or fixes that feel wrong.
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

1. **Continuity preflight**
   - After resume, interruption, context compaction, or a "continue" request,
     re-read the latest user request, outstanding symptoms, ledger statuses,
     and next proof/action before doing new work.
   - Do not drop unresolved symptoms because a prior subtask was completed.

2. **Capture vibe intent**
   - Preserve the user's wording for symptoms, UX concerns, "feels wrong"
     observations, and corrections to offered choices.
   - Translate the wording into observable behavior, expected behavior,
     unknowns, affected users or contexts, and current-scope closure criteria.
   - Treat user free-text changes to offered options as signal. Re-check what
     changed instead of mapping the answer back to the closest original option.

3. **Optional useful-skill and rule preflight**
   - Check project instructions, local docs, and visible skill metadata for
     task-relevant guidance.
   - Use matching available skills only when they directly help with the current
     stack, proof method, writing pass, or tool path.
   - If none apply or one is unavailable, continue with this workflow.

4. **Open the debug ledger**
   - Maintain a ledger with these fields for each current-scope symptom:
     reported symptom; expected behavior and source; observed behavior and
     source; prior attempts and why each failed or remains unproven; suspected
     causes; probe or instrumentation plan and result when source-only evidence
     cannot distinguish live-state hypotheses; proven cause; affected
     state-space dimensions; verification path; closure status.
   - Closure status is exactly one of `fixed`, `not-reproduced`, `deferred`,
     `accepted-residual`, or `blocked`.
   - Do not claim "fixed" until every current-scope ledger item has proof and a
     closure status.

5. **Analyze existing behavior**
   - Identify current behavior to preserve before changing code.
   - Split it into user-visible output, internal state transition,
     persistence/lifecycle behavior, external contracts, and
     operational/runtime artifacts.
   - Mark each dimension as `preserve`, `change intentionally`, `unknown`, or
     `not applicable`.
   - Treat an `unknown` dimension that affects the current fix as a blocker
     until source trace, local reproduction, or accepted residual resolves it.
   - Add at least one verification item for every `preserve` or
     `change intentionally` dimension that can regress.

6. **Route sources and tool confidence**
   - Before editing unfamiliar external API, framework, protocol, data contract,
     permission, build, deploy, or tool behavior, check the authoritative
     source: official docs, upstream source, local project code, CLI help,
     changelog, useful available skill, or user-provided source material.
   - If a tool fails, classify the failure narrowly: failed command, failed
     mode, failed input shape, unavailable service, missing permission, stale
     artifact, or flaky environment.
   - Choose a narrower retry, fallback proof, or blocker. Do not abandon all
     related tools because one mode or invocation failed.

7. **Build the state-space matrix**
   - For non-trivial fixes, convert user examples into domain-general dimensions
     before naming domain-specific cases.
   - Put an abstract dimension label beside every domain-specific case, probe,
     retest step, or closure criterion. Use labels such as representation,
     runtime artifact, lifecycle, ordering, identity, environment, permission,
     and cleanup. Domain tools may fit the report, but they must not read as
     universal requirements outside that domain.
   - Include relevant dimensions such as input representation, encoding,
     environment/origin, platform/runtime, direction, lifecycle state,
     cache/artifact freshness, permission/role, sync/async path, and
     error/cancel path.
   - For dynamic, visual, streaming, event-driven, queue, cache, or lifecycle
     bugs, include temporal sequence, ordering, overlapping events, per-entity
     identity, reset/cancel behavior, and stale-state cleanup after the final
     event.

8. **Control speculation**
   - Classify each implementation-affecting statement as `verified fact`,
     `hypothesis`, `expert judgment`, `expected outcome`, or `proof result`.
   - Do not act on a `hypothesis`, `expert judgment`, or `expected outcome`
     unless the next step is explicitly a proof step, the user accepts the
     residual risk, or the item is outside the current fix.
   - Convert optimistic language into proof requirements. "This should fix it"
     becomes "the proof needed is ..."; "looks fixed" becomes a recorded manual
     or automated observation.
   - Name one fast disconfirming check that could show the chosen cause or fix
     is wrong.

9. **Choose diagnostic probes at the right time**
   - Run bounded static triage first: nearest source path, relevant tests,
     existing logs, artifact freshness, expected-behavior source, and one fast
     disconfirming check when available.
   - Do not propose a probe solely because the bug is dynamic. Prefer a failing
     regression test, local reproduction, source trace, existing log, or
     artifact inspection when it answers the current question.
   - Trigger this gate before another fix only when bounded triage still leaves
     multiple live-state explanations, static proof would sprawl across many
     files or runtime paths, the original approach is contradicted, or a repeated
     source-only fix comes back "still broken".
   - If the probe needs the user's real environment, compare that burden with
     the value of the observation. Prefer local or artifact-level proof when it
     answers the same question.
   - State the probe question: what branch, state transition, payload,
     artifact, timestamp, ordering, identity, cleanup, or runtime boundary the
     probe must observe to separate the hypotheses.
   - Prefer low-friction probes that fit the user's real observation path:
     existing logger calls, focused trace labels, counters, debug-only dumps,
     test-harness assertions, artifact/package inspection, or narrow runtime
     logs.
   - Avoid broad noisy logging, secret or user-data exposure, expensive startup
     requirements, and permanent diagnostic behavior unless the user accepts the
     retained surface.
   - Before asking the user to run a probe, provide exact build or freshness
     steps, action sequence, expected log or trace signatures, failure evidence
     to capture, and cleanup criteria.
   - Do not make another implementation guess until the probe result,
     equivalent source trace, or accepted residual resolves the unknown.

10. **Handle failed attempts**
   - On repeated reports or "still broken" feedback, explain why the last fix
     did not address the symptom before proposing another fix.
   - The next fix must be tied to new proof, a source trace, or a state-space
     finding. Do not make another independent guess.

11. **Fix the smallest verified slice**
    - Prefer reproduction first. If local reproduction is not feasible, use a
      source trace, isolation proof, or exact manual proof path.
    - Keep edits close to the proven cause and existing local patterns.
    - Preserve unrelated behavior and defer adjacent hardening unless it is
      needed to close a current ledger item.

12. **Prove artifact freshness**
    - Before asking the user to retest or declaring a runtime issue fixed,
      prove the tested artifact includes the change: rebuilt package or binary,
      refreshed dev-server bundle, migrated local data, regenerated assets,
      updated lockfile, restarted process, cleared stale cache, or equivalent.

13. **Handle degraded verification**
    - Skipped, unavailable, flaky, environment-limited, or manual-only checks
      are not proof.
    - For each degraded check, choose alternate proof, narrower local proof plus
      explicit residual, user retest contract, accepted residual, or blocker.
      Choose the strongest path that can observe the current contract now:
      alternate proof first, then narrower proof with stated residual, then a
      user retest contract when the user can observe the missing behavior,
      otherwise blocker. Use accepted residual only when the user explicitly
      accepts that risk.
    - Do not count "manual smoke skipped", "not locally reproducible", or "test
      environment cannot observe this" as a pass.

14. **Use a concrete user retest contract when needed**
    - When local proof cannot observe current-scope behavior, choose now:
      alternate proof, blocker, accepted residual, or a full user retest
      contract. Do not defer with "if needed" or promise steps later.
    - Do not present the proof paths as a menu for the user to choose when the
      available evidence already determines the least risky path. If the user
      asks what to test and their environment is the only credible observation
      path, select a user retest contract and leave the ledger item blocked
      until evidence returns.
    - A user retest contract names exact setup, action sequence, expected
      observation, artifact/version freshness marker, failure evidence to
      capture, and the ledger item or matrix row each check closes.
    - The contract is incomplete if it only names what to verify. Include all
      of those fields in the same handoff or keep the item blocked.
    - When exact specifics such as the command, prompts, inputs, or paths are
      unknown, deliver the contract now with explicit stated assumptions or
      clearly labeled placeholders and say how to adapt them. Do not gate the
      contract on clarifying questions the user cannot answer; asking for those
      specifics before writing it is the same banned defer. Do not hand over
      bare `<placeholder>` commands or omit failure evidence and ledger closure
      mapping because a local detail is unknown.
    - Avoid vague requests such as "please retest" or "try it again".

15. **Review recurrence before finishing**
    - If the same class of bug, review finding, or user complaint appears at
      least twice, scan adjacent surfaces for the class of omission before
      finishing.
    - Add at least one disconfirming or negative check for the neighboring case
      most likely to have been missed.

16. **Close repository operations separately**
    - If no staging, commit, stash, reset, amend, release, or other history
      operation was requested, say none was performed when that matters for
      closure.
    - If such an operation was requested, perform the repository history
      preflight, get operation-specific consent, and keep the operation scoped
      to paths proven to belong to the repair slice.

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
