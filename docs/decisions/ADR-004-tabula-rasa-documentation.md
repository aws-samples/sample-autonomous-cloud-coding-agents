# ADR-004: Tabula rasa documentation standard

**Status:** accepted
**Date:** 2026-05-19

## Context

Documentation written by people with deep project knowledge assumes readers share that knowledge. Acronyms go unexpanded, prerequisite steps are skipped as "obvious," and instructions break for anyone starting from zero — including autonomous agents with fresh context windows.

This is especially damaging for a platform designed to be operated by agents: every documentation gap becomes a hard failure point. Agents cannot guess, infer from memory, or ask a colleague what "bootstrap the toolkit" means.

## Decision

### The Tabula Rasa Test

Every document must pass: **Can someone with zero project knowledge, following only what is written, complete the described outcome?** If any step requires knowledge not present in the document or explicitly linked, the document fails.

### Minimally sufficient

Write the minimum that makes the reader succeed — not the minimum words, but the minimum *sufficient* content.

- Novice needs explanation: one-sentence "what this does" before each step
- Expert needs speed: scannable structure (numbered steps, headers, tables)
- Both need confidence: expected output or success criteria after key steps

### Progressive disclosure

```
Layer 1: What (one paragraph — what this helps you do)
Layer 2: Steps (numbered, self-contained, runnable)
Layer 3: Further reading (links with one-sentence descriptions)
```

Never force a novice to read expert material to proceed. Never force an expert to wade through explanations to find the command.

### International English

- Simple sentence structure (subject-verb-object)
- No idioms or colloquialisms
- Concrete words ("run this command" not "execute the following")
- One idea per sentence
- Active voice

### Self-contained references

When referencing another document:
- State what the reader gets from it: "See [Deployment Guide](link) for AWS account setup (required before this step)"
- Never assume the reader has read it
- Never use "as mentioned above" — each section must stand alone after context compaction

### Testable documentation

- Commands are copy-pasteable (no hidden dependencies)
- Expected output shown after non-trivial commands
- Prerequisites listed at the top, not discovered mid-flow
- Error states documented: "If you see X, it means Y. Fix: Z"

### Terminology consistency

- Use the same term for the same concept everywhere
- Bold on first use with parenthetical definition
- Maintain a project glossary for machine and human consumption

### Quality checklist (per document)

- First paragraph answers: "What does this help me do?"
- Prerequisites listed at top
- Every command includes directory context
- Acronyms expanded on first use
- No dangling references
- Expected output shown after key steps
- Error states documented for common failures
- Further reading links have descriptions
- Passes the tabula rasa test

## Consequences

- (+) New users complete guides without external help
- (+) Agents execute workflows without human clarification
- (+) Documentation gaps are discoverable (ADR-007 progressive failure protocol)
- (+) International accessibility improves
- (-) More writing effort per document
- (-) Experts may find some material overly explicit (mitigated by progressive disclosure)
- (!) Existing documentation does not meet this standard — improvement is incremental, not a rewrite

## References

- Issue #135 — full RFC with application matrix and open questions
- Roadmap: Documentation and specifications
- ADR-007 — knowledge acquisition protocol (complements this standard)
