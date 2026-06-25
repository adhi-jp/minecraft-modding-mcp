# Failure Pattern Checklist

Use this file when the plan touches a high-risk surface. The checklist is
**selective**: apply only the sections that match the change. Pasting the full
10-section checklist into every plan is a regression; empty sections drown the
actual blockers.

## Source of Truth

The 10 categories below are the authoritative content for this skill. Future
readers and drift checks resolve against this file alone; the shipped package
does not depend on any external artifact for category authority.

Adding categories not listed below, or rewriting category names, is a scope
expansion that requires a new user requirement. See the success-criteria freeze
in `references/plan-boundary-controls.md`.

## How to Apply

1. Walk the plan surface and pick **only** the sections whose preconditions
   match. Most plans hit one or two sections; four or more usually means the
   slice should split instead of rendering the full list.
2. For each picked section, answer the **planning question** in the plan body
   and cite the **evidence needed to clear** it. `Primary source` or `Local
   investigation` clears the question; `Unproven` stays triaged in `Risks and
   unproven items` with `Phase relevance`.
3. Do **not** emit empty checklist headings to satisfy structure. If the change
   does not touch a category, the category does not appear in the plan output.
4. In a `light` plan, the checklist contributes blockers and proof checks — it
   does not need its own subsection. In a `strict` plan, picked sections may be
   grouped under a single `Failure-pattern checks` heading or folded directly
   into existing fact / blocker / test sections, whichever keeps blockers
   adjacent to the recommendation.
5. Record an applicability summary per `Applicability Record` below so the
   completion gate from `references/plan-boundary-controls.md` has an auditable
   artifact.

## Applicability Record

The completion gate from `references/plan-boundary-controls.md` requires
"applicable failure-pattern checklist sections cleared". Without a visible
record of considered sections, an oversight can clear the gate by accident, such
as silently omitting A.4 migrations on a config change.

Required record shape:

- **`light` plan** — a one-line summary under `Plan integrity gates` /
  `High-risk controls`: `Failure-pattern check: applied <selected category IDs>;
  not selected <adjacent category IDs> — <one-line evidence-backed reason>.` If
  no sections apply, the line still renders: `Failure-pattern check: not
  applicable — <slice surface description that justifies the no-section
  verdict>.`
- **`strict` plan** — a small subsection (or addition to the existing fact /
  blocker section) listing each selected section with its planning question's
  evidence label, plus a short non-selection rationale for **adjacent / nearby**
  categories that a reviewer might reasonably expect to fire (typically 0-3
  adjacent categories per slice). Example: a slice that selected `A.1 lifecycle
  and initialization order` should explicitly note whether `A.2 exception safety
  and retry` and `A.3 shared state and multi-consumer behavior` were considered.

Adjacency is judged by surface overlap, not by category number. The record lets
a reviewer or dry-run test verify that the planner walked the relevant surface.
Pasting the full 10-category list to satisfy this rule is forbidden because it
defeats the selectivity rule from step 1.

Categories far from the slice's surface need no rationale and may be silently
omitted, such as A.8 `build / release / packaging` for a pure documentation
diff. The record covers **near miss** failure modes, not distant ones.

## Sections

### A.1. Lifecycle and initialization order

**Apply when**: the change adds, removes, or reorders subscribers; reorders module init; touches shutdown, reload, or cache-invalidation flow; or installs late-binding hooks.

- Planning question: How does the system behave when subscribers register **after** the event source is initialized, when initialization is partial, or when shutdown runs in a different order than startup? What does the reload path look like?
- Evidence needed to clear: `Primary source` for the framework's documented init/shutdown contract, **or** `Local investigation` showing the late-subscriber, partial-init, and reload paths in the actual workspace.

### A.2. Exception safety and retry

**Apply when**: the change crosses a try/finally boundary, adds retry, fans out to hooks that may throw, or has half-applied state on failure.

- Planning question: What does the system look like after an exception thrown by an inner hook, a network call, or a peer subscriber? Are postfix/finally guarantees actually firing? Is retry idempotent at the boundary the retry executes against?
- Evidence needed to clear: `Primary source` for the language's exception-propagation rules and the framework's hook-error contract, **or** `Local investigation` of the failure path showing the post-exception state.

### A.3. Shared state and multi-consumer behavior

**Apply when**: the change reads or writes a static field, singleton, global event bus, cross-thread shared structure, or any state that multiple consumers observe concurrently.

