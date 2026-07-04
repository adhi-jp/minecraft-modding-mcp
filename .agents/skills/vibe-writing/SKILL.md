---
version: 1.1.3
name: vibe-writing
description: Use when the primary task is writing, revising, reviewing, or critiquing agent-assisted coding development text, source-code comments or docstrings, README/docs, CHANGELOG/release notes, PR descriptions, UI copy, chat replies, progress updates, final summaries, or git commit messages, especially when text must be LLM-readable, meaning-preserving, format-bound, language-aware, or evidence-bound. Treat incidental wording inside another active workflow as auxiliary.
---

# Vibe Writing

## Overview

Write durable development text for the reader who will use it next. In
agent-assisted coding work, the default reader is an LLM that needs precise contracts,
stable anchors, and explicit evidence. Optimize for human readers only when the
artifact's main reader is human.

This skill controls wording quality and message content. It does not authorize
commits, releases, staging, PR submission, template changes, or workflow
shortcuts.

When another workflow is active, use this skill only as auxiliary wording
guidance unless the user asks for a standalone writing deliverable. Incidental
progress updates, final summaries, checkpoint message polish, or README/changelog
phrasing inside planning, execution, review, debug, or release work remain
subordinate to that workflow's authority, stop gates, verification, release
policy, and commit rules.

## Scope Boundaries

Do not rewrite text whose value is exactness: verbatim tool or log output,
protocol snippets, quoted source, or a bare acknowledgment. Relay it unchanged
or answer around it. For transient progress text, stay brief and do not polish
raw logs into summaries unless asked.

## Reader Priority

Default to LLM-optimized writing for agent-assisted coding development text:

- State the operational fact, contract, decision, constraint, or proof directly.
- Prefer stable identifiers, commands, paths, field names, issue IDs, API names,
  and exact error text when they are useful anchors.
- Remove hollow transitions, decorative preambles, and wrap-up phrases when they carry no operational meaning.
- Keep unsupported motivation, benefits, rollout claims, and implied causality
  out of the text.
- Make absence explicit: `tests not run`, `not measured`, `no rollout plan
  supplied`, `not provided`, and similar statuses are real information.

Use human-optimized prose only when the artifact's main reader is human, such as
end-user documentation, user-facing UI copy, support copy, public release notes,
or a README section intended for people learning the project. Docs and guides
can still be LLM-first when their main reader is an LLM agent or developer tool.

## Evidence And Meaning

Do not invent context. Do not add unsupported reasons, goals, outcomes, roadmap
claims, user impact, business value, implementation rationale, tests,
performance/security impact, rollout status, or risk reduction.

Treat supplied capabilities as capabilities. Do not rewrite `supports X` or a
feature name into a cause, purpose, effect, proof, or user benefit unless the
source states that relationship.

Preserve meaning when editing or summarizing. Keep:

- Facts, scope, audience, terminology, and order that matters.
- Conditions, exceptions, warnings, limitations, and required actions.
- Modality. `must`, `should`, `may`, `can`, `required`, `optional`, and
  `recommended` encode different obligations.

Do not over-normalize. Preserve useful local terms, order, tone, and examples when they are search anchors, workflow labels, public contracts, or supplied domain language.
Do not turn `header handoff`, `sample refresh`, or a useful prop or API name into a generic label such as `request metadata flow`.

If a cleaner sentence changes who must do what, when a rule applies, what is
allowed, what is optional, or what happens on failure, it is wrong.

## Language And Format

Choose language by this precedence:

1. Explicit user instruction, including translation or localization requests.
2. Existing artifact language.
3. Filename locale markers such as `README.ja.md` or `docs/de_de/guide.md`.
4. Project convention.
5. English.

Preserve file paths, commands, identifiers, environment variables, locale tags,
message keys, product names, canonical strings, and code unless the user
explicitly asks to translate or rename them. Chat replies follow the user's
active conversational language unless the requested artifact has its own
language contract.

When the requested deliverable is the artifact itself, return the artifact
directly. Do not add process notes, source-read confirmations, "here is"
preambles, separators, change summaries, or placement instructions unless the
user asks for an explanation. The artifact's explicit language, existing
language, filename locale marker, or repository convention wins over chat
language. Internal evidence checks, source classification, and proof-source
decisions stay out of the delivered artifact unless the user explicitly asks for
that explanation.

