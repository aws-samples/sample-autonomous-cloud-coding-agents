---
title: "ADR-004: Tabula rasa documentation standard"
---

**Status:** accepted
**Date:** 2026-05-19
**Last-updated:** 2026-11-26

## Context

Documentation written by people with deep project knowledge assumes that readers share that knowledge. Acronyms go unexpanded, prerequisite steps are skipped as "obvious," and instructions break for anyone who starts from zero, including autonomous agents with fresh context windows.

This is especially damaging for a platform designed to be operated by agents, because every documentation gap becomes a hard failure point. Agents cannot guess, infer from memory, or ask a colleague what "bootstrap the toolkit" means.

## Decision

### The Tabula Rasa Test

Every document must pass this test: **Can someone with zero project knowledge, following only what is written, complete the described outcome?** If any step requires knowledge that is neither present in the document nor explicitly linked, the document fails.

### Minimally sufficient

Write the minimum that makes the reader succeed. That is the minimum *sufficient* content, not the minimum number of words.

- A novice needs explanation, so put a one-sentence "what this does" before each step.
- An expert needs speed, so use a scannable structure (numbered steps, headers, tables).
- Both need confidence, so show the expected output or the success criteria after key steps.

### Progressive disclosure

```
Layer 1: What (one paragraph — what this helps you do)
Layer 2: Steps (numbered, self-contained, runnable)
Layer 3: Further reading (links with one-sentence descriptions)
```

Never force a novice to read expert material to proceed. Never force an expert to read through explanations to find the command.

### International English

- Simple sentence structure (subject-verb-object)
- No idioms or colloquialisms
- Concrete words ("run this command" not "execute the following")
- One idea per sentence
- Active voice

### Self-contained references

When you reference another document:
- State what the reader gets from it: `See [Deployment Guide](link) for AWS account setup (required before this step)`
- Never assume the reader has read it
- Never use "as mentioned above", because each section must stand alone after context compaction

### Testable documentation

- Commands are copy-pasteable (no hidden dependencies)
- Expected output shown after non-trivial commands
- Prerequisites listed at the top, not discovered mid-flow
- Error states documented: "If you see X, it means Y. Fix: Z"

### Terminology consistency

- Use the same term for the same concept everywhere
- Bold a term on first use, with its definition in parentheses
- Maintain a project glossary that machines and humans can read

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
- (!) Existing documentation does not meet this standard, and improvement is incremental, not a rewrite

## References

- Issue #135, the full RFC with the application matrix and open questions
- ADR-007, the knowledge acquisition protocol (complements this standard)

## Changelog

- 2026-11-10 — Wrote the example under "Self-contained references" as inline code. It was a Markdown link to the placeholder target `link`, which rendered as a dead link on the documentation site and needed an exception in the link check (decision unchanged).
- 2026-11-26 — Reworded for plain technical style: shorter sentences, no dashes as punctuation, one name for each thing. The decision and its facts are unchanged.
