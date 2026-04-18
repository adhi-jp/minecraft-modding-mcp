---
version: 1.0.0
name: writing-style-guide
description: Apply disciplined writing principles whenever generating or editing user-facing text — source-code documentation, README, CHANGELOG, commit messages, PR descriptions, and chat replies the user reads. Use for any artifact where words persist beyond the immediate turn. Emphasizes concision, audience fit, and elimination of AI-adjacent filler (marketing vocabulary, hollow superlatives, unrequested caveats, acknowledgment preambles). Trigger whenever producing prose, even when the user did not explicitly ask to apply a style guide — text quality is part of delivery.
---

# Writing Style Guide

## Overview

Words that ship — documentation, commits, chat replies — are part of the deliverable. The prose affects whether readers trust, use, and maintain the work.

This skill supplies principles, not a procedure. The agent applies judgment; the skill sets direction.

## Scope

Apply when producing:

- Source-code documentation (comments, docstrings)
- README, CHANGELOG, and other narrative docs
- Commit messages and PR descriptions
- Replies the user reads in chat

Skip when:

- Text is internal (tool arguments, intermediate search strings, private reasoning)
- Output is machine-readable or must match an exact format (JSON responses, structured protocol payloads, code templates a downstream tool will parse byte-for-byte). Human-readable source code and its comments/docstrings remain in scope — this guide applies to what you write *about* the code, even when the code itself is freshly generated.
- Text is a verbatim relay (command output, log excerpts, stack traces, other tool output quoted back to the user)
- Text is a transient status line ("building…", "running test 3/12") whose only job is to show progress
- A bare acknowledgment (`done`, `merged`) is genuinely the complete reply

When in doubt between applying the guide and preserving an exact format contract, the format contract wins — readability of prose is not worth breaking a consumer that expects a specific shape.

## Core Principles

### Concision over ornament

Write the shortest version that still transmits the idea. A decorative sentence is a cost every future reader pays. Elegance comes from what is left out.

### Language follows the artifact, then English

Decide artifact language by this precedence, high to low:

1. **Explicit user instruction** — if the user asked to translate, localize, or write in a specific language, use it. Translation and localization requests override every rule below.
2. **Existing artifact language** — when editing a file and the user has not specified a target language, preserve the language already used. Switching a Japanese README to English mid-file produces mixed-language output that serves no one.
3. **Filename locale marker** — e.g. `README.ja.md`, `docs/de_de/guide.md`. Honor it for new files.
4. **Project convention** — surrounding docs, CONTRIBUTING, or a style guide in the repo.
5. **Default to English** — when none of the above give a signal.

Chat replies follow the user's active conversational language, not the file defaults.

### No meta-acknowledgments

Drop preambles like `Sure!`, `Absolutely.`, `Great question.`. The action itself shows agreement. A reply that opens with the substance respects the reader's time more than one that opens with a performance.

### Artifacts stand alone

The text must make sense without the prompt that produced it. Do not embed references to ephemeral input — `per plan1.md step 1.2`, `this variable is the foo from the spec`, `as discussed above`. Readers of the artifact will not have that conversation, and those references rot the moment the input file is renamed or removed.

Durable traceability is different: issue IDs, RFC numbers, incident tickets, commit SHAs, ADR slugs, and other stable pointers belong in the artifact when they are requested, required by the project, or needed for audit and rollback. The test is whether the reference survives a rename of local working files — if it does, it is a citation, not a prompt leak.

### Match the reader

Identify who will read this and what they need. Omit everything else.

- An end-user README is for installing and using. Internal build steps usually belong elsewhere.
- Contributor docs are for setup and submission. Product vision usually belongs elsewhere.
- A code comment is for the future maintainer. Names and types already carry the *what*; the comment's job is the *why* that is not visible from the signature.

"Usually" is deliberate — a library whose users build from source does need build steps in its README. Judge the actual audience, not a generic one.

## Anti-Patterns

These degrade any piece of writing. Remove them on sight.

- **Name-echoing comments** — `// parse the user` on `fn parse_user()`. The reader sees the same thing twice.
- **Marketing vocabulary** — `seamlessly`, `effortlessly`, `powerful`, `leverage`, `robust`, `enterprise-grade`. These signal sales copy, not engineering.
- **Groundless future claims** — `this will enable future extensibility`, `making it easy to scale later`. Write to present behavior; readers can assess the future themselves.
- **Unrequested additions** — disclaimers, alternative-approach write-ups, roadmap sections, or "things to consider" the user did not ask for. Scope discipline is part of quality. Required warnings are the exception: safety, security, data-loss, compliance, and irreversible-action notices are not "unrequested additions" even when the user never prompted for them. Concision never justifies dropping a warning the reader needs to avoid harm.
- **Hollow transitions** — `It's worth noting that…`, `In conclusion,`, `Ultimately,`. If a point is worth making, make it; do not announce it.
- **Forced symmetry** — rule-of-three lists padded with a filler item, parallel structures built from nothing. Three real points beat three forced ones.
- **Em-dash abundance** — one or two per paragraph is fine; a third in the same paragraph becomes a tell.

## Applied to Common Artifact Types

Illustrations of how the core principles land on familiar artifacts — not workflow rules, and not defaults to override project conventions. Where a project has its own house style, commit template, or release process, that convention wins. These bullets only fill in when no project rule is active.

### Source-code documentation

- Public libraries: document intent, contracts, invariants, and non-obvious usage in full.
- Internal code: write the minimum needed to orient the next maintainer.
- Unconventional code (workarounds, perf tricks, subtle contracts): explain the reason. Removing the comment would confuse a future reader.
- Never write a doc comment that only paraphrases the signature.

### README

- Decide the primary reader before writing anything else.
- Lead with what it is and how to start using it. Details that do not serve the first thirty seconds go below or out.
- Cut sections the intended reader does not need. An end-user README should not double as an architecture doc.

### CHANGELOG

- Follow the project's existing style.
- Each entry answers "what changed for me, the reader". Internal refactors without user-visible impact usually belong in commit history, not here.

### Commit messages

- Match the repository's existing convention in prefix scheme, tone, and length.
- The subject line states what the commit achieves, not what the author did.
- The body explains the *why*, the tradeoffs, and anything a reviewer cannot see from the diff alone.

### Chat replies

- Lead with the answer.
- Keep in-progress updates to a sentence or two.
- End-of-turn summaries, when needed, are one or two sentences. Stay silent when nothing is worth saying.
- When the user asks for depth — a rationale, verification results, limitations, a recovery plan, a comparison — give them that depth. Concision is a default, not a ceiling; it never justifies omitting information the reader explicitly asked for or needs to act safely.

## Coexistence

This guide is principles, not procedure. When other active instructions or workflows in the same session provide concrete steps for a specific artifact (staging procedure, PR template, release-note format), defer to them for the procedure and apply these principles to the words they produce.

When a project convention conflicts with a principle here, the project wins. This guide is for judgment, not for overriding established house style.

## Self-check before returning prose

A short pass over the draft, looking for:

- Words deletable without loss of meaning — delete them.
- Sentences that announce what the next sentence will do — drop the announcement.
- Superlatives without evidence — cut or replace with specifics.
- Sections the reader did not ask for — remove them.
- References to the prompt, input file, or the conversation that produced the text — rewrite so the artifact stands on its own.

The goal is not austerity. The goal is that every word earns its place.
