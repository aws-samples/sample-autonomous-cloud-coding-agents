---
title: "Architecture Decision Records (ADRs)"
---

This directory records significant design decisions for the ABCA project. Each ADR explains **why** a decision was made as well as what was decided, so that future contributors (human and AI) can understand the reasoning without searching git history or PR discussions.

## When to write an ADR

Write an ADR when a decision:

- Affects multiple packages or the overall architecture
- Establishes a pattern other code will follow
- Is non-obvious, so that a reasonable person might choose differently
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

`**Date:**` records when the decision was **made or accepted** and is never overwritten. It is the historical anchor that shows which other ADRs existed and what the constraints were. `**Last-updated:**` records when the record was last **refined in place**. The `## Changelog` records *what* changed. See [Changing an accepted ADR](#changing-an-accepted-adr-refine-in-place-vs-supersede).

## Numbering

ADRs are numbered sequentially with zero-padded three-digit prefixes, for example `ADR-001-slug.md` and `ADR-002-slug.md`. Numbers are never reused.

## Lifecycle

| Status | Meaning |
|--------|---------|
| `proposed` | Under discussion, not yet binding |
| `accepted` | Active and authoritative |
| `superseded` | Replaced by a newer ADR (link to successor) |
| `deprecated` | No longer applicable (context changed) |

A decision starts as `proposed` during RFC discussion and moves to `accepted` when the implementing PR merges.

### Changing an accepted ADR: refine in place vs. supersede

The lifecycle state above is **independent** of ordinary upkeep. Two different operations apply to an accepted ADR, and the status table does not decide between them:

- **Refinement.** The decision is unchanged. You are clarifying wording, adding a consequence or risk, extracting operational prose to a guide or skill (see ADR-012), or fixing a reference. **Edit the file in place.** The status stays `accepted`.
- **Reversal.** The decision itself changes: a different approach is chosen, or what a reader must do changes. **Write a new ADR that supersedes the old one.** The old ADR becomes `superseded`.

**The boundary test.** *If the action a reader would take is unchanged, the change is a refinement. Edit in place. If a past reader following the old ADR would now do something different, the change is a reversal. Write a superseding ADR.*

| Change | What it is | What to do | Status effect | Date fields |
|--------|-----------|------------|---------------|-------------|
| Clarify wording, add a consequence or risk, extract prose to a guide or skill (per ADR-012), or fix a broken reference | **Refinement** | Edit in place and append a dated `## Changelog` entry | none (`accepted`) | `Date:` unchanged, bump `Last-updated:` |
| Reverse the decision, choose a different approach, or change what a reader must do | **Reversal** | Write a new ADR with `**Supersedes:** ADR-NNN` and mark the old ADR `**Superseded by:** ADR-MMM` | both change | new ADR gets its own `Date:` |
| The decision no longer applies (its context is gone) | **Obsolescence** | Mark `deprecated` and note why | `deprecated` | bump `Last-updated:` |

This rule replaces strict immutability with the mainstream ADR practice. Joel Parker Henderson's widely cited guidance notes that *"In theory, immutability is ideal. In practice, mutability has worked better for our teams."* It says to insert new information into the existing ADR with a date stamp and a note. MADR's template uses a single `date` field meaning "when the decision was last updated". This standard goes further. It keeps the decision `Date:` immutable and records refinements separately. The **decision date is never overwritten**. Refinements are recorded in the `## Changelog` and the `Last-updated` field, so the record is self-contained. An agent should not need to search git history to learn what was refined and when.

## Relationship to `docs/design/`

Design documents describe system shape, interfaces, and implementation detail. ADRs record cross-cutting choices that constrain multiple designs. When a design decision is significant enough to be "hard to reverse" or "non-obvious," extract it as an ADR and reference it from the design doc. An ADR may supersede another ADR. A design doc is updated in place.

## Discovery

- **Agents:** `AGENTS.md` routes to this directory for understanding past design rationale.
- **Humans:** Browse this directory or the docs site under the "Decisions" section.
- **Search:** Each ADR title and context section are written to be grep-friendly.
