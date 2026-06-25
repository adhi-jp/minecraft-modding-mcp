# Commit Messages

## Core Rule

Write commit messages for future agents and maintainers, not for replaying the
diff. The subject says what changed at the behavior or contract level. The body,
when needed, preserves the reason, constraints, compatibility, verification,
tradeoffs, and deliberate non-goals that the patch cannot reliably explain.

If the available evidence does not explain why the change exists, write a
smaller message from observable behavior and supplied context. Do not invent an
incident, customer impact, performance result, security benefit, rollout status,
or risk reduction.

## Before Drafting

Inspect available staged or target diff, recent local commit style, and supplied
issues, plans, changelog entries, release notes, incidents, or review findings
before drafting. Identify the future reader's likely question: why the change
exists, what contract changed, how to migrate or roll back, what remains risky,
or what proof matters.

If one message bundles multiple changes, name the shared public contract,
workflow, rollback path, review finding, or verification surface. Do not use
same-plan or same-session provenance as the cohesion reason.

## Subject Shape

Follow the repository's recent style. For Conventional Commits, prefer:

```text
type(scope): outcome
```

Use documented or recent `type` values. If none are available, common types are
`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`,
`style`, and `revert`. Do not invent generic types such as `change`.

Name the achieved behavior or contract, not the editing act:

- Good: `fix(cache): count remapped jars in eviction limits`
- Weak: `fix(cache): update source-service and tests`
- Good: `test(search): split source-service search coverage`
- Weak: `test: move tests into another file`

When the task asks for the commit message, return the message as raw commit
text. Do not wrap it in a Markdown fence, preface it with `Here is`, or label it
as an example unless the user explicitly asks for explanation or a fenced sample.
Run evidence classification internally; do not output proof-source analysis,
local-artifact notes, headings, separators, or rationale before or after the
message. Those wrapper bytes become part of the delivered artifact and can be
copied into git history.
Fenced snippets in this reference are examples, not output wrappers for real
commit messages.

Reason: Markdown fences become message bytes when copied into `git commit` and
can contaminate subjects, bodies, or trailer parsing.

- Bad: a fenced block around `fix(http): preserve retry headers`.
- Good: no wrapper; start directly with `fix(http): preserve retry headers`.

## Body Value

Use a body only when it adds durable value beyond the subject and diff summary.
Useful body content includes:

- Triggering failure mode, user report, review finding, release constraint, or
  compatibility promise.
- Public API, CLI, schema, data, UI, workflow, rollback, or migration contract.
- Chosen design and important rejected alternative.
- Known limitation, accepted risk, deferred follow-up, or intentional non-goal.
- Verification signal that changes confidence or review risk.

Classify candidate body details before drafting:

- Preserve context the diff cannot recover: triggering failure or review
  finding, public contract, design constraint, migration or rollback guidance,
  compatibility, deliberate non-goals, accepted risk, and meaningful
  verification.
- Cut or compress file-by-file inventories, helper/import/test-case lists,
  generic benefits, same-plan or same-session provenance, and private
  implementation names. Keep a private name only when it is a public contract,
  diagnostic output, command, env var, error code, API, or the only durable
  search anchor.

For non-trivial bodies, stable labels can help scanning: `Context`, `Decision`,
`Behavior`, `Compatibility`, `Verification`, and `Out of scope`. Use only labels
with real content; omit empty sections.

Preserve obligation strength in body sections. Migration and compatibility
guidance often uses `should`, `may`, `can`, `must`, `required`, or `optional`
deliberately; do not upgrade advice into a requirement or soften a requirement
into advice unless the source or repository convention states that change.

Section labels do not change modality.

- Bad: `Migration: callers must handle null or fall back to email` when the source says `should`.
- Good: `Migration: callers should handle null or fall back to email`.

Omit file-by-file inventories, helper lists, individual test cases, and
line-level mechanics unless the name is a public contract, diagnostic output,
command, environment variable, error code, API name, or the only durable search
anchor.

For small commits, a subject-only message is often right. Mechanical syncs,
routine dependency bumps, generated lock updates, catalog refreshes, and
lockfile-only changes should have no body or one limited-scope sentence unless
the supplied context carries behavior, risk, or compatibility information.

## Durable References

Apply the fresh-clone-reader test. A future reader should be able to resolve each
reference from committed files, remote repository metadata, issue or review
systems, release artifacts, public docs, primary sources, or stable identifiers.

