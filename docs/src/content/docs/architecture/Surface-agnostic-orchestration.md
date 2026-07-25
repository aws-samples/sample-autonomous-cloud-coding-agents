---
title: Surface agnostic orchestration
---

# Surface-agnostic sub-issue orchestration

**Status:** the Channel interface, its Linear + Jira adapters, and the engine rewiring
onto it are implemented. The channel-neutral ROW SHAPE (below) is not — the store still
carries `linear_*` field names. **Goal:** make the sub-issue orchestration engine work
across issue-tracking surfaces (Linear today; Jira next — a Jira comment-back path
already exists) behind one **Channel adapter interface**, so the generic engine has
no surface knowledge and each surface's specifics live in its own adapter.

## Principle

Maximize the surface-agnostic core; keep only genuinely surface-native behavior behind
the adapter. Matches vision tenet 8 (extensible via swappable interfaces, not per-tenant
forks) and reduces the current Linear/Jira duplication (both already expose parallel
`postIssueComment` / `reportIssueFailure`).

## What's already agnostic (keep)

- `orchestration-reconcile.ts` — 0 surface references; pure DAG state machine.
- `orchestration-dag.ts`, `orchestration-graph-source.ts` — already described as
  "trigger-agnostic … source-agnostic once a DAG exists"; a uniform graph interface
  already exists as a seam.

## What was coupled (and what still is)

- **Fixed** — the engine used to call surface operations directly
  (`upsertStatusComment`, `swapIssueReaction`/`swapCommentReaction`,
  `transitionIssueState`, `revertIssueToNotStarted`, `postIssueComment`,
  `reportIssueFailure`, `reactToComment`, `replyToComment`, `upsertThreadedReply`,
  `sweepDecompositionNotes`, `fetchSubIssueGraph`) from `orchestration-rollup.ts`,
  `orchestration-reconciler.ts`, `linear-webhook-processor.ts`, and
  `iteration-heartbeat-sweep.ts`. All of those now go through a `Channel`.
- **Still coupled** — `orchestration-store.ts` (~60 refs) + `orchestration-release.ts`
  (~33) carry surface-specific row FIELDS: `linear_issue_id`, `linear_workspace_id`,
  `linear_project_id`, `linear_oauth_secret_arn`, `linear_workspace_slug`,
  `linear_identifier`. Generalizing those is the separate slice below.
- **Still coupled** — `fetchIssueParentId` on the Linear-webhook entry path; that entry
  point is Linear-specific by definition, so it was left in place.

## The Channel adapter interface

A `Channel` captures everything the engine needs from a surface. The engine holds a
`Channel` and never names Linear/Jira. As built (`orchestration-channel.ts`):

```
interface Channel {
  readonly kind: 'linear' | 'jira';                 // for logging/metrics only

  // --- feedback: REQUIRED (unifies the duplicated linear-/jira-feedback) ---
  postComment(issue, body): Promise<CommentRef | null>;
  upsertComment(issue, body, existing?): Promise<CommentRef | null>;  // panel edit-in-place
  reportFailure(issue, message): Promise<void>;

  // --- feedback: OPTIONAL capabilities; the engine no-ops what a surface omits ---
  reactToComment?(comment, issue, reaction)        // ADD a marker (the receipt ack)
  replaceCommentReaction?(comment, issue, reaction) // make it the SOLE bot marker
  replaceIssueReaction?(issue, reaction)            // same, on the issue itself
  transitionState?(issue, intent, {allowRegression})  // running / awaiting-review / done
  revertState?(issue)                               // the one sanctioned backward move
  postThreadedReply?(issue, parent, body)
  upsertThreadedReply?(issue, parent, body, existing?, {preservePreview})
  sweepNotes?(issue, keep?)                         // collapse transient planning notes

  // --- graph (surface-specific derivation, uniform result) ---
  fetchChildGraph?(parent): Promise<ChannelSubIssueNode[]>;  // Linear: `blocks` relations
}
```

Two distinctions in there are load-bearing, not cosmetic:

- **add vs replace a reaction.** The receipt ack ADDS a marker (nothing to replace yet);
  a settle REPLACES the bot's own markers so one outcome shows rather than a pile. One
  method for both would either strip a marker the ack never meant to touch or leave two
  contradictory ones.
- **`started` vs `in_review` intent.** Some surfaces (Linear included) model both as the
  same state *category*, so the intent — not the category — is what says which the engine
  meant. Collapsing them would make the two transitions indistinguishable.

`fetchParentRef` was NOT added: the only parent lookup left in the engine is on the
Linear-webhook entry path, which is surface-specific by definition.

**Deliberately surface-SPECIFIC, kept behind the adapter (the "some features tied to a
surface" the design allows):**
- **Blocking / dependency relations** — Linear models these as native `blocks`
  issue-relations; another surface may have no equivalent and derive the DAG differently.
  So `fetchChildGraph` is the adapter's job; the engine only consumes the resulting DAG.
- **Comment formatting** — Linear takes markdown; Jira takes ADF (Atlassian Document
  Format). The adapter renders; the engine passes structured intent.
- **Reaction vocabulary** — mapped per surface inside the adapter (Linear emoji vs
  whatever Jira supports); the engine speaks a small `Reaction` enum.
- **Auth** — `oauth_secret_arn` / workspace slug become an opaque `credentials_ref`
  the adapter resolves; the engine never touches surface auth.

## Channel-neutral row shape (NOT yet implemented)

Generalize the orchestration rows:
`linear_issue_id → issue_ref`, `linear_workspace_id → workspace_ref`,
`linear_project_id → project_ref`, `linear_oauth_secret_arn → credentials_ref`,
`linear_workspace_slug → (folded into credentials_ref/adapter)`,
`linear_identifier → display_id`. Add `channel_kind` so the reconciler picks the adapter.

**Back-compat:** existing rows have `linear_*`; the store must read both (old `linear_*`
OR new neutral names) so in-flight orchestrations from before the migration still settle.

## What the feedback rewiring does NOT make surface-agnostic

The feedback axis is only one of the couplings. Jira orchestration is not reachable yet,
because seeding is still Linear-only end to end:

- Every `discoverOrchestration` caller hardcodes `channel_source: 'linear'`, and all of
  them sit on Linear paths (the Linear webhook processor and the reconciler).
- The Jira webhook processor has no orchestration/sub-issue path at all — it uses the
  single-issue comment-back only.
- Nothing selects an adapter from a stored `channel_source`; the entry points build the
  Linear channel directly, which is correct for a Linear webhook but means a Jira epic
  has no way in.

Reaching a Jira epic therefore also needs: a Jira graph source (or a declarative one),
a Jira seeding/trigger path, and `channel_source → adapter` selection in the reconciler.

## Divergence from linear-vercel + verification

This IMPROVES beyond lv (lv is Linear-coupled), so the carved code no longer matches lv
byte-for-byte — the `union == lv` safety net does not apply to refactored files.
Replacement proof: **deploy to dev and live-verify.** Linear is the reachable surface
today (see above), so the Linear epic path is what proves the shared engine end-to-end;
the Jira side is proven by its adapter's unit tests plus the existing comment-back path
until Jira seeding exists.

## Rollout within the carve

The engine + adapter land together (they're mutually dependent). The Linear adapter is
the first implementation (behavior parity with today); the Jira adapter unifies the
existing Jira comment-back onto the same interface. Kept as focused, fast-merging PRs.
