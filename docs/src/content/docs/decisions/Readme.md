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
```

## Numbering

ADRs are numbered sequentially with zero-padded three-digit prefixes: `001-slug.md`, `002-slug.md`, etc. Numbers are never reused.

## Lifecycle

| Status | Meaning |
|--------|---------|
| `proposed` | Under discussion, not yet binding |
| `accepted` | Active and authoritative |
| `superseded` | Replaced by a newer ADR (link to successor) |
| `deprecated` | No longer applicable (context changed) |

A decision starts as `proposed` during RFC discussion and moves to `accepted` when the implementing PR merges. To change an accepted decision, write a new ADR that supersedes it — do not edit the original.

## Relationship to `docs/design/`

Design documents describe system shape, interfaces, and implementation detail. ADRs capture cross-cutting choices that constrain multiple designs. When a design decision is significant enough to be "hard to reverse" or "non-obvious," extract it as an ADR and reference it from the design doc. An ADR may supersede another ADR; a design doc is simply updated in place.

## Discovery

- **Agents:** `AGENTS.md` routes to this directory for understanding past design rationale.
- **Humans:** Browse this directory or the docs site under the "Decisions" section.
- **Search:** Each ADR title and context section are written to be grep-friendly.
