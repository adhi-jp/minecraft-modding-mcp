# Verification Handoff

Use this when local proof is incomplete, runtime artifacts are involved, or the
user must verify behavior in their own environment.

## Artifact-Freshness Gate

Before declaring a runtime issue fixed or asking the user to retest, prove the
tested artifact includes the change. Pick the artifact that matches the user's
actual observation path:

- Source-to-build: package, binary, bundle, generated asset, compiled schema, or
  lockfile includes the changed source.
- Build-to-runtime: server restarted, dev server refreshed, worker reloaded,
  container rebuilt, migration applied, cache cleared, or deployed version
  updated.
- Runtime-to-user: the user-visible environment, tenant, host, device, account,
  or feature flag points at the fresh artifact.

If freshness cannot be proven, leave the ledger item `blocked` or provide a
user retest contract that includes a freshness marker.

## Verification-Degradation Gate

Skipped, unavailable, flaky, environment-limited, and manual-only checks are
non-proof. For each degraded check, choose exactly one:

- Alternate proof: another automated or source-trace check observes the same
  contract.
- Narrow local proof plus residual: local proof covers part of the matrix, and
  the uncovered part is stated as residual risk.
- User retest contract: the user can observe the missing environment or device.
- Accepted residual: the user explicitly accepts the remaining risk.
- Blocker: no credible proof path exists yet.

Choose the strongest proof path that can observe the current contract now:
alternate proof first, then narrow local proof plus residual, then a user
retest contract when the user can observe the missing behavior, otherwise
blocker. Accepted residual requires explicit user acceptance. Do not hand the
user a menu of proof paths when the available evidence already determines the
least risky path.

Do not mark a check as passed because it was skipped or impossible in the
current environment.

## User Retest Contract

When local proof cannot observe current-scope behavior, choose now: alternate
proof, blocker, accepted residual, or a concrete user retest contract. Do not
defer with "if needed".

If the user asks what to test and their environment is the only credible
observation path, select the user retest contract now and keep the ledger item
blocked until evidence returns.

1. Setup: environment, version, account, feature flag, data, artifact freshness
   marker, and any cache/restart condition.
2. Actions: exact sequence to perform, including variants if the matrix needs
   more than one case.
3. Expected observation: what should be visible, logged, persisted, or absent.
4. Failure evidence: screenshot, log line, request ID, timestamp, input value,
   exported file, artifact hash, or reproduction notes to capture.
5. Ledger closure: which symptom or matrix row each check closes.

The contract is incomplete if it only says what needs proof. Include all five
fields in the same handoff, or keep the ledger item `blocked` until a credible
proof path exists.

When exact specifics such as the command, prompts, inputs, or paths are unknown,
fill the contract now with explicit stated assumptions or clearly labeled
placeholders and say how to adapt them, rather than asking the user to supply
those specifics before you write it. Placeholders must not stand alone as
copyable commands; they still need expected observation, failure evidence, and
the ledger item or matrix row they would close.

Avoid "please retest", "try it again", and promises to provide steps later. The
user should know exactly what to do and what result would prove or reopen the
fix.
