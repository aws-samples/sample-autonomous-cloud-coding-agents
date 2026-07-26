# Surface-agnostic sub-issue orchestration

**Status:** the Channel interface, its Linear + Jira + Slack adapters, and the engine
rewiring onto it are implemented, with adapters selected from a registry (a new surface
registers itself; no core edit). The channel-neutral ROW SHAPE (below) is not — the store still
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
- **Fixed** — the orchestration row FIELDS are now channel-neutral with dual-read
  back-compat (see the row-shape section below).
- **Still coupled** — `fetchIssueParentId` on the Linear-webhook entry path; that entry
  point is Linear-specific by definition, so it was left in place.

## The Channel adapter interface

A `Channel` captures everything the engine needs from a surface. The engine holds a
`Channel` and never names a concrete surface. As built (`orchestration-channel.ts`):

```
interface Channel {
  readonly kind: ChannelKind;   // open string, logging/metrics only — never branched on

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

## Channel-neutral row shape (IMPLEMENTED)

The orchestration rows now use neutral names: `parent_linear_issue_id → parent_issue_ref`,
`linear_workspace_id → credentials_ref`, `linear_identifier → display_id`.

**Back-compat is real, not aspirational:** reads prefer the new attribute and fall back to
the legacy one, and writes emit BOTH names, so a rollback to the previous code can still
read a row written by the new code. Verified against the live table's 133 pre-rename rows.

Deliberately NOT renamed, because they are genuinely surface-specific rather than opaque:
the `channel_metadata` keys handed to the agent (a cross-language contract the Python agent
reads), the `linearOauthSecretArn`/`WorkspaceSlug`/`ProjectId` release params, and the
Linear workspace-registry table the CLI writes.

## Proof the abstraction holds: the Slack adapter

Linear alone could not demonstrate surface-agnosticism — one implementation plus a
comment-only stub is consistent with an interface shaped around that one surface. Slack
is the counter-example that tests it, because it is a chat product rather than a tracker:

- **A thread is the issue.** `IssueRef.issueId` is `<channel>:<thread_ts>`; a message
  `ts` is the `CommentRef`, and `chat.update` is what lets one panel mature in place.
- **It OMITS `transitionState` / `revertState`** — Slack has no workflow state. They are
  absent rather than stubbed to a silent success, because returning `true` would tell the
  engine the platform mirrored a state it never moved. `sweepNotes` and `fetchChildGraph`
  are omitted too (bulk message deletion needs its own product decision; there is no
  dependency model to read a DAG from).
- **The engine drives it unmodified.** A rollup test runs the real Slack adapter through
  `upsertEpicPanel` with `mirrorParentState: true` — asking for a state mirror Slack
  cannot perform — and asserts the panel still lands, the ✅ marker goes on the thread
  root, and nothing attempts a transition.

Slack's `replaceCommentReaction` also shows why the add-vs-replace split is per-surface
rather than cosmetic: Slack has no atomic swap, so the adapter removes its OWN markers
(scoped to the emoji it may have set, so a human's reaction survives) and then adds the
target.

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
