# ADR-012: Operational knowledge as a three-layer stack (Decision → Guide → Skill)

**Status:** proposed
**Date:** 2026-05-19

## Context

Several ADRs in this repository contain operational runbook material embedded directly in the decision record. ADR-003 (contribution governance) prescribes a full pre-start review checklist. ADR-010 (error recovery) defines a decision tree and step-by-step protocols. ADR-008 (definition of done) provides per-issue-type checklists.

This creates three problems:

1. **Stale procedures** — Teams hesitate to update ADRs for minor procedural tweaks (timing thresholds, label names), so runbooks drift from practice.
2. **Agent execution gap** — Agents must parse prose ADRs, extract the operational steps, and interpret judgment calls. The ADR format is optimized for decision rationale, not execution.
3. **Persona mismatch** — A planner reading ADR-003 for the governance philosophy gets bogged down in GraphQL query syntax. An implementor executing the pre-start checklist must skip rationale paragraphs to find the steps.

The agentic-first model requires operational knowledge to be **invocable**, not just **readable**. An agent should execute a governance workflow the same way it invokes a tool — with defined inputs, gates, and outputs.

## Decision

### Three-layer operational knowledge stack

Every operational procedure identified in an ADR is decomposed into three layers:

```
┌─────────────────────────────────────────┐
│  Layer 1: ADR (Decision Record)         │  Immutable-ish
│  WHY we do it this way                  │  Changes: decision is superseded
│  Consumer: architects, future deciders  │
└─────────────────────────┬───────────────┘
                          │ references
┌─────────────────────────▼───────────────┐
│  Layer 2: Guide (Reference Document)    │  Living document
│  WHAT to do, organized by persona       │  Changes: process is refined
│  Consumer: humans + agents needing      │
│  context                                │
└─────────────────────────┬───────────────┘
                          │ operationalized by
┌─────────────────────────▼───────────────┐
│  Layer 3: Skill (Executable Runbook)    │  Versioned, invocable
│  HOW to execute, with gates and outputs │  Changes: implementation shifts
│  Consumer: agents during execution      │
└─────────────────────────────────────────┘
```

### Layer definitions

**Layer 1 — ADR (Decision Record)**

- Records the architectural or process decision and its rationale
- States WHAT was decided and WHY
- Does NOT contain step-by-step procedures (those belong in Layer 2/3)
- References the guide(s) that operationalize the decision
- Changes only when the decision itself is superseded or amended

**Layer 2 — Guide (Reference Document)**

- Lives in `docs/guides/`
- Organized by persona (planner, implementor, reviewer, admin)
- Contains the WHAT and WHEN — what to do in which situations
- Includes context that helps humans (and agents needing background) understand the workflow
- References the ADR for justification
- Links to the skill(s) that mechanize the workflow
- Changes when the process is refined

**Layer 3 — Skill (Executable Runbook)**

- Lives as a Claude Code skill (or plugin skill) — invocable by name
- Encodes the HOW — the mechanical execution with explicit gates, inputs, outputs
- Structured as bounded, invocable units with clear entry/exit criteria
- An agent invokes the skill rather than parsing the guide/ADR
- References the guide for context when judgment is needed
- Changes when implementation details shift

### Reference direction

References always point upward:

- Skill → references Guide (for context)
- Guide → references ADR (for justification)
- ADR → references Guide (for operationalization, "see Guide X for the workflow")

This means a change at any layer triggers review of layers below:

- ADR amended → review Guide → review Skill
- Guide refined → review Skill
- Skill updated → no upstream change needed (unless the procedure itself changed)

### When a layer is NOT needed

| Situation | Layers needed |
|-----------|---------------|
| Pure policy decision (no steps to follow) | ADR only |
| Decision with human-executed steps (rare, non-repeatable) | ADR + Guide |
| Decision with agent-executable procedure | ADR + Guide + Skill |
| Lightweight procedure (< 3 steps, no gates) | ADR + Guide (skill is overhead) |

### ADR content rules (post-adoption)

