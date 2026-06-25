# Probe Escalation

Use this when bounded static work cannot distinguish the live state behind a
dynamic or runtime symptom.

## Trigger Gate

Start with bounded static triage: nearest source path, relevant tests, existing
logs, artifact freshness, expected-behavior source, and one fast disconfirming
check when available. Use a probe only when it answers the next
implementation-changing question better than more static work.

Propose a probe before another implementation edit only when any of these are
true:

- Two plausible runtime hypotheses remain after bounded source inspection.
- Static confirmation would require reading many interacting files, layers, or
  runtime paths, while one runtime observation could answer the same question.
- The original approach or root-cause hypothesis is contradicted by local
  evidence, user observation, logs, or test output.
- A prior source-only fix was verified by tests, but the user still sees the
  symptom in the real runtime.
- The unresolved unknown is live ordering, timing, identity, cleanup, artifact
  freshness, cache state, event flow, rendered output, or environment state.
- The next unknown is internal live state, not expected product behavior.

Do not add a probe solely because a symptom is dynamic, or when a source trace,
failing regression test, local reproduction, existing log, or artifact inspection
already observes the needed state. Do not use a probe to answer product intent
or expected behavior; route that to the user, spec, existing tests, or another
authoritative source.

If the probe requires the user to run a real environment, compare that burden
with the value of the observation. Prefer local or artifact-level proof when it
answers the same question.

## Probe Design

Keep probes narrow and reversible:

| Need to know | Cheap probe shape |
| --- | --- |
| Did this branch run? | One labeled log or counter at the branch boundary. |
| What state crossed a boundary? | A compact payload: ID, direction, timestamp, state enum, or artifact version. |
| Did ordering change? | Start/end labels with sequence number or stable entity ID. |
| Did cleanup happen? | Before/after size, retained ID, cache key, or rendered item count. |
| Did the runtime include the change? | Package/bundle contents, class list, hash, process start time, or runtime banner. |
| Can a test harness observe it? | Temporary assertion, focused dump, or diagnostic test that is removed or converted after the cause is known. |

Prefer existing logging or diagnostic infrastructure. Avoid broad dumps, noisy
per-frame or per-tick logs, secrets, full user payloads, expensive startup
options, and instrumentation that changes timing enough to hide the bug.

## Probe Contract

Before the probe runs, state:

- The hypothesis boundary it distinguishes.
- Where the probe is placed and why that location is authoritative.
- The expected signature for each plausible cause.
- How to build, refresh, deploy, or otherwise prove the instrumented artifact is
  the one being observed.
- Where the output appears and what evidence to capture.
- How the probe will be removed, converted into a regression test, or retained
  intentionally after it answers the question.

If the user must run the real environment, use the same concrete retest style as
`verification-handoff.md`: setup, actions, expected output or absence, failure
evidence, and the ledger item closed.

## Interpreting Results

Treat a probe result as evidence, not as the fix:

1. Record the observed signature in the debug ledger.
2. Mark which hypotheses it rules in or out.
3. Replace the probe with the smallest product fix or a focused regression test
   when feasible.
4. Remove temporary instrumentation before finishing unless the user explicitly
   wants a retained diagnostic surface.
5. Rebuild or refresh artifacts after removing the probe and prove the final
   tested artifact no longer contains temporary diagnostics.
