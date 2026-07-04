# Changelog Entries

## Two Layers

When `vibe-writing` is asked to draft, revise, or review a changelog or release
notes, operate in two layers:

- Format layer: which structure the changelog uses. This belongs to the
  repository and its user. Detect the existing format and conform to it; never
  restructure it on your own initiative.
- Content layer: what each entry says. This is the agent-assisted coding strategy below,
  and it applies under whatever format the repository already uses.

Keep the layers separate. The content rules never authorize changing a
repository's format, and conforming to a format never lowers the content bar.

## Format Layer: The Repository Owns The Format

Changelog format is the repository's decision, not the agent's. Resolve the
format by this precedence, highest first:

1. Explicit user instruction for this task.
2. Repository-defined policy: a changelog policy file or section (`AGENTS.md`,
   `CONTRIBUTING`, a changelog config), or a format header inside `CHANGELOG.md`
   (for example a `The format is based on ...` line).
3. The existing `CHANGELOG.md`'s observable conventions: its section headings,
   category names, entry shape, ordering, and date format.
4. The agent-assisted coding fallback structure below, used only when the repository
   defines no format.

`AGENTS.md` is named here only as one example of a tier-2 policy source; any
repository policy file or changelog config wins at that tier.

Conform to the detected format. Do not restructure, migrate, reformat, re-sort,
re-categorize, or rename the sections of an existing changelog on your own
initiative, even when another convention looks cleaner or more consistent.
Changing a repository's changelog format requires explicit user instruction;
absent that instruction, match what the repository already does.

When the requested deliverable is a changelog entry or section, that requested
slice is the whole answer. Emit only the changelog-shaped artifact: no process
preface, horizontal rule, placement instruction, change summary, or note about
having read the skill/reference. Keep the changelog artifact language from the
explicit instruction, existing entry, file locale, or repository convention
unless the user asks for translation.

When the repository defines no format, propose the fallback structure below as a
starting point and let the user decide whether to adopt it. Do not silently
impose it.

### Fallback structure (propose only when undefined)

Offer Keep a Changelog mechanics, chosen for agent-workflow utility rather than
human-reader convention:

- An `## [Unreleased]` buffer that accumulates entries between releases, so an
  agent can append to it without first deciding a version.
- Dated release sections `## [<version>] - <YYYY-MM-DD>`, promoted from
  `Unreleased` at release time.
