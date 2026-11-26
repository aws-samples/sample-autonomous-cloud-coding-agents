---
title: "Surface-agnostic sub-issue orchestration"
---

**Status.** The Channel interface, its Linear, Jira, and Slack adapters, the rewiring of the engine onto the interface, and the channel-neutral row shape are all implemented. Adapters are selected from a registry keyed on the `channel_source` stored on the row. **Goal.** Make the sub-issue orchestration engine work across issue-tracking surfaces behind one **Channel adapter interface**. Linear works today and Jira is next. A Jira comment-back path already exists. The generic engine then has no surface knowledge, and the specifics of each surface live in its own adapter.

**Scope of the "no core edit" claim.** The claim needs a precise statement, because the loose version of it is not true. Adding a surface needs no change to the *engine*. Nothing in discovery, release, reconcile, or rollup names a surface, and an adapter can be registered from its own module with `registerChannelFactory`. Three things outside the engine still need an edit, and none is hidden:

1. **Registry-table wiring per handler.** Each handler declares which surfaces' credentials registries it can reach (`CHANNEL_REGISTRY_TABLES` in the reconciler), plus the CDK env and the IAM grant behind that declaration. The declaration is a deployment decision about which tenants' secrets a Lambda may read, so it is deliberately explicit rather than inferred.
2. **`ChannelSource` is still a closed union** in `types.ts`, because task records and the CLI share it and several `switch`es rely on its exhaustiveness. The *registry* is open, because `channelForSource` takes a plain string. So a surface registered downstream resolves an adapter. It cannot yet be written into the `channel_source` of a task record.
3. **A seeding path.** See the last section. The feedback axis is agnostic, and the seeding axis is not.

## Principle

Maximize the surface-agnostic core, and keep behind the adapter only the behavior that is native to a surface. This principle matches vision tenet 8 (extensible through swappable interfaces, not per-tenant forks). It also reduces the current duplication between Linear and Jira, which both already expose parallel `postIssueComment` and `reportIssueFailure` functions.

## What's already agnostic (keep)

- `orchestration-reconcile.ts` has 0 surface references. It is a pure DAG state machine.
- `orchestration-dag.ts` and `orchestration-graph-source.ts` are already described as "trigger-agnostic … source-agnostic once a DAG exists". A uniform graph interface already exists as a seam.

## What was coupled (and what still is)

- **Fixed.** The engine used to call surface operations directly (`upsertStatusComment`, `swapIssueReaction`, `swapCommentReaction`, `transitionIssueState`, `revertIssueToNotStarted`, `postIssueComment`, `reportIssueFailure`, `reactToComment`, `replyToComment`, `upsertThreadedReply`) from `orchestration-rollup.ts`, `orchestration-reconciler.ts`, `linear-webhook-processor.ts`, and `iteration-heartbeat-sweep.ts`. All of those calls now go through a `Channel`.
- **Fixed.** The fields of the orchestration row are now channel-neutral, with dual-read backward compatibility (see the row-shape section below).
- **Still coupled.** `fetchIssueParentId` on the Linear-webhook entry path. That entry point is Linear-specific by definition, so the call was left in place.

## The Channel adapter interface

A `Channel` captures everything the engine needs from a surface. The engine holds a `Channel` and never names a concrete surface. As built (`orchestration-channel.ts`):

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
  upsertThreadedReply?(issue, parent, body, existing?, {preservePreview, skipIfSettled, repairIfOverwritten})
}
```

Two distinctions in the interface change behavior. They are not cosmetic:

- **Add versus replace a reaction.** The receipt ack adds a marker, because there is nothing to replace yet. A settle replaces the bot's own markers, so that one outcome shows rather than several. One method for both would either strip a marker that the ack never meant to touch or leave two contradictory markers.
- **`started` versus `in_review` intent.** Some surfaces, Linear included, model both as the same state *category*. So the intent, not the category, says which one the engine meant. Collapsing the two intents would make the two transitions indistinguishable.

`fetchParentRef` was not added. The only parent lookup left in the engine is on the Linear-webhook entry path, and that path is surface-specific by definition.

**Deliberately surface-specific, kept behind the adapter (the "some features tied to a surface" that the design allows):**
- **Blocking and dependency relations.** Linear models these as native `blocks` issue-relations. Another surface may have no equivalent and derive the DAG differently. So reading the graph is the job of a per-surface graph source (`orchestration-graph-source.ts`), not of the `Channel`. The engine only consumes the resulting DAG.
- **Comment formatting.** Linear takes markdown. Jira takes ADF (Atlassian Document Format). The adapter renders, and the engine passes structured intent.
- **Reaction vocabulary.** The adapter maps it per surface (Linear emoji, or whatever Jira supports). The engine uses a small `Reaction` enum.
- **Auth.** `oauth_secret_arn` and the workspace slug become an opaque `credentials_ref` that the adapter resolves. The engine never touches surface auth.

## Channel-neutral row shape (IMPLEMENTED)

The orchestration rows now use neutral names: `parent_linear_issue_id → parent_issue_ref`, `linear_workspace_id → credentials_ref`, `linear_identifier → display_id`.

**Backward compatibility is implemented, not planned.** Reads prefer the new attribute and fall back to the legacy one. Writes emit both names, so a rollback to the previous code can still read a row that the new code wrote. This was verified against the 133 pre-rename rows of the live table.

Three things were deliberately not renamed, because they are surface-specific rather than opaque: the `channel_metadata` keys handed to the agent (a cross-language contract that the Python agent reads), the `linearOauthSecretArn`/`WorkspaceSlug`/`ProjectId` release params, and the Linear workspace-registry table that the CLI writes.

## Proof the abstraction holds: the Slack adapter

Linear alone could not demonstrate that the interface is surface-agnostic. One implementation plus a comment-only stub is consistent with an interface shaped around that one surface. Slack is the counter-example that tests the interface, because Slack is a chat product rather than a tracker:

- **A thread is the issue.** `IssueRef.issueId` is `<channel>:<thread_ts>`. A message `ts` is the `CommentRef`, and `chat.update` lets one panel update in place.
- **It omits `transitionState` and `revertState`.** Slack has no workflow state. The methods are absent rather than stubbed to a silent success, because returning `true` would tell the engine that the platform mirrored a state that it never moved.
- **The engine drives it unmodified.** A rollup test runs the real Slack adapter through `upsertEpicPanel` with `mirrorParentState: true`, which asks for a state mirror that Slack cannot perform. The test asserts that the panel is still posted, that the ✅ marker goes on the thread root, and that nothing attempts a transition.

Slack's `replaceCommentReaction` also shows why the split between add and replace is per-surface rather than cosmetic. Slack has no atomic swap, so the adapter removes its own markers and then adds the target. The removal is scoped to the emoji that the adapter may have set, so a human's reaction survives.

## What the feedback rewiring does NOT make surface-agnostic

The feedback axis is only one of the couplings. Jira orchestration is not reachable yet, because seeding is still Linear-only end to end:

- Every `discoverOrchestration` caller hardcodes `channel_source: 'linear'`, and all of them are on Linear paths (the Linear webhook processor and the reconciler).
- The Jira webhook processor has no orchestration or sub-issue path at all. It uses only the single-issue comment-back.
- Adapter selection from a stored `channel_source` now exists (the registry), so the event-driven paths follow the row rather than assume Linear. Surface-specific entry points still build their adapter directly. That is correct for them, because a Linear webhook processor only ever handles Linear.

Reaching a Jira epic therefore still needs three things: a Jira graph source (or a declarative one), a Jira seeding or trigger path, and the Jira credentials registry wired into the handlers that would act on it (point 1 above).