- Planning question: Is concurrent read/write serialized correctly? Are cross-thread visibility guarantees explicit? Do multiple consumers see consistent ordering, or is consumer order an accidental property of registration time?
- Evidence needed to clear: `Primary source` for the runtime's memory model and the bus/queue's delivery semantics, **or** `Local investigation` exercising the multi-consumer path locally.

### A.4. Persisted config and migrations

**Apply when**: the change adds a config field, changes a default, adds an opt-out, or changes the on-disk schema.

- Planning question: What does an existing user with no value for this field see? What does an existing user who explicitly opted out see? Is forward and backward compatibility documented? Is migration rollback possible?
- Evidence needed to clear: `Primary source` for the project's config-migration policy, **or** `Local investigation` of the upgrade and rollback paths against the existing schema.

### A.5. Ownership, identity, and persistence

**Apply when**: the change touches primary keys, dedupe keys, foreign keys, owning vs. borrowing references, or anything that survives a persistence round-trip.

- Planning question: After a save/reload cycle, does the entity have the same identity? Are there orphaned copies, duplicate entries, or dangling references? Who owns the lifetime of the persisted record?
- Evidence needed to clear: `Primary source` for the storage layer's identity guarantees, **or** `Local investigation` of the round-trip showing identity preservation (or its absence).

### A.6. Trust boundary and temporal correlation

**Apply when**: the change accepts payloads from an untrusted client, replays events through a FIFO, takes a snapshot relative to writes, or correlates events across a trust boundary.

- Planning question: Where exactly is the trust boundary? Is input validated at the boundary, not after it? Are FIFO/ordering guarantees preserved across the boundary? Does snapshot timing line up with writes, or is there a window where snapshot-vs-write order matters? Is replay protection in place?
- Evidence needed to clear: `Primary source` for the boundary's documented trust contract and ordering guarantees, **or** `Local investigation` of the boundary-crossing path with adversarial inputs.

### A.7. Accounting, budgets, and counters

**Apply when**: the change touches a counter, quota, monotonic invariant, or batch boundary.

- Planning question: Is the counter monotonic where the design assumes it is? Can the counter drift from the underlying truth (e.g., due to retries, partial commits, or concurrent decrement paths)? Does cap/quota enforcement off-by-one when batches are split?
- Evidence needed to clear: `Primary source` for the counter's invariant (where it is documented) **or** `Local investigation` showing the counter and the underlying truth agree across the batch boundaries the change touches.

### A.8. Build, release, and packaging

**Apply when**: the change bumps a manifest version, alters an entry-point command, changes packaging artifacts, or touches a release-only path that differs from the dev path.

- Planning question: What is the **authoritative** source for build, release, and packaging commands here? Is the manifest version bump matched in every place that reads it? Is the artifact reproducible? Does the release path execute the same instructions as the dev path?
- Evidence needed to clear: `Primary source` from `AGENTS.md`, CI configuration, project scripts, packaging manifests, or release runbooks. **Memory or generic recall does not count.** When the authoritative source is not available in this workspace, `Local investigation` of the build/release path is the fallback.

### A.9. Tool capability and verification method

**Apply when**: the change relies on a CLI flag, plugin option, MCP tool, or third-party command being available, behaving as expected, or accepting a particular argument.

- Planning question: What does the tool actually expose at the version installed in this workspace? What is the authoritative source for the capability claim? What is the proof method for "this command/flag/option exists"?
- Evidence needed to clear: `Primary source` from the tool's own help output, vendor docs, or upstream source, **or** `Local investigation` running the tool with the proposed arguments. "I remember this flag exists" is `Unproven`.

### A.10. Plan drift and dependency baseline

**Apply when**: the plan spans multiple phases, depends on a particular dependency version, or has imported scope from review feedback.

- Planning question: Are the assumptions made in earlier phases still true at the point this phase executes? Has any dependency version baseline shifted silently? Has any scope item entered the plan without a recorded user request?
- Evidence needed to clear: `Local investigation` of dependency baseline (lockfile, manifest, or vendor metadata in the current workspace) and a walk of recent additions through the plan-boundary firewall in `references/plan-boundary-controls.md`. Review-driven scope additions must clear the success-criteria freeze.

## Output Discipline

- Each picked section appears in the plan output with the planning question
  answered and the evidence labeled.
- Unanswered questions become `Unproven` items with explicit impact, `Phase relevance`, fastest proof path, and revisit trigger.
- Per-question walkthroughs are not enumerated; the resulting facts, blockers,
  and tests carry the substance. The Applicability Record is the separate audit
  hook the completion gate reads; it does not duplicate per-question content.