- Category groups `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
  `Security`. Keep `Security` so security-relevant deltas have a fixed home.
- Latest entries first; ISO-8601 (`YYYY-MM-DD`) dates.
- No raw commit-log or diff dumps.

The deferred-version buffer and mechanical accumulation are why these mechanics
suit an agent workflow. Adoption is the user's decision; present it as a
proposal, not a change you have already applied.

## Content Layer: Write For The Next Agent

This is the first-principles agent-assisted coding content strategy. It applies under any
format.

Default reader: the next agent resuming the work with zero prior context, with
the human supervisor as the second reader. The changelog is a contract and
evidence log for that reader, not human-facing release marketing. This departs
from the "for humans, not machines" premise of the source specs (see Sources);
adopt the next-agent reader as the agent-assisted coding default. It is consistent with
this skill's LLM-first default in `SKILL.md`.

Each entry should carry:

- The contract or behavior that changed: what an observer or caller now sees
  differently.
- The trigger or reason, with evidence: the failure mode, review finding,
  requirement, or constraint that caused the change.
- Migration or rollback guidance, when the change warrants it.
- Verification status: the measured result, or an explicit `not measured` /
  `tests not run` when there is none. Absence is information; state it.
- Durable anchors: file paths, symbols, identifiers, issue IDs, error codes, or
  API names a later reader can resolve from committed files or stable systems.
  No prompt-only or session-local references (`above`, `as requested`, a local
  run label, an unpublished branch).

Changelog verification evidence must be durable, not merely project-relative.
Use evidence a later reader can resolve from committed files, remote repository
metadata, CI/check systems, release artifacts, public docs, primary sources,
stable commands, or stable identifiers. Git-unmanaged local generated artifacts,
ignored eval workspace reports, temporary run output, local-only run IDs, and
private tool-session records are not changelog evidence even when their paths
look like repository paths or their filenames sound audit-relevant.

When a local generated run supplied useful signal but has no durable record,
translate it into the stable command and durable outcome that can be checked, or
state the absence explicitly: `provider run not durably recorded`, `benchmark
not durably recorded`, `raw local report not committed`, or `not measured`.
Do not include local workspace paths, iteration IDs, pass-rate deltas, sanity
status, excluded-run counts, or remaining assertion misses from git-unmanaged
generated reports unless the report itself is committed, published, or otherwise
available through a stable system the next reader can resolve.

Do not downgrade explicitly supplied current verification facts merely because
they look like eval-run facts. If the source material itself states the current
verification slice, such as agent/model, compared configs, run count, pass rates,
sanity status, or `error_run_count`, and it does not tie those facts to a
git-unmanaged local artifact as their only source, preserve the supplied facts
as evidence. Remove or translate only the non-durable provenance: workspace
paths, local run IDs, private transcript labels, and raw local report locations.

Discipline for every entry:

- Falsifiable and evidence-bound. Do not invent impact, security, performance,
  reliability, or rollout claims the change does not support. If the evidence
  does not support a benefit, do not state one.
- Do not pre-assign the next version. Describe the behavior; the release decides
  the version. (This matches the format layer's `Unreleased` buffer.)
- Write the entry in the same slice as the behavior change, while the contract
  delta and its evidence are still known.
- Do not use `CHANGELOG.md` as an iteration log. For in-progress skill quality,
  eval, review, or release-preparation work, keep only the current contract
  delta, the strongest durable evidence, the latest verification status, and
  any unresolved accepted risk. When later runs or reviews supersede earlier
  readings, update or collapse the existing entry instead of appending
  chronological run commentary.
- Keep assertion-level analysis, grader evidence, run-by-run diagnosis, and
  release-trimming investigation notes in eval workspaces, PR or review notes,
  or working notes unless that detail is itself the behavior contract being
  released. Do not park temporary investigation logs in `Unreleased` on the
  assumption that a release pass will prune them later.
- Attach a migration note only when the change is genuinely breaking. A
  no-impact internal refactor usually belongs in commit history, not the
  changelog; do not inflate it into a user-visible entry.
- Never copy a Conventional Commit prefix (`feat:`, `fix:`) or dump git-log
  lines or PR titles into an entry. Convert commit metadata into a
  contract-delta statement of what changed.

Reused from the source specs' entry discipline, under the next-agent reader:
state impact, keep each entry self-describing, lead a genuinely breaking change
with a `**Breaking:**` marker, attach references, remove noise, merge related
changes, and skip no-ops and reverts.

## Changelog Entry vs Commit Subject

A changelog entry and a Conventional Commit subject are different artifacts:

- A commit subject names the change at commit time in `type(scope): outcome`
  form for the commit history. See `references/commit-messages.md`.
- A changelog entry is a standalone contract-delta record for the next reader,
  with no `type:` prefix, that can aggregate several commits or omit commits that
  produced no reader-visible delta.

Do not paste commit subjects into the changelog, and do not weaken the
commit-message rules in `references/commit-messages.md`. Convert between the two
deliberately.

## Authority

This guidance controls changelog wording only. It does not authorize commits,
staging, releases, version bumps, or moving `Unreleased` entries into a release
section. Those remain with the active workflow and the repository's release
policy.

## Sources

Source material, adapted rather than adopted wholesale:

- Keep a Changelog 1.0.0 — https://keepachangelog.com/en/1.0.0/
- Common Changelog — https://common-changelog.org/

Both frame the changelog as "for humans, not machines." The agent-assisted coding content
layer deliberately departs from that premise toward the next-agent reader, while
reusing their structural mechanics (format layer) and their entry discipline
(impact-first, self-describing, breaking-first, references, anti-noise, and no
Conventional Commit prefixes or git-log dumps).
