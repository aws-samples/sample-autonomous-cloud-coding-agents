# Surface-agnostic sub-issue orchestration

**Status:** design for review. **Goal:** make the sub-issue orchestration engine work
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

## What's coupled today (to generalize)

- `orchestration-store.ts` (~60 refs) + `orchestration-release.ts` (~33) carry these
  surface-specific row fields: `linear_issue_id`, `linear_workspace_id`,
  `linear_project_id`, `linear_oauth_secret_arn`, `linear_workspace_slug`,
  `linear_identifier`.
- The engine calls these surface operations directly:
  `upsertStatusComment`, `swapIssueReaction`, `transitionIssueState`,
  `postIssueComment`, `reportIssueFailure`, `fetchSubIssueGraph`, `fetchIssueParentId`.

## The Channel adapter interface

A `Channel` captures everything the engine needs from a surface. The engine holds a
`Channel` and never names Linear/Jira.

```
interface Channel {
  readonly kind: 'linear' | 'jira';                 // for logging/metrics only

  // --- feedback (unifies the duplicated linear-/jira-feedback) ---
  postComment(issueRef, body): Promise<CommentRef>;
  updateComment(commentRef, body): Promise<void>;    // maturing panel edit-in-place
  react(commentRef, reaction: Reaction): Promise<void>;   // 👀/✅/❌/❓ mapped per surface
  transitionState(issueRef, state: IssueState): Promise<void>;  // In Progress/In Review/…
  reportFailure(issueRef, message): Promise<void>;

  // --- graph (surface-specific; SOME things stay native) ---
  fetchChildGraph(parentRef): Promise<SubIssueNode[]>;   // Linear: sub-issues + `blocks` relations
  fetchParentRef(issueRef): Promise<IssueRef | null>;
}
```

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

## Channel-neutral row shape

Generalize the orchestration rows:
`linear_issue_id → issue_ref`, `linear_workspace_id → workspace_ref`,
`linear_project_id → project_ref`, `linear_oauth_secret_arn → credentials_ref`,
`linear_workspace_slug → (folded into credentials_ref/adapter)`,
`linear_identifier → display_id`. Add `channel_kind` so the reconciler picks the adapter.

**Back-compat:** existing rows have `linear_*`; the store reads both (old `linear_*`
OR new neutral names) so in-flight orchestrations from before the migration still settle.

## Divergence from linear-vercel + verification

This IMPROVES beyond lv (lv is Linear-coupled), so the carved code no longer matches lv
byte-for-byte — the `union == lv` safety net does not apply to refactored files.
Replacement proof: **deploy to dev and live-verify BOTH surfaces** — a Linear epic AND
a Jira epic (or at minimum the Jira comment-back) exercise the shared path end-to-end.

## Rollout within the carve

The engine + adapter land together (they're mutually dependent). The Linear adapter is
the first implementation (behavior parity with today); the Jira adapter unifies the
existing Jira comment-back onto the same interface. Kept as focused, fast-merging PRs.