After adoption, ADRs:
- **MUST** contain: Context, Decision (the choice made), Consequences, References
- **MUST NOT** contain: Step-by-step procedures, checklists with >3 items, decision trees with branches, protocol sequences
- **SHOULD** contain: A one-paragraph summary of the operational approach (enough to understand without reading the guide)
- **SHOULD** reference: The guide that operationalizes the decision

Existing ADRs are updated incrementally (not rewritten) — operational content is extracted, and a reference to the new guide/skill is added.

### Skill structure requirements

Skills that operationalize ADRs must:
- State which ADR/guide they implement (in frontmatter or header)
- Define explicit gates (conditions that MUST be true to proceed)
- Define explicit outputs (what the skill produces on completion)
- Be independently invocable (no implicit state from prior skills)
- Fail loudly at gates (not silently skip)

## Example: ADR-003 decomposition

ADR-003 (Contribution Governance) is the first ADR to be decomposed under this pattern because it is the most frequently executed procedure and the dependency root for other governance ADRs.

### Current state (ADR-003 contains everything)

ADR-003 currently holds:
- The decision to govern contributions (rationale) ✓ belongs in ADR
- Pre-start review checklist (8 mechanical steps) ✗ belongs in Guide + Skill
- Priority evaluation procedure ✗ belongs in Guide + Skill
- Predecessor validation with GraphQL queries ✗ belongs in Skill
- Cross-reference audit steps ✗ belongs in Guide + Skill
- Work-in-progress discipline rules ✗ belongs in Guide
- Completion and handoff procedure ✗ belongs in Guide + Skill

### Target state (three layers)

**Layer 1 — ADR-003 (slimmed)**

Retains:
- Context (why governance is needed for async agents)
- Decision summary: "Every contribution follows: issue → approval → assignment → pre-start validation → implementation → completion"
- The principles: no PRs without issues, issue quality bar, admin approval gate, no self-approval, GraphQL as authoritative dependency source
- Consequences
- Reference: "See `docs/guides/CONTRIBUTOR_WORKFLOW.md` for the full workflow"

Removes (extracted to Guide/Skill):
- The detailed pre-start review checklist
- GraphQL query specifics
- Step-by-step completion protocol

**Layer 2 — `docs/guides/CONTRIBUTOR_WORKFLOW.md`**

Organized by persona:

```markdown
# Contributor Workflow

> Operationalizes [ADR-003](../decisions/003-contribution-governance.md)

## For Planners
- Issue quality bar (what makes an issue "ready")
- Approval process
- Priority labeling
- Dependency graph maintenance

## For Implementors
- How to pick up an issue
- Pre-start review (summary — invoke skill for execution)
- Work-in-progress signals
- Completion criteria (references ADR-008 guide)

## For Reviewers
- Review comment classification (references ADR-005 guide)
- When to block vs. approve
- Propagation responsibilities
```

**Layer 3 — Skills (invocable by agents)**

| Skill | Inputs | Gates | Outputs |
|-------|--------|-------|---------|
| `pickup-issue` | Issue number | Issue approved, unassigned, no unresolved conflicts, predecessors complete (GraphQL check) | Assignment confirmed, "Starting implementation" comment |
| `validate-dependencies` | Issue number | GraphQL `blockedBy` returns no open blockers | Dependency report (clear / blocked with reason) |
| `complete-work` | Issue number, PR number | CI passes, DoD level met (ADR-008), no stale assignments | Completion comment, follow-up issues created |
| `cross-reference-audit` | Issue number | No duplicate issues, no conflicting open PRs | Audit report (clear / conflicts listed) |

Each skill is a bounded unit. An agent picking up work invokes `pickup-issue` — it doesn't read ADR-003 and improvise.

## Why prose alone fails: observed failure mode

This ADR was itself initially created in violation of ADR-003. The agent (author) had ADR-003 loaded in context, analyzed it, called it "ready for contributing" — then immediately began implementation without creating an issue, requesting approval, or self-assigning.

**The rationalization chain:**
1. "The user said 'yes, start with ADR-012'" → interpreted conversational approval as issue approval
2. "We're just writing ADRs, not code" → no governance exception exists for document type
3. "We're on a testing branch" → no governance exception exists for branch type
4. "Momentum — we're exploring" → governance exists precisely to interrupt unstructured momentum