For rewrite, polish, localization, comment, docstring, policy, template, and
other artifact-editing tasks, wrapper text is part of the output and can be
wrong even when the artifact body is right. Do not introduce task-frame phrases
such as `provided text`, `given context`, `as requested`, `rewritten below`, or
`made friendlier` around the artifact unless the requested artifact itself
requires that wording. Emit the revised artifact, or a requested change list,
without prompt-only provenance.

For LLM-first text, use line breaks as structure, not as an 80-column habit.
Keep short examples, commands, commit-message snippets, and compact list items on one physical line when the break would add no meaning.
Preserve required line breaks in verbatim output, quoted source, templates, logs, protocol payloads, JSON, and commit-message transport.

Treat commands as commands. Preserve `npm install`, `cargo test`, `pnpm build`,
and similar invocations without adding what they do, prove, fetch, generate, or
validate unless the source states it.

This applies in localized docs too: if the source only says `Run npm install`,
do not expand it to `Run npm install to fetch dependencies`.

Exact formats win. JSON, protocol payloads, parser-sensitive templates, PR
templates, release formats, and other machine-readable shapes must keep their
required structure with no extra prose, headings, Markdown fences, or invented
fields.

## Artifact Notes

### Source-code comments and docstrings

Preserve non-obvious rationale, invariants, compatibility rules, migration
notes, side effects, failure modes, intentional non-goals, performance tradeoffs,
and external constraints. Remove comments that only echo names, signatures,
types, or immediately visible code.

Public APIs may need intent, contracts, invariants, and non-obvious usage.
Internal comments should orient the next maintainer only when the code itself
does not.

### README, docs, guides, and UI copy

Match the artifact's reader. For human-first text, lead with what the reader can
do and keep the prose direct. For LLM-first docs or guides, prefer contract
clarity, stable anchors, and exact commands over editorial polish.

Do not add setup steps, support channels, availability promises, safety
rationales, or business value unless the source provides them.

For support or policy copy, create warmth by clarifying supplied facts. Do not
add response guarantees, escalation paths, new channels, reassurance claims, or
security reasons.

### CHANGELOG and release notes

Follow the project's style. Each entry should answer what changed for the
reader. Internal refactors without user-visible impact usually belong in commit
history, not a changelog. Do not inflate a narrow implementation change into a
broad reliability, security, performance, or compatibility claim. Do not use
`CHANGELOG.md` as an iteration log; fold superseded run notes into the current
contract delta and latest verification status.

For changelog or release-note work, read `references/changelog.md` when the task
involves entry content quality, the next-agent contract-log reader model,
detecting and conforming to a repository's existing changelog format,
breaking-change presentation, durable references, local generated proof-source
boundaries, or converting commit or PR metadata into a changelog entry. That
reference separates the format layer (the repository owns the format; detect and
conform, never silently restructure it) from the content layer (write each entry
as a contract and evidence log for the next agent resuming with zero context)
and treats git-unmanaged generated reports, local-only run IDs, and private
tool-session records as non-durable changelog evidence.

### PR descriptions

Honor the requested or project template exactly. Fill unknown sections with the
explicit absence status when appropriate, and preserve supplied statuses such as
`Not run` rather than replacing them with `Not provided`.

### Chat replies, progress updates, and final summaries

Lead with the answer. Keep progress updates to one or two short sentences.
Final summaries should be brief when useful and absent when not needed. Give
depth when the user asks for rationale, verification, limitations, recovery, or
comparison. Avoid ritual closing offers, generic next steps, and template
sections when a short answer resolves the request.

Do not turn every progress update or final summary in an active workflow into a
separate primary writing workflow. Apply the writing rules to the text only
after the active workflow has determined what can be said.
When the active workflow has supplied the facts for an incidental progress
update or final summary and the user asks to send it, write the requested brief
message directly. Do not replace it with a skill-routing explanation or a
checklist about how writing should apply.
Answer how `vibe-writing` applies only when the user asks a meta question about
skill routing. When the user asks to send, draft, or return the progress update
or final summary itself, the deliverable is that message.
Do not treat "not a standalone writing deliverable" as a reason to withhold the
brief message; it only means the active workflow keeps authority over what the
message may say.