Keep durable references such as issue IDs, incident IDs, ADRs, release versions,
public API names, error codes, commands, env vars, committed paths, and commit
SHAs when they help audit, rollback, or search.

Translate local-only provenance into the durable fact it proves, or omit it:
private branch names, local notes, temporary comparison output, unpublished
checkout paths, private dependency paths, tool-session labels, and chat-turn
context should not become reader context.

Verification references must pass the same durability test. They should be
resolvable from git-managed files, remote repository metadata, issue or review
systems, release artifacts, public docs, primary sources, stable commands, or
stable identifiers. Git-unmanaged local generated artifacts, ignored local
result files, temporary run output, local-only run IDs, and private tool-session
records are not durable proof even when their paths look project-relative or
their filenames sound audit-relevant.

When local-only proof supplied a useful result, preserve the durable command,
contract outcome, committed source path, public identifier, or explicit absence
status instead. Use statuses such as `raw local report not committed`,
`benchmark not durably recorded`, or `not measured` when no durable proof exists;
do not paste the local artifact path as the evidence.

Committed summaries, changelog entries, or working notes can be named as changed
files or contract sources, but do not use them to launder local-only proof
details into commit history unless that committed artifact is itself the changed
contract being described.

## Verification Provenance

Verification prose should preserve stable proof, not machine-specific setup.
Keep stable tool, command, or suite names; public env var names; committed
project paths; documented install paths; audit-relevant filenames; and outcomes
when they help future review.

Omit or parameterize host-local absolute paths, private env values, temporary
files, unpublished dependency checkouts, local run labels, and transient tool
session output. If the exact invocation is dominated by local setup, summarize
the durable proof instead of making that setup required context.

A `Verification:` section is selected proof, not an executed-command log.
Include proof that materially changes review confidence, rollback or risk
assessment, or contract completeness:

- High-signal proof: tests, builds, type checks, lint checks, schema or metadata
  validation, migration or dry-run checks, security/privacy/data-loss checks,
  release or package checks, and checks tied to the changed public contract.
- Compressible proof: long ad hoc predicates or groups of equivalent probes
  whose durable meaning is shorter and clearer than the exact command text.
- Low-signal proof: search or string-presence commands, file-list checks, and
  metadata probes that only restate diff-visible changes or inventories.

Keep exact commands when the invocation is a useful rerun or audit anchor, such
as a named test suite, documented build, schema validator, migration dry run,
security scanner, or format/whitespace guard. Summarize long predicates or
equivalent command groups into the durable outcome when exact bytes are not
needed for rerun or audit. Omit diff-obvious search probes unless they prove a
non-obvious cross-file, generated, packaging, release, or registration contract.

Avoid reducing useful proof to vague text like `tests passed` when the stable
suite, command, guardrail, or outcome matters.

## Common Shapes

### Thin evidence

When the prompt gives only a diff summary and an absence status, keep the message
small. Preserve supplied absences such as `tests not run`, `no benchmark
supplied`, `no rollout plan`, or `no advisory supplied`. Do not ask for more
context unless the current message would be misleading without it.

### Mechanical sync

For generated files, lock updates, catalog refreshes, or upstream skill syncs
with no behavior details, prefer a subject-only `chore` or one short body
sentence that states the limited known scope. Even in a subject-only message,
preserve the supplied top-level scope: catalog refresh, deprecated-skill
replacement, generated metadata, lock/hash updates, or similar mechanical
surfaces. If that scope does not fit cleanly in the subject, add one short body
sentence. Do not infer behavior from package names or changed hashes.

### i18n and localization

Name the locale and user-facing copy intent. Preserve locale tags, file paths,
message keys, source strings, commands, env vars, and identifiers. State when
source strings or code are unchanged. Do not turn copy clarification into a
product behavior, security, all-locales, or backend change claim.

### Monorepo and multiple packages

Name the shared reason the packages move together: shared API shape, generated
client contract, version alignment, shared runtime behavior, shared rollback or
migration path, or one verification surface.

Mention package names only as useful anchors. Split unrelated package edits when
the only connection is that they were in the same plan or touched in the same
session.

For shared plumbing, name the stable workflow or contract before naming internal
symbols. A prompt-supplied component, prop, helper, or file name is not durable
unless it is public API, diagnostic output, or the only useful search term.

