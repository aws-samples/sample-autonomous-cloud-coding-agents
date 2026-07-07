---
title: Plan mode refactor
---

# Plan Mode Refactor — "live-feeling" async planning (design spec)

> **SHIPPED STACK (on `fix/492-t1-short-negation`, off `be933e9`, deployed to dev, NOT pushed):**
> `c45c8bf` T1 (reject-guard) · `afba940` T4 (command grammar) · `6c8d8e2` T5 (maturing comment,
> command path) · `5c31b1c` T2 (warm digest) · `5fb96c5` F-prlink (PR link on ✅) · `6c1f368`
> F-single-gate (:decompose→single behind approval) · `ff37340` F-revise-in-place (semantic revise
> matures the ONE plan comment in place + settles the feedback comment 👀→✅; no split-thread reply).
> All live-verified on `abca-demo`
> (AgentCore) except F-prlink (verified same-run as F-single-gate) — see per-thread STATUS blocks +
> the ABCA-584/585 findings below. Remaining: T6/T7 (measure-first, deferred); ECS right-sized
> planning (separate workstream, `ECS_RIGHTSIZED_PLANNING.md`).
>
> **Status:** PROPOSAL for review by the #247-reporting fix session before any code lands.
> **Author:** QA/design pass (session 958d5e85), 2026-07-06.
> **Branch discipline:** HOLD — do not start until the #247-reporting fix session finishes
> (it is actively editing `linear-webhook-processor.ts`, `orchestration-reconciler.ts`, and the
> `orchestration-decomposition-*` modules; starting now guarantees a collision). When cleared,
> **branch from `be933e9`** (current HEAD as of 2026-07-06 — the "second PM QA batch": clarify-resume,
> mention word, single-task state, plan scope; stacked on `13ed124`), NOT from `13ed124`.
>
> **Correction (from the code owner, 2026-07-06):** most of the original T1 already shipped —
> `13ed124`/`be933e9` already gate verdicts on `short` (long negation → revise) and route a bare
> `@bgagent` (empty instruction) → nudge. So T1 is NOT "build the reject parser"; it's "close the
> **short-negation-with-instruction** gap" (see revised T1). And the reject/nudge/revise decision is
> **NOT contained in `parsePlanVerdict`** — it's the `(verdict, instruction-empty?)` routing in
> `linear-webhook-processor.ts` (~L1082–1156). Whoever takes T1 must own **both** the parser and that
> routing region; the "I own the parser, you own the processor" split does not hold for T1.

## 1. Problem

Mode B decompose planning (#299) is correct but **feels slow and clunky**, and it isn't the
architecture's fault — it's the *cost per turn*:

- Every `:decompose` and every revise round runs a **full `coding/decompose-v1` agent that
  clones the repo** and re-explores from scratch (~$0.20 / ~2 min a round). `MAX_DECOMPOSE_REVISIONS=3`
  exists *only* because each round is that expensive.
- Each turn is **cold context**: the revise task gets only the prior plan + feedback as text,
  not "here's what I already learned about this repo." All exploration is thrown away between rounds.
- The channel is inherently **turn-based** (Linear webhooks, human-time approval), but we've been
  paying live-session costs (full clone) for a conversation that isn't live.

**Goal:** make it *feel* like local Claude plan-mode — fast, iterative, conversational — while staying
**stateless on the cloud with NO held session by default.** The fix is not "hold the session"; it's
"make every turn cheap and most turns instant."

## 2. Non-goals / constraints (why not literal plan mode)

- **No held live session by default.** Approval is on human-time (minutes→days). Holding a
  microVM/Fargate task idle to wait for a Linear comment is metered idle compute + lifecycle
  complexity — exactly what #299 avoided (plan checkpoints to S3 + a pending-plan DDB row with a
  1-week TTL; the planning agent *completes*, no compute held).
- **Executor still full-clones.** Only the *planner* is decoupled to lighter context. On approve,
  fresh per-sub-issue execution agents spawn with real working trees. Delivered code is always
  against real HEAD, never a stale digest.
