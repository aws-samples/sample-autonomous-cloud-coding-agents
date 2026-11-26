# ADR-020: EARS syntax for normative requirements

**Status:** accepted
**Date:** 2026-07-28
**Last-updated:** 2026-11-26

## Context

ADRs, RFCs, and design docs in this repository state requirements in free-form prose. Prose requirements are ambiguous. They mix a trigger, a state, and a response in one sentence, omit the actor, and use vague verbs ("should", "handles", "supports") that a reader, human or agent, cannot test. ADR-004 (tabula rasa documentation) already demands testable, one-idea-per-sentence writing, but it offers no concrete grammar for the requirement statements themselves.

Autonomous agents consume these documents as instructions. An agent cannot ask a clarifying question at 3 a.m. An ambiguous "the system should retry on failure" leaves the retry count, trigger condition, and target component unspecified. The agent that must implement or verify the requirement bears the cost of ambiguity.

EARS (Easy Approach to Requirements Syntax, <https://alistairmavin.com/ears/>) is a lightweight, well-documented set of five sentence templates that force each requirement to name its actor, its trigger or condition, and a single testable response. It requires no tooling and reads as ordinary English.

Issue [#666](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/666) proposes adopting EARS as the required syntax for normative requirements. This ADR records that decision and, to apply the decision to itself, states its own decision in EARS.

## Decision

Adopt EARS as the required syntax for normative requirements in ADRs. The requirements below are themselves written in EARS.

### The five EARS patterns

| Pattern | Template |
|---------|----------|
| Ubiquitous | The `<system>` shall `<response>`. |
| Event-driven | When `<trigger>`, the `<system>` shall `<response>`. |
| State-driven | While `<state>`, the `<system>` shall `<response>`. |
| Optional-feature | Where `<feature>`, the `<system>` shall `<response>`. |
| Unwanted-behavior | If `<trigger>`, then the `<system>` shall `<response>`. |

### Normative requirements (in EARS)

- The ADR author shall express every normative requirement using exactly one of the five EARS patterns.
- When an author writes a normative requirement in an ADR, the author shall use the verb "shall" for the response.
- While an ADR holds `accepted` status, its normative requirements shall remain expressed in EARS syntax.
- Where a requirement applies only to an optional feature, the author shall use the EARS optional-feature pattern.
- If a normative requirement is written as ambiguous prose instead of an EARS pattern, then the reviewer shall request changes before the ADR is accepted.

### Scope

EARS applies to **normative** statements, the requirements that an implementation or reviewer must satisfy. Context, rationale, consequences, and other explanatory prose are unaffected. Forcing narrative text into `shall` sentences would harm readability without adding testability. RFCs and design docs are encouraged, but not required, to follow EARS for their requirement statements.

## Consequences

- (+) Each requirement names its actor, trigger, and a single testable response, so an agent can implement and verify it without inferring intent.
- (+) The grammar is five templates and needs no tooling. The barrier to adoption is a style habit, not a build step.
- (+) EARS complements ADR-004. It is the concrete sentence grammar for the "testable documentation" that ADR-004 asks for in the abstract.
- (-) Authors must learn five patterns and re-cast prose requirements, which adds minor authoring friction.
- (-) Reviewers gain a new thing to check. The unwanted-behavior requirement above makes it a review gate.
- (!) Existing ADRs are not retrofitted. This standard applies to new normative requirements. Back-conversion is incremental, not a rewrite (the same posture as ADR-004).
- (!) EARS covers atomic requirements well but is awkward for complex conditional logic. Authors may decompose one complex rule into several EARS statements instead of nesting clauses.

## References

- Issue [#666](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/666). Proposal to adopt EARS, written entirely in EARS.
- EARS, Easy Approach to Requirements Syntax: <https://alistairmavin.com/ears/>
- Mavin, A. et al., "Easy Approach to Requirements Syntax (EARS)", IEEE RE 2009
- ADR-004. Tabula rasa documentation standard (the testable, one-idea-per-sentence writing that this ADR makes concrete).

## Changelog

- 2026-11-26 — Reworded for plain technical style: shorter sentences, no dashes as punctuation, one name for each thing. The decision and its facts are unchanged.