### Dependency updates

Include the supplied reason: security advisory, runtime compatibility, framework
peer range, CI requirement, API migration, or release-note contract. For routine
or lockfile-only bumps, keep the message subject-only or one sentence. Do not
claim security, performance, or compatibility from a version bump itself.

### Performance work

Name the workload and preserved constraints: hot path, corpus, cache boundary,
ordering contract, benchmark, resource ceiling, or compatibility invariant.
Include measured deltas only when supplied. Do not imply a benchmark or speedup
from implementation mechanics. Do not infer the previous implementation,
bottleneck, or slowdown from the new implementation shape unless the source
states it.

- Bad: `compile_many previously serialized output writes.`
- Bad: a body bullet that lists queue outputs, dedupe parent dirs, and raise worker pool cap 8 to 16.
- Good: write the workload once, then preserve constraints: `compile_many` writes finalized outputs in parallel; QuestVM serialization remains input-ordered for Asterfall save compatibility.

### CI, build, and publishing automation

Preserve the failing runner, toolchain, permission, package-manager, registry,
or trusted-publishing constraint. Explain the narrow fix instead of listing YAML
steps. Do not claim deployment, publication, release, or security hardening
unless that action or evidence is supplied.

### Security, privacy, and data-loss fixes

Name the concrete failure mode, threat boundary, destructive ordering,
credential/store invariant, fail-closed behavior, or recovery anchor. Keep exact
error codes, env vars, file names, commands, or store names when they matter for
audit or recovery. Do not turn a local invariant into a broad `secure`,
`privacy-safe`, `data safe`, exploit, incident, or advisory claim.

### Release commits

Follow the repository's release subject and trailer convention. Summarize the
release contract: version, notable scope, breaking-change status, migration
status, and verification. Do not paste the changelog, add unreleased behavior,
or claim publishing, deployment, rollout, shipping, or release completion unless
that happened.

Prefer subjects such as `chore(release): 1.4.0` or
`chore(release): prepare v1.4.0` for release preparation. Use body verbs such as
`Prepares`, `Promotes Unreleased entries into`, `Records`, or `Includes`.

## Formatting And Transport

Keep adjacent bullets in one logical list on consecutive lines. Blank lines
between bullets mean multi-paragraph list items or section breaks; they do not
replace the required blank line before footer trailers.

Footer examples in this reference describe the stored message shape. When an
active commit-execution skill is adding or repairing an authorship trailer,
follow that skill's command transport rule; for `vibe-commit`, that means using
`git commit ... --trailer`, not treating a hand-written footer block as a
substitute.

When required trailers such as `Co-Authored-By` or `Signed-off-by` are present,
put them in a final footer block separated from the prose body by a blank line.
Avoid ending the body with a final single-line `Key: value` paragraph such as
`Verification: ...` immediately before adding trailers with `git commit
--trailer`; Git may parse that line as part of the trailer block. Prefer a body
section with bullets:

```text
Verification:
- `git diff --check` passed.

Co-Authored-By: Codex <noreply@openai.com>
```

Do not split multiple verification commands into separated `Verification: ...`
paragraphs:

```text
Verification: python3 -m unittest tests/test_eval_runner.py

Verification: python3 skills/skill-eval/scripts/eval_runner.py validate evals/skill-quality/evals.json
```

Use one `Verification:` section with adjacent bullets instead:

```text
Verification:
- `python3 -m unittest tests/test_eval_runner.py`
- `python3 skills/skill-eval/scripts/eval_runner.py validate evals/skill-quality/evals.json`
```

When passing a multi-line message to commit execution, use one message buffer,
message file, editor buffer, or equivalent transport. Do not pass one
`git commit -m` argument per line or per bullet; each `-m` value becomes a
separate paragraph and can add unintended blank lines between adjacent bullets.

## Final Check

- Does the subject name the outcome rather than the editing act?
- Did available diff, local style, and supplied durable context shape the
  message?
- Does the body preserve only context the diff cannot recover?
- Did migration, compatibility, rollback, and verification wording preserve the
  source modality?
- Are unsupported impact, test, security, performance, or rollout claims absent?
- Are durable anchors kept and local-only provenance removed or translated?
- Are required trailers separated from prose, with compact adjacent bullets?
- Would the message still make sense in a fresh clone without chat context?
