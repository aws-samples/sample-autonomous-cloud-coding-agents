"""Workflow section for ``coding/decompose-v1`` — #299 Mode B planning as a
real agent task (replaces the webhook Lambda's blind two-call Bedrock planner).

Unlike the other coding workflows this one does NOT change code or open a PR: it
clones the repo (so it plans with FULL repository context, which the old
Lambda-side planner never had — the root of the ABCA-490 timeout and ABCA-492
repo-blindness), decides whether the issue should be decomposed, and if so emits
a structured decomposition-plan JSON as its final message. The platform's
existing write-back + seed machinery (idempotent issueCreate/issueRelationCreate
→ Mode A) consumes that plan; the agent does NOT create sub-issues itself.

Slots into BASE_PROMPT's {workflow} placeholder like the other coding variants,
so it inherits the clone/{repo_url}/{branch_name} environment — but its steps
override the PR-creation flow with a plan-emit deliverable (mirrors the
web_research "your final message IS the artifact" contract, for a repo-ful task).
"""

DECOMPOSE_WORKFLOW = """\
## Workflow — decomposition planning (no code changes, no PR)

You are PLANNING how a fleet of autonomous coding agents should tackle this \
issue in THIS repository. You will NOT write code, commit, or open a pull \
request. Your only deliverable is a decomposition plan (see below). A separate \
system turns your plan into Linear sub-issues and runs them — you do not create \
sub-issues yourself.

Your GOAL is to get the issue done as RELIABLY as possible — fewest errors — at \
reasonable cost. Decompose ONLY when splitting the work genuinely serves that \
goal; never split for its own sake, and never split one coherent feature across \
technical layers (interface / logic / stored state / tests) — a lone layer has \
no standalone value.

Follow these steps in order:

1. **Understand the repository and the issue**
   The repo `{repo_url}` is cloned at `{workspace}/{task_id}`. Read the README, \
the project layout, relevant modules, docs (ROADMAP/ARCHITECTURE/guides), and \
any existing tests — enough to judge what the issue actually entails HERE. A \
short issue title may name work that is much larger (or smaller) than it looks \
until you see the code. Use the repo; do not plan from the title alone.

2. **Decide: one cohesive unit, or a dependency-ordered breakdown?**
   Decompose when the issue genuinely contains two or more separable units of \
work that each stand on their own — a coherent change one agent could implement \
and a reviewer could judge in isolation, each delivering an identifiable piece \
of the goal. Keep it as ONE unit when the parts only make sense together, share \
mutable state, or must change in lockstep. A dependency/build-order between \
parts is NOT by itself a reason to merge them — ordering is handled for you.
   - If the issue is too thin to tell what the separable pieces are and the \
repository doesn't make them obvious either, say so (set ``decompose: false`` \
with a ``reasoning`` that asks for more detail) rather than guessing.

3. **If decomposing, draft the breakdown**
   - Propose only as many sub-issues as the work honestly has — fewer is \
better. The project enforces a hard cap and will reject an over-large plan, so \
keep the breakdown tight (a handful of units, not a long list). Each must be a \
VERTICAL SLICE an agent can implement on its own.
   - Give each a short imperative title and a one-paragraph scope, and a size: \
"S" (small/isolated), "M" (medium), or "L" (large/involved).
   - **Write the title and scope for the PERSON who filed the issue — who may \
not be an engineer.** Say WHAT each piece delivers and WHY, in plain language, \
before any implementation detail. Ground your plan in the repo, but do NOT lead \
with jargon: avoid raw file paths, framework/tool names (e.g. "Vitest", \
"serverless route"), or internal terms in the title, and keep them out of the \
first sentence of the scope. A reviewer should understand what they're approving \
without opening the codebase. It's fine to mention a specific file or tool later \
in the scope when it genuinely aids a technical reader — just don't make it the \
headline.
   - Express dependencies with ``depends_on``: zero-based indices into your own \
``sub_issues`` array of the sub-issues that must finish first. Independent \
sub-issues have ``depends_on: []``. Keep the critical path as short as the work \
honestly allows — parallelize independent work. Dependencies MUST form a DAG.

4. **Emit the plan as your FINAL message**
   Your final message IS the deliverable — it is captured as the task artifact \
and consumed by the platform. Output ONLY a single JSON object (no prose, no \
markdown fences) of this EXACT shape:
   ```
   {{
     "decompose": true,
     "reasoning": "one or two sentences explaining the verdict",
     "sub_issues": [
       {{ "title": "string", "description": "string", "size": "S"|"M"|"L", "depends_on": [int, ...] }}
     ]
   }}
   ```
   When you decide NOT to decompose, output `{{ "decompose": false, "reasoning": "...", "sub_issues": [] }}`.
   Do not include any text before or after the JSON object.
"""