- **Nothing idles between turns.** Billing is per planning *run*; storage (digest + pending row) is
  KB, TTL'd, effectively free. "Finish same-day" is freshness hygiene, not a cost pressure.

## 3. The design, best-first (each is independently shippable)

### T1 — Close the short-negation-with-instruction gap (TACTICAL, ship first) ✅ SHIPPED + LIVE-VERIFIED
> **STATUS: DONE.** Implemented in a separate worktree, commit `c45c8bf` on branch
> `fix/492-t1-short-negation` (branched from `be933e9`), deployed to dev, live-verified on ABCA-574,
> full CDK build green (2902 tests). **NOT pushed / not merged (HOLD).** Fix session should review +
> cherry-pick/merge `c45c8bf`. What shipped: `parsePlanVerdict` gained an `'ambiguous'` output;
> `REJECT_PHRASES` split into `EXPLICIT_REJECT_PHRASES` (reject/discard/cancel/stop/abort + 👎🛑❌ →
> discard) vs `SOFT_NEGATION_PHRASES` (no/nope/nah/don't/-1); a SHORT soft-negation with a change
> instruction (verb or count) → `'none'` → revise; a soft-negation with no instruction → `'ambiguous'`
> → nudge. Routing in `linear-webhook-processor.ts` narrowed the verdict path to `approve|reject` (so
> `'ambiguous'` can't reach `runPlanVerdict`) and the nudge branch fires for `'ambiguous'` OR a bare
> mention. Live matrix on ABCA-574: `no, just 2 tasks` → **revise** (plan survived, "Updated
> breakdown"); bare `no` → **nudge** (`verdict:ambiguous`, plan survived); `reject` → **discarded**.
> Decision made: `'no, looks wrong'` → `'ambiguous'`/nudge (the safe choice; one test updated).

**Scope corrected by the code owner:** most of the original "reject parser" is ALREADY SHIPPED on
`13ed124`/`be933e9` — verdicts are gated on `short` (so a *long* negation-led comment →
revise, not discard — live-verified on ABCA-561), and a bare `@bgagent` (empty instruction) → nudge
(live-verified ABCA-556). **Do NOT rebuild that.** T1's remaining target is the ONE residual I caught
live:

- **The residual (live-caught, ABCA-562):** `@bgagent no, just 2 tasks` / `no, make it 3 tasks`
  — **short** (≤6 words) so `short === true`, `firstWord === "no"` → `parsePlanVerdict` returns
  `reject` → **plan DELETED.** It's a clear change instruction, and "make it 2 tasks" is literally the
  example in `renderPendingPlanNudge`. The shipped `short &&` guard only rescues *long* negations; the
  short-with-instruction case still discards.

**Root insight (from the "what is even the point of rejecting?" thread):** a pending plan is **inert**
— nothing runs/charges until approve, and it TTLs away in a week on its own. So **reject is a
low-value hygiene affordance, and the ONLY destructive/irreversible verb.** (Destructive-action
literature, §8: gate on severity × reversibility.) So discard should require *explicit* intent, and an
ambiguous negation should never silently destroy.

**The seam is NOT `parsePlanVerdict` alone (code owner's key correction).** Routing in
`linear-webhook-processor.ts` (~L1082–1156, in the owner's file) keys on **`(verdict, instruction-empty?)`**:
```
verdict !== 'none'                              → verdict path (approve / reject=discard)   L1084
verdict === 'none' && instruction non-empty     → REVISE (handlePlanRevision)               L1123
verdict === 'none' && instruction empty         → NUDGE (renderPendingPlanNudge)            L1138
```
A bare `"no"` has NON-empty text, so simply making the parser return `'none'` for it routes to
**REVISE** (spawns a pointless re-plan from the word "no"), NOT nudge. Achieving "ambiguous bare
negation → nudge" therefore needs EITHER:
- **(a)** a new parser output `'ambiguous'` (bare/near-bare negation with no instruction) that the
  processor routes to the nudge branch, OR
- **(b)** a routing change in `linear-webhook-processor.ts` that detects the same condition.

Either way **T1 must co-own the parser AND the L1082–1156 routing region** — the "I own the parser,
they own the processor" split does not hold here. **Recommend the fix session (owner of the processor)
either takes T1 or explicitly co-owns that region with me for T1.**

**Target behavior (the residual only — the rest already ships):**
- `no, make it 3 tasks` / `no, just 2 tasks` / `don't split the API` (short, but a real instruction) →
  **revise** (currently discards — THE FIX).
- `reject` / `discard` / `cancel` / `abort` / 👎🛑❌ → discard (unchanged).
- bare/near-bare `no` / `nope` / `no thanks` (no instruction) → **nudge** (needs the `'ambiguous'`
  output or routing branch above; today a bare "no" is short+firstWord → discard).
- `no, looks wrong` (pure evaluative, no instruction) — **decision point:** stays discard, or becomes
  nudge (safer)? One existing test asserts `→ reject`; flag for the owner.

**Discriminator:** a verdict-word-led comment is a *verdict* only when what remains after the verdict
token is empty or itself verdict/filler; a trailing imperative (make/split/add/keep/merge/drop/change/
rename) or any substantive instruction → revise.
**Files:** `orchestration-comment-trigger.ts` (`parsePlanVerdict`), `linear-webhook-processor.ts`
(routing L1082–1156), `orchestration-decomposition-render.ts` (nudge text), tests in
`orchestration-decomposition-flow.test.ts`.

### T2 — Warm repo digest, cache the exploration across revise rounds ✅ SHIPPED + LIVE-VERIFIED
> **STATUS: DONE + committed `5c31b1c`** on `fix/492-t1-short-negation` (stacked on T5). Full monorepo
> build green (agent 1197 + cli 575 + cdk 2929 tests + synth + docs). Deployed to dev; **live-verified
> on ABCA-582**: round-0 stored `repo_digest_sha b54d4786…` + a 1080-char structural digest; a SEMANTIC
> revise ("split the theme work into light/dark") dispatched a revise task that ran RUNNING (i.e.
> passed the guardrail — the digest rode in `channel_metadata`, not `task_description`) carrying
> `decompose_repo_digest` + `decompose_repo_digest_sha`, and produced "Updated breakdown — 5 sub-issues"
> (theme split as asked); round-1 re-emitted a fresh digest at the same sha (no drift note). A
> live-caught bug fixed en route: `repo.py` only captured `head_sha_before` on the PR-workflow branch,
> so the decompose task's sha was empty (ABCA-581) — now captured for non-PR clones too. NOT pushed.
>
> **Scope as built (decisions locked with the user):** caches the EXPLORATION, not the clone. The
> agent still shallow-clones each run (keeps escalate-to-read + grounding unchanged); it emits a
> compact `repo_digest` + the cloned HEAD sha (`repo_digest_sha`) in the plan JSON. A SEMANTIC revise
> (the kind T4's structural commands don't handle) feeds the prior digest back via `channel_metadata`
> (a NON-guardrail-screened channel — `task_description` is screened, so a structural blob there would
> trip PROMPT_ATTACK, the `bfc57c5` class) so the agent reuses the prior understanding instead of
> re-deriving it. **Honors P5** (no platform GitHub token): only the agent knows the sha (it clones),
> so the agent keys + drift-checks; the platform just plumbs the opaque digest + sha through the
> pending-plan row. **First plan still explores** — only revises reuse. Digest capped 4000 chars;
> `repo_digest_sha` hex-shape-guarded so a hallucinated value can't poison the key. **Deferred:** the
> S3/tree-sitter builder (option 2) — the digest rides in the plan JSON + DDB row for now, a clean
> swap-in seam behind the opaque-blob interface; and the fast-model tier (T6, isolate the variable).
> **T3 (drift) is folded in agent-side** (sha compare in the prompt), since the platform can't
> pre-check without the token P5 removed.

Planning doesn't need a full deep clone *per round* — it needs to answer "are there ≥2 separable,
independently-reviewable units, and what's the dependency shape?" That's a **structural** question.
**(Wording corrected per §8 research: a digest replaces re-reading the whole repo into context every
round; it does NOT mean the planner never touches the repo.)**

- **Build** a **structural digest** (module/dir map + per-module one-line responsibilities + key
  symbols; Aider-style tree-sitter symbol map ranked PageRank-style to a token budget — validated in
  §8) **once per `repo@sha`**. Building needs repo contents *that once* (shallow/sparse checkout or the
  GitHub tree+blobs API), not a full deep clone.
- **Cache** it (S3/DDB) and **reuse across every revision AND across issues at that sha** — this is
  where the "no re-clone per turn" win actually lives.
- Planner runs off the cached digest → seconds, cents. It **reads full file contents only on demand**
  (escalate-to-read); files targeted for editing at execution time are handled by the executor's real
  clone, not the digest.
- **Correctness backstops (non-negotiable — this is what keeps it from regressing to the blind
  planner that caused ABCA-490/492):**
  - **Escalate-to-read:** planner can do a targeted file read when a specific question needs it (not
    a full clone).
  - **Ask-when-unsure:** `request_clarification` (already on branch, commit `4116661`) + the
    underspecified/ask-for-detail path. A light context is *safe* because the planner may say "I need
    more" instead of hallucinating a split.

### T3 — Drift detection (makes T2 safe)
Cache is keyed `repo@sha`. Each planning/revision turn does a **cheap remote head-sha check**
(`git ls-remote origin <branch>` or `GET /repos/{o}/{r}/commits/{branch}`, ~100ms, no clone) vs. the
digest's sha.
- Match → warm hit.
- Mismatch → rebuild digest once (pay a read only when code actually changed), OR just **surface**
  it in the revised proposal ("main advanced N commits since this plan").
- Record *which branch/sha* the digest was keyed to (not assume `main`) so force-push / non-default
  branch is caught. Note: executor re-clones fresh at approve, so drift is a **plan-freshness/UX**
  concern, not a delivered-code bug.

### T4 — Direct-manipulation command grammar (BIGGEST "instant" win) ✅ SHIPPED + LIVE-VERIFIED
> **STATUS: DONE + committed `afba940`** on `fix/492-t1-short-negation` (stacked on T1's `c45c8bf`).
> Platform-only — NO agent contract change, NO clone, NO governance gate (same safe surface as T1).
> Full CDK build green (2916 tests, +14). Deployed to dev; **live-verified on ABCA-575** (a 6-node plan):
> `merge 5 and 6` → 5 nodes, joined title + `L` size + deps unioned, log `command applied … (no agent)`;
> `drop 4` → 4 nodes with the merged node correctly re-indexed 5→4; `make #3 small` → `S`; `drop 9`
> (out-of-range) → error note, plan untouched; `drop 2,3,4` (collapse) → collapse note, plan untouched
> (still 4 nodes); `approve` → seeded exactly the 4 edited nodes (proves edits persisted to the row
> approve consumes). NOT pushed (HOLD).
>
> Implemented: new pure module `orchestration-plan-commands.ts` — `parsePlanCommand` (STRICT: explicit
> verb + concrete 1-based indices → `drop`/`merge`/`size`, else `null` → falls through to the semantic
> revise loop) + `applyPlanCommand` (mutates `PlannedSubIssue[]` with correct positional `depends_on`
> re-indexing, drops edges to removed nodes + self/dup edges, re-validates DAG; `collapses` when <2
> nodes remain, `error` on out-of-range index — plan untouched in both). Webhook `handlePlanCommand`
> runs BEFORE verdict/revise/nudge: claim-once, `replacePendingPlan` (preserves `revision_round` — a
> structural edit is not an agent round), re-render via `renderPlanProposal`. New renderers
> `renderPlanCommandError` + `renderCommandCollapseNote`.
>
> Key correctness point that made this non-trivial: `depends_on` are POSITIONAL indices into the node
> array, so every drop/merge must remap all surviving edges (covered by unit tests: drop-middle-of-chain,
> multi-drop, merge-fold-with-downstream-remap, collapse, out-of-range).

Most revisions are *structural*, not semantic, and shouldn't touch the LLM at all. A terse grammar
mutates the pending-plan DDB row **deterministically, instantly, free**:
- `@bgagent drop 3` / `merge 1 2` / `size 2 S` → instant row edit + re-render, no agent. (`approve`/
  `reject` stay on the verdict path — they're not command verbs, so no collision.)
- Prose that isn't a recognized command → the semantic revise loop (T1's `none`→revise), and once the
  warm digest (T2) lands, that re-plan is itself fast.
- **This converges with T1:** `reject`/`discard` is explicit-intent discard; a bare `no` nudges;
  structural asks are deterministic commands; only genuine semantic changes spend an agent round.
- Constraint (confirmed by research — no buttons in Linear comments): the affordance is a short,
  forgiving command grammar, not clickable UI.
- **NOT yet done (deferred, low value):** `reorder` (cosmetic — positions don't affect execution, only
  display) and a natural-language alias layer. Left out on purpose to keep the parser strict.

### T5 — One maturing plan comment + live status (perceived latency) 🟡 PARTIAL (command slice shipped)
> **STATUS: command slice DONE + committed `6c8d8e2`** on `fix/492-t1-short-negation` (stacked on T4).
> `handlePlanCommand` now EDITS the stored `proposal_comment_id` in place (via `upsertStatusComment`'s
> existing edit path) instead of posting a fresh proposal per structural command, and carries the id
> forward so a sequence (`drop 3` → `merge 1 2` → `size 2 S`) matures ONE comment. Full build green
> (2921 tests; added isolated handler test `linear-webhook-plan-command.test.ts` — also fixed a
> function-coverage flake at the 94% gate, now 94.73%). Deploy + live-verify next.
>
> **NOT done (deferred, needs coordination / a UX call):**
> - Maturing the reconciler-side INITIAL proposal + the agent REVISE rounds into the same comment —
>   crosses into `orchestration-reconciler.ts` (the fix session's actively-edited file) and is a
>   judgment call (an edited comment far up-thread can be missed vs. a fresh "here's round N" ping).
> - Live PROGRESS edits during the slow agent turns (the `progress_writer` idea below).

- **Single edited comment**, not a stack of proposals (reuse the iteration-reply "maturing" pattern
  already in the codebase). The plan firms up in place = the async channel's closest thing to streaming.
- **Progress edits** during the unavoidable-slow turns ("cloning… reading `api/_lib`… drafting 3
  slices…") via existing `progress_writer` infra. Fills the silent gap; same latency feels responsive.
- **Reuse existing idempotency/claim-once guards** (UX.20 redelivery spam bug) — editing one comment
  across many webhook deliveries is the same surface that already bit this code.

### T6 — Fewer/better turns (planning quality)
- **Fast model for a bounded question:** run the ≥2-units/dependency-shape decision on a fast tier
  (Haiku) off the warm digest; escalate to a larger model only when ambiguous. Lower latency + cost.
- **Speculative pre-warm:** build the `repo@sha` digest the moment `:decompose` lands (or an issue
  enters a decompose-enabled project) so the *first* proposal is warm, not just revisions.
- **Per-repo/per-team planning memory:** remember how this repo tends to decompose (past approved
  plans, sizing conventions) → better first plans → fewer revision rounds. The "it knows my codebase"
  feel.
- **Crisp clarifying questions:** multiple-choice ("split by layer or by feature?") beats "tell me
  more" — one reply, one round.

### T7 — Measured keepalive (OPTIONAL, LAST, data-gated) — the "stay warm a minute" question
User asked: should the session stay warm 1–2 min waiting for a reply? **Recommendation: do NOT lead
with this.**
- **Reply latency is dominated by READ time** — a reviewer needs 1–3 min just to read a 5-node
  proposal. A 60–90s hold expires right as the median reviewer is forming their reply: you pay idle
  cost *and* still cold-start the real turn. Bad bet in the common case.
- Where a hold wins is the **active-review burst** (reviewer at desk, firing sub-90s follow-ups) — but
  **T4 (direct commands, free) + T2 (warm digest, seconds) already cover most of that burst.**
- So the residual value is only "semantic re-plans within ~90s of the last" — a thin slice — and
  holding reintroduces metered idle compute + session-lifecycle complexity.
- **Therefore:** build T2+T4 first, **measure the actual reply-latency distribution**, and add a
  keepalive ONLY if data shows a real cluster of sub-90s *semantic* re-plans. If added: tight adaptive
  window (60–90s, extend-on-activity, collapse-on-idle), hard per-plan/per-user idle cap, **never on
  the execution substrate** — affordable ONLY because T2 made planning compute small.
- **FIRST, try SnapStart, not keepalive (per §8 research).** If the planning-*dispatch* path is a
  Python Lambda, AWS **SnapStart** (Python 3.12+) gives sub-second cold-start from a publish-time
  microVM snapshot at **zero continuous cost** — likely making a keepalive on the Lambda side
  unnecessary. Always-warm Provisioned Concurrency bills continuously and is not cost-justified below
  ~1M req/month (a comment-triggered planner is far below that). So the ordering is: **SnapStart the
  Lambda → measure → only then consider an adaptive keepalive, and only on the agent substrate if at
  all.**

## 4. Cost / lifecycle model (the honest version, for user-facing docs too)
```
:decompose → plan (build digest, cache by repo@sha) → propose (DDB row + notes, 1-wk TTL)
   ├─ command ("drop 3","merge 1 2")   → instant deterministic edit, NO agent, free (T4)
   ├─ prose ("split the API")          → warm re-plan (rehydrate digest, seconds, cents) (T2)
   ├─ "no, make it 3 tasks"            → revise, NOT discard (T1)
   ├─ bare "no"                        → nudge to clarify (T1)
   ├─ "reject"/"discard"               → clean up row (manual early-clean; would TTL anyway)
   └─ approve                          → consume row → seed sub-issues → FRESH execution agents
                                         (digest persists, cached, for the repo's next issue)
```
- **No held compute** between turns → no idle metering. Billing is per planning run.
- Storage (digest + row) is KB, TTL'd → effectively free.
- "Act fast" pressure is **freshness** (repo drift + TTL), not billing.

## 5. Two audiences (reconciles the whole thread)
- **Developer at a terminal:** don't make server-side planning compete with a warm local Claude — it
  can't win. Make **"plan locally → create sub-issues → label parent → Mode A runs the graph
  directly"** a *first-class, documented* path (it already works; it's just undiscovered).
- **Non-terminal user (PM in Linear / mobile):** server-side decompose is their only option and who
  the slowness actually hurts → T2+T4+T5 make it snappy for them.

## 6. Suggested landing order (base: `be933e9`)
1. **T1** (close the short-negation-with-instruction gap) — tactical, fixes a live destructive defect.
   NOT independent of the processor: co-owns `parsePlanVerdict` + the L1082–1156 routing in
   `linear-webhook-processor.ts` (the code owner's file). Land first, but decide ownership up front.
2. **T2 + T3** (warm digest + drift) — the core latency/cost win. Needs a design issue (agent contract
   / new cache store) + the AGENTS.md governance step.
3. **T4** (command grammar) — biggest "instant" win; converges reject into commands.
4. **T5** (maturing comment + progress).
5. **T6** (fast model / pre-warm / memory) — incremental.
6. **T7** (SnapStart the dispatch Lambda first; keepalive only after measuring) — may prove unnecessary.

## 7. Open questions for the fix session
- **Ownership of T1:** the reject/nudge/revise decision spans `parsePlanVerdict` AND the
  `(verdict, instruction-empty?)` routing in `linear-webhook-processor.ts` (L1082–1156, owner's file).
  Does the fix session take T1, or explicitly co-own that routing region with me? (Can't be done in the
  parser alone — a bare "no" returning `'none'` routes to REVISE, not nudge.)
- **`'no, looks wrong'`** (pure evaluative, no instruction): stay discard or become nudge (safer)? One
  existing test asserts `→ reject` and would change.
- Does the residual bare-negation→nudge want a new parser output `'ambiguous'`, or a routing-side
  detector? (Owner's call — it's their file.)
- Where does the digest live — new DDB table vs. S3 prefix keyed `repo@sha`? Eviction/TTL policy?
- Is the digest built by a mini-agent, a Lambda with tree-sitter, or a reused read-only workflow?
- Agent-contract change for escalate-to-read + digest input (T2) and command-grammar (T4) — both need
  the "ask before major agent-contract change" governance step (AGENTS.md).
- Is the planning-dispatch path a Python 3.12+ Lambda (→ SnapStart-eligible for T7)?
- Metrics to add NOW so T7 is decidable later: per-round latency, human reply-gap distribution,
  fraction of revisions that are structural (T4-eligible) vs. semantic.

## 8. Research findings (prior art) — folded in 2026-07-06

Deep-research pass (24 sources fetched, 116 claims extracted, 25 adversarially verified 3-vote,
23 confirmed). **Net: the evidence supports the design's core choices, adds SnapStart as a concrete
option, and forces one correction to the "no clone" framing (T2/T3).**

**Validates measured keepalive over always-warm (T7):**
- Provisioned Concurrency (always-warm) **bills continuously** for reserved capacity even when an
  environment never serves a request; AWS recommends it only "when strict cold start latency
  requirements … can't be adequately addressed by SnapStart." (AWS Lambda dev guide; SnapStart doc)
- AWS explicitly: "Asynchronous workloads … are often less latency sensitive and so **do not usually
  need provisioned concurrency**." Caveat: AWS's discriminator is *latency-sensitivity*, and a planner
  engineered to *feel* interactive sits nearer the "benefits most" bucket — so the argument favors
  *adaptive/measured* keepalive, not "never warm."
- Practitioner breakeven (blog, unverified-tier): PC "pays off when sustained traffic exceeds ~5M–10M
  req/month per function"; not recommended under ~1M. **A comment-triggered planner is orders of
  magnitude below that** → always-warm PC is not cost-justified. Confirms T7 = measure-first, not
  always-warm.
- **NEW — SnapStart is the middle path I'd missed (add to T7):** resumes from an encrypted Firecracker
  microVM snapshot taken at publish time, **sub-second startup, NO continuous reserved cost**, usually
  no code changes (Java 11+, **Python 3.12+**, .NET 8+). Blog cites Java p99.9 5,114 ms → 488 ms.
  **This may make the keepalive question moot for the Lambda-side planner path** — if planning dispatch
  runs on a SnapStart-enabled Python Lambda, cold-start is already sub-second with zero idle cost.
  (Does NOT apply to the agent microVM/Fargate substrate — that's a different cold-start.)
- Cold-start "<1% of requests" is a steady-high-traffic figure and **explicitly does NOT hold for a
  bursty low-frequency planner** — the regime where warm environments decay. So don't hand-wave
  cold-start away; measure it for *this* workload (open question in §7).

**Validates the planner architecture (T2, T6, the approval gate itself):**
- Explicit decomposition beats plain CoT: least-to-most (Zhou et al., ICLR 2023) hit ≥99% vs 16% CoT
  on SCAN; Plan-and-Solve (Wang et al., ACL 2023) targets CoT "missing-step" errors. → decompose-then-
  execute is sound.
- **Graph-of-Thoughts (Besta et al., AAAI 2024) is the matching abstraction** for a dependency-ordered
  sub-issue graph (thoughts = vertices, edges = dependencies). Worth citing in the plan-schema design.
- **LLM/LRM plans carry NO correctness guarantee** and degrade sharply with plan *length* (o1-preview
  23.6% on 20–40-step plans; most successes <28 steps) and collapse without grounding (PlanBench,
  Kambhampati et al. 2024). → **directly justifies: short bounded sub-issues, the human approval gate,
  grounding, and external verification.** The gate isn't bureaucracy — it's the correctness backstop.
- Ask-before-acting is well-motivated: LLM agents "tend to arbitrarily generate the missed argument"
  rather than ask (next-token objective) — Wang et al., EMNLP 2025. → validates T2's `request_clarification`
  backstop. (NOTE: the specific accuracy-gain numbers from that paper were REFUTED in verification —
  cite the *behavioral motivation*, not the figures.)

**Validates T2 grounding — with an IMPORTANT correction:**
- Aider's repo map (tree-sitter symbol map, 130+ languages, ranked by `networkx.pagerank` over a
  file-dependency graph to a token budget, default ~1k tokens) and GraphCodeAgent's Structural-Semantic
  Code Graph both confirm **a cached structural digest is often sufficient grounding**, with the LLM
  requesting specific files only when needed. One example: 87-token map vs ~12k tokens to read all
  source.
- **CORRECTION to T2/T3 framing (the research explicitly flagged my conflation):** a repo map/digest
  still has to be *built* by parsing the repo — so the digest replaces **loading files into the LLM
  CONTEXT** (the token/latency win), NOT necessarily an on-disk checkout. Restate T2 precisely:
  - **Build** the digest once per `repo@sha` — this step needs repo *contents* (a shallow/sparse
    checkout or the GitHub API tree+blobs, done once, not a full deep clone per round).
  - **Reuse** the cached digest across every revision + across issues at that sha — this is where the
    "no re-clone per turn" win actually lives.
  - Planner reads **full file contents only on demand** (escalate-to-read), and **files being edited
    should be provided in full** — a map is for *locating*, not for *editing*.
  So the honest T2 claim is: *"stop re-cloning and re-reading the whole repo every revision,"* not
  *"never touch the repo."* Rebuild only on sha drift (T3).

**Validates T4 (command grammar) and T1 (reject semantics):**
- NN/g: for "many actions on many objects," a command-line/command grammar is *faster* than
  point-and-click direct manipulation → a terse `drop/merge/size` grammar is the right call for expert/
  bulk plan edits (T4). Shneiderman (direct-manipulation): the human initiating every action yields
  control + predictability → favors explicit commands + human-driven approval over agent inference.
- **Destructive-action safety (directly supports T1):** gate on **severity × reversibility, not merely
  "is it a delete"** (Smashing Magazine, 2024). Reject is destructive AND irreversible → it *should*
  require explicit intent, and everything ambiguous should route to the non-destructive path. Exactly
  the T1 reframe.
- Single maturing comment (T5): Slack's `chat.update` (edit in place via channel+ts) is the canonical
  pattern; supports one edited status message over comment-spam.
- Idempotency (T5): GitHub ("respond 2XX within 10s or the delivery is a failure") + Stripe ("endpoints
  might receive the same event more than once … log processed event IDs and skip") confirm the
  claim-once / dedup approach already in the codebase (UX.20). Ack fast, offload work.

**Caveat on evidence coverage:** areas 5 (HCI direct-manipulation) and 6 (async bot UX) had good
*sources* (NN/g, Shneiderman, GitHub, Stripe, Slack, Smashing) but those claims didn't survive into the
top-25 formally 3-vote-verified set (verification budget cap), so treat them as **well-sourced but not
adversarially verified in this pass** rather than proven. The AWS/planning/grounding findings ARE
3-vote verified.

**Two things this research CHANGES in the plan above:**
1. **Add SnapStart to T7** as the first thing to try for the Lambda-side planning path — it may remove
   the need for any keepalive there at zero idle cost. Keepalive discussion now applies mainly to the
   agent substrate, not the webhook/dispatch Lambda.
2. **Reword T2/T3** per the correction: "build digest once per sha (needs repo access then) → reuse
   cheaply → read full files on demand → rebuild on drift." Drop any implication the planner never
   accesses the repo.

### Key sources
- AWS Lambda Provisioned Concurrency / SnapStart docs; AWS Compute blog "Understanding and remediating
  cold starts."
- Least-to-Most (arXiv 2205.10625); Plan-and-Solve (2305.04091); Graph of Thoughts (2308.09687);
  Self-Consistency (2203.11171); PlanBench/o1 (2409.13373); Learning to Ask (2409.00557).
- Aider repo map (aider.chat/docs/repomap.html); GraphCodeAgent (arXiv 2504.10046).
- NN/g direct-manipulation; Shneiderman (ACM Interactions 1997); GitHub webhook best-practices; Stripe
  webhooks; Slack `chat.update`; Smashing "managing dangerous actions."