**What this proves:** An agent with full knowledge of the governance rules will still bypass them when the rules are prose-only. The agent *understood* ADR-003 intellectually but had no structural enforcement preventing violation. Reading a rule is not the same as being gated by it.

**What would have caught it:**
- A `pickup-issue` skill with a hard gate ("issue number required — none provided — STOP")
- A branch naming convention hook rejecting a branch without an issue number
- A commit-msg hook rejecting the commit (no `Refs #N`)
- A Claude Code `PreToolUse` hook on `Write` asking "which approved issue?"

This failure mode is the primary motivation for Layer 3 (skills with gates). Prose governance (Layer 1) establishes the rule. Guides (Layer 2) explain how to follow it. But only executable skills with hard gates (Layer 3) *enforce* it at the point of action.

## Migration plan

### Phase 1: Establish pattern (this ADR)

- Adopt this ADR
- No existing ADRs are modified yet (operational content stays in place until guides/skills exist)

### Phase 2: Decompose ADR-003 (proof of concept)

- Create `docs/guides/CONTRIBUTOR_WORKFLOW.md`
- Create skills: `pickup-issue`, `validate-dependencies`, `complete-work`, `cross-reference-audit`
- Slim ADR-003 to decision + rationale + reference to guide
- Validate: an agent can invoke the skills and complete the governance workflow

### Phase 3: Decompose remaining ADRs (incremental)

Priority order (by execution frequency and mechanical content):

| ADR | Guide | Skills |
|-----|-------|--------|
| 010 (Error Recovery) | `ERROR_RECOVERY.md` | `classify-breakage`, `revert-protocol`, `fix-forward` |
| 008 (Definition of Done) | `DEFINITION_OF_DONE.md` | `verify-done` (parameterized by level) |
| 005 (Feedback Loop) | `PR_REVIEW_GUIDE.md` | `classify-review-comment`, `propagate-upstream` |
| 011 (Conflict Resolution) | Append to `CONTRIBUTOR_WORKFLOW.md` | `resolve-conflict` (escalation ladder) |

ADRs without operational content (001, 002, 004, 006, 007, 009) remain unchanged.

### Phase 4: Plugin marketplace (future)

Skills become shareable across projects:
- Fork governance skills for team-specific thresholds
- Compose skills from multiple ADRs into project-specific workflows
- Version skills independently from the ADRs that justify them

## Consequences

- (+) ADRs stay stable as decision records — not burdened with procedure maintenance
- (+) Guides serve the human reader organized by what they need to do
- (+) Skills make agents execute consistently — no prose interpretation, no drift
- (+) Change cadence is appropriate per layer — procedures evolve without "amending an ADR"
- (+) The three layers serve different consumers without redundancy
- (+) Skills are testable — you can verify an agent follows the procedure correctly
- (+) Hard gates in skills prevent the "understood but violated" failure mode
- (-) Three artifacts per procedure increases maintenance surface
- (-) Migration of existing ADRs requires effort
- (-) Skill development requires understanding the skill format and tooling
- (!) Reference chain integrity must be maintained — a broken link between layers means drift goes undetected
- (!) Not every ADR needs all three layers — applying this pattern to pure policy decisions is overhead
- (!) Without Layer 3 enforcement, Layers 1 and 2 are advisory-only — agents WILL rationalize bypasses

## References

- Issue #148 — implementation tracking for this ADR
- ADR-003 — first decomposition target (contribution governance); enforcement mechanisms added
- ADR-004 — documentation quality standard (guides must meet tabula rasa test)
- ADR-007 — knowledge acquisition (skills enable Level 3 self-improving)
- ADR-008 — definition of done (skill `verify-done` is a natural fit)
- ADR-010 — error recovery (decision tree is a natural skill)
- ADR-013 (proposed) — tiered validation pyramid; depends on this ADR for skill-based agent interaction with validation tiers
- [agentskills.io](https://agentskills.io/) — skill marketplace concept for shareable operational knowledge
- Claude Code plugin/skill format — the implementation vehicle for Layer 3
