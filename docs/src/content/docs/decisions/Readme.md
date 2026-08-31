---
title: Readme
---

# Architecture Decision Records (ADRs)

This directory captures significant design decisions for the ABCA project. Each ADR explains **why** a decision was made — not just what was decided — so that future contributors (human and AI) can understand the reasoning without excavating git history or PR discussions.

## When to write an ADR

Write an ADR when a decision:

- Affects multiple packages or the overall architecture
- Establishes a pattern other code will follow
- Is non-obvious — a reasonable person might choose differently
- Is hard to reverse once implemented

Do **not** write an ADR for routine implementation choices that are self-evident from the code.

## Template

```markdown
# ADR-NNN: Title

**Status:** proposed | accepted | superseded | deprecated
**Date:** YYYY-MM-DD
**Last-updated:** YYYY-MM-DD (optional; add when the ADR is refined in place after acceptance)
**Supersedes:** ADR-NNN (if applicable)
**Superseded by:** ADR-NNN (if applicable)

## Context

What is the problem or situation that requires a decision? Include constraints, requirements, and forces at play.

## Decision

What was decided and why. Be specific — name the approach chosen.

## Consequences

What follows from this decision:
- (+) Positive outcomes
- (-) Negative outcomes or trade-offs
- (!) Risks or things to watch

## References

- Links to RFCs, issues, PRs, or external resources that informed the decision

## Changelog

(Optional; omit when first creating the ADR. Add this section on the first in-place refinement, one dated bullet per refinement. The decision date in `**Date:**` is never overwritten.)

- YYYY-MM-DD — What was refined and why (decision unchanged).
```

`**Date:**` records when the decision was **made/accepted** and is never overwritten — it is the historical anchor (which other ADRs existed, what the constraints were). `**Last-updated:**` records when the record was last **refined in place**; the `## Changelog` records *what* changed. See [Changing an accepted ADR](#changing-an-accepted-adr-refine-in-place-vs-supersede).

## Numbering

ADRs are numbered sequentially with zero-padded three-digit prefixes: `ADR-001-slug.md`, `ADR-002-slug.md`, etc. Numbers are never reused.

## Lifecycle

| Status | Meaning |
|--------|---------|
| `proposed` | Under discussion, not yet binding |
| `accepted` | Active and authoritative |
| `superseded` | Replaced by a newer ADR (link to successor) |
| `deprecated` | No longer applicable (context changed) |

A decision starts as `proposed` during RFC discussion and moves to `accepted` when the implementing PR merges.

### Changing an accepted ADR: refine in place vs. supersede

Lifecycle state (above) is **orthogonal** to ordinary upkeep. Two different operations apply to an accepted ADR, and the status table does not decide between them:

- **Refinement** — the decision is unchanged; you are clarifying wording, adding a consequence or risk, extracting operational prose to a guide/skill (see ADR-012), or fixing a reference. **Edit the file in place.** Status stays `accepted`.
- **Reversal** — the decision itself changes: a different approach is chosen, or what a reader must do changes. **Write a new ADR that supersedes the old one.** The old ADR becomes `superseded`.

**The boundary test:** *If the action a reader would take is unchanged, it's a refinement — edit in place. If a past reader following the old ADR would now do something different, it's a reversal — write a superseding ADR.*

| Change | What it is | What to do | Status effect | Date fields |
|--------|-----------|------------|---------------|-------------|
| Clarify wording; add a consequence/risk; extract prose to a guide/skill (per ADR-012); fix a broken reference | **Refinement** | Edit in place; append a dated `## Changelog` entry | none (`accepted`) | `Date:` unchanged; bump `Last-updated:` |
| Reverse the decision; choose a different approach; change what a reader must do | **Reversal** | New ADR with `**Supersedes:** ADR-NNN`; mark the old `**Superseded by:** ADR-MMM` | both change | new ADR gets its own `Date:` |
| The decision no longer applies (context evaporated) | **Obsolescence** | Mark `deprecated`; note why | `deprecated` | bump `Last-updated:` |

This replaces strict immutability with the mainstream ADR practice. Joel Parker Henderson's widely-cited guidance notes that *"In theory, immutability is ideal. In practice, mutability has worked better for our teams."* — insert new information into the existing ADR with a date stamp and a note. MADR's template uses a single `date` field meaning "when the decision was last updated"; this standard goes further, keeping the decision `Date:` immutable and recording refinements separately. The **decision date is never overwritten**; refinements are recorded in the `## Changelog` and the `Last-updated` field, keeping the record self-contained (an agent should not need to excavate git history to learn what was refined and when).

## Relationship to `docs/design/`

Design documents describe system shape, interfaces, and implementation detail. ADRs capture cross-cutting choices that constrain multiple designs. When a design decision is significant enough to be "hard to reverse" or "non-obvious," extract it as an ADR and reference it from the design doc. An ADR may supersede another ADR; a design doc is simply updated in place.

## Discovery

- **Agents:** `AGENTS.md` routes to this directory for understanding past design rationale.
- **Humans:** Browse this directory or the docs site under the "Decisions" section.
- **Search:** Each ADR title and context section are written to be grep-friendly.