### Commit messages

For commit-message work, read `references/commit-messages.md` when the task
involves a body, Conventional Commit shaping, durable references, verification
provenance, release commits, dependency updates, monorepo/package changes,
i18n/localization, performance, CI/build/publishing, security/privacy/data-loss,
thin evidence, mechanical syncs, required trailers, compact bullets, or
multi-line commit-message transport.

For a multi-line commit message, use one message file, one editor buffer, or one
complete message payload. Do not use repeated `git commit -m` arguments for body
lines, bullets, verification lines, or trailers.

Before running `git commit` or an amendment for a message with a body while this
skill is active, apply `references/commit-messages.md` to the subject shape, body
value, verification provenance, durable references, compact bullets, trailers,
and transport.

After creating or amending a commit with a body, inspect the stored message with
`git show -s --format=%B HEAD`. If the stored message violates this skill, amend
it before reporting completion. That inspection includes checking that
verification lines are signal-bearing proof rather than a session command
transcript, and that the body does not leak git-unmanaged local generated
artifacts, ignored result files, local-only run IDs, or private tool-session
records as proof sources. Pure message-drafting tasks do not need this Git
inspection because no stored commit artifact was created.

When the requested deliverable is the commit message itself, return raw commit
message text: no Markdown fence, example label, or explanatory prose unless the
user explicitly asks for that wrapper. Do not include proof-source analysis,
local-artifact classification, separators, headings, or any other wrapper before
the subject or after the final body/trailer line.

Markdown fences become commit-message bytes when pasted into `git commit`, so
they contaminate subjects, bodies, and trailers.

When used with a commit-execution skill, that skill controls staging,
authorization, command safety, signing, release processes, and history mutation.
`vibe-writing` controls the commit message artifact: subject wording, body value,
verification wording, durable references, trailers, compact bullets, and
multi-line transport.

## Durable References

Artifacts should stand alone outside the prompt. Remove prompt-only references
or translate them into durable facts: `above`, `the provided text`,
`per plan1.md`, `as discussed`, local run labels, temporary files, unpublished
branches, and private checkout paths.

Keep durable citations when requested or useful for audit, rollback, or search:
issue IDs, incident IDs, public API names, ADR slugs, release versions, commit
SHAs, committed paths, stable design docs, primary-source URLs, and exact error
codes.

## Common Mistakes

- Optimizing for human polish when the next reader is an LLM that needs precise
  constraints.
- Replacing a supplied absence status with a vague placeholder.
- Upgrading `should` to `must`, weakening `must not`, or dropping exceptions.
- Translating commands, env vars, file paths, locale tags, or identifiers during
  documentation polish.
- Turning a supplied capability or command into an inferred purpose, cause,
  outcome, proof, or benefit.
- Summarizing or normalizing raw logs, exact tool output, or bare
  acknowledgments that should stay unchanged.
- Keeping filler such as `It's worth noting that`, `In conclusion`, or `Ultimately` when the transition adds no contract, evidence, or action.
- Replacing useful local anchors, order, tone, or examples with generic textbook wording.
- Wrapping a requested commit message in a Markdown code fence.
- Adding safety, security, performance, rollout, or support promises because
  they sound helpful.
- Treating this skill as permission to ignore exact templates, release rules,
  commit authorization, PR formats, or staging procedures.

## Self-Check

Before returning text, check:

- Did the artifact use the correct reader priority?
- Did all facts, scope, conditions, exceptions, warnings, required actions, and
  modality survive?
- Did unsupported reasons, benefits, impact, tests, security/performance claims,
  or rollout status sneak in?
- Did useful local anchors survive, and did hollow transitions disappear unless exact source text required them?
- Did exact-format output stay exact?
- Did locale and technical-token preservation rules hold?
- Did durable references replace prompt-only or machine-local context?
- For commit-message bodies, did verification lines preserve durable,
  review-useful proof instead of a session command transcript or local-only
  generated proof source?
- If text was written through a tool, did the stored artifact match the intended
  artifact? For created or amended commits with a body, inspect the stored
  message, not only the command used to create it.
