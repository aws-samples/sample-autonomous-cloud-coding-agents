/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * Surface-agnostic channel abstraction for sub-issue orchestration.
 *
 * The orchestration engine (discovery, release, reconcile, rollup) drives issue
 * feedback — panel comments, reactions, state transitions, failure notices — and
 * reads the sub-issue graph. Historically it called the Linear API directly, so
 * the engine was Linear-only. This interface lets the engine speak to ANY
 * issue-tracking surface (Linear today, Jira next — a Jira comment-back path
 * already exists) without naming one: the engine holds a `Channel` and calls
 * these methods; each surface ships an adapter that implements them.
 *
 * Design boundary — what stays surface-SPECIFIC (behind the adapter):
 *  - **Dependency/blocking relations.** Linear models a sub-issue DAG with native
 *    `blocks` relations; another surface may have no equivalent and derive the
 *    graph differently. So `fetchChildGraph` is the adapter's job — the engine
 *    only consumes the resulting DAG.
 *  - **Comment formatting.** One surface takes markdown, another a structured
 *    document format. The adapter renders; the engine passes a plain-text body.
 *  - **Reaction vocabulary.** Each surface has its own reaction set; the engine
 *    speaks the small {@link Reaction} enum and the adapter maps it.
 *  - **Auth.** Credentials live behind an opaque `credentialsRef` the adapter
 *    resolves; the engine never touches surface auth.
 *
 * Capability-awareness: not every surface supports every operation (e.g. a
 * surface may have no reactions or no workflow-state transitions). Those methods
 * are OPTIONAL; the engine checks for presence and no-ops gracefully when a
 * surface can't do them, so the core stays uniform.
 *
 * Every method is best-effort and must not throw — feedback is advisory and must
 * never gate the orchestration itself (mirrors the existing per-surface helpers).
 */

/**
 * Which surface an adapter talks to — for logging and metrics only. The engine
 * never branches on it, which is why this is an open string rather than a union
 * of the surfaces that happen to exist today: a closed union here would mean
 * adding a surface requires editing this file, i.e. every consumer merging a
 * core change to support one more tracker. Adapters live outside this module and
 * name themselves.
 */
export type ChannelKind = string;

/**
 * A reference to an issue on some surface, plus the opaque credentials handle
 * the adapter needs to act on it. The engine treats every field as opaque.
 */
export interface IssueRef {
  /** The surface's issue identifier (Linear issue UUID, Jira issue key, …). */
  readonly issueId: string;
  /** Opaque credentials handle the adapter resolves (e.g. a workspace id that
   *  keys an OAuth-token registry row). The engine never interprets it. */
  readonly credentialsRef: string;
  /** Optional human-facing id for display in panels (e.g. ``ENG-42``). */
  readonly displayId?: string;
}

/** A reference to a comment the adapter created, so it can be edited/reacted to. */
export interface CommentRef {
  readonly commentId: string;
}

/** The small vocabulary of reactions the engine uses; the adapter maps each to
 *  the surface's own reaction (emoji, etc.). */
export type Reaction = 'started' | 'succeeded' | 'failed' | 'needs_input';

/**
 * Workflow-state intent the engine expresses; the adapter maps it to the
 * surface's actual states. Three intents rather than two because the engine
 * genuinely distinguishes "work is running" from "work is done, awaiting human
 * review" — on some surfaces (Linear included) both are the same underlying
 * state *category*, so collapsing them would make the engine unable to say
 * which one it meant:
 *  - ``started``   ≈ In Progress — a child was released and is running.
 *  - ``in_review`` ≈ In Review — work finished, a human still has to merge it.
 *  - ``completed`` ≈ Done — the surface's terminal state.
 */
export type StateIntent = 'started' | 'in_review' | 'completed';

/** Options for {@link Channel.transitionState}. */
export interface TransitionOptions {
  /**
   * Allow a move that the adapter would otherwise refuse as backward *within
   * the same state category* — the deliberate re-open, when a settled epic
   * gains a new or re-run child and must go from "awaiting review" back to
   * "running". Without this the move is silently dropped as a regression.
   * Demotion across categories (something already terminal, e.g. a human
   * marked it done) stays blocked regardless.
   */
  readonly allowRegression?: boolean;
}

/** Options for {@link Channel.upsertThreadedReply}. */
export interface ThreadedReplyOptions {
  /**
   * Carry over a preview/deploy link that a SEPARATE async writer may already
   * have appended to this reply. Two writers converge on one comment (the
   * orchestration settle and the preview-capture callback), and whichever
   * lands second would otherwise clobber the other's text. When set, the
   * adapter reads the current body and preserves that segment.
   */
  readonly preservePreview?: boolean;
  /**
   * Set on a PROGRESS render to yield to an outcome that has already landed.
   * Progress and terminal states are written by independent paths, and the
   * progress one can be delivered late — overwriting a settled reply with
   * "working" would contradict both the outcome and the surface's own markers.
   * A surface that cannot read a body back simply ignores this.
   */
  readonly skipIfSettled?: boolean;
  /**
   * Set on a TERMINAL render to check the outcome survived, and restore it if a
   * concurrently-delivered progress render landed on top.
   *
   * The counterpart to {@link skipIfSettled}, and needed because that check is a
   * read followed by a separate write: it narrows the window without closing it.
   * A surface offering no conditional/versioned update (Linear does not) cannot
   * close it at all, so the writer that holds the body worth keeping verifies
   * afterwards instead. Adapters without a body read simply ignore this.
   */
  readonly repairIfOverwritten?: boolean;
}

/** A node in the sub-issue graph, as the adapter surfaces it to the engine. */
export interface ChannelSubIssueNode {
  readonly issueId: string;
  readonly displayId?: string;
  readonly title?: string;
  /** issueIds this node depends on (blocked-by). How the adapter derives this
   *  is surface-specific (Linear: `blocks` relations); the engine just reads it. */
  readonly dependsOn: readonly string[];
}

/**
 * A surface adapter. The orchestration engine holds one of these and never names
 * a concrete surface. Implementations: {@link makeLinearChannel} today; a Jira
 * adapter unifies the existing Jira comment-back onto the same interface.
 */
export interface Channel {
  readonly kind: ChannelKind;

  // --- feedback (every surface must support these) ---

  /** Post a comment on an issue; returns a ref so it can be edited later, or
   *  null if the post failed (best-effort). ``body`` is plain text/markdown; the
   *  adapter renders it for the surface. */
  postComment(issue: IssueRef, body: string): Promise<CommentRef | null>;

  /** Edit a previously-posted comment in place (the maturing status panel). When
   *  no ref is given, create + return one. Returns the (new or existing) ref, or
   *  null on failure. */
  upsertComment(issue: IssueRef, body: string, existing?: CommentRef): Promise<CommentRef | null>;

  /** Post a failure notice on the issue (❌ + message). Best-effort. */
  reportFailure(issue: IssueRef, message: string): Promise<void>;

  // --- optional per-surface capabilities (engine no-ops if absent) ---

  /**
   * ADD a reaction to a comment, leaving any existing reaction in place. This is
   * the instant "I saw your request" ack, set the moment a comment arrives —
   * before any work exists to report on, so there is nothing to replace yet.
   *
   * Deliberately distinct from {@link replaceCommentReaction}: adding is not the
   * same as replacing, and conflating them would either strip a marker the ack
   * path never meant to touch, or leave two contradictory markers on a settled
   * comment. Returns true if the reaction landed.
   */
  reactToComment?(comment: CommentRef, issue: IssueRef, reaction: Reaction): Promise<boolean>;

  /**
   * Make ``reaction`` the SOLE bot reaction on a comment, clearing the bot's own
   * prior markers first — used when work settles, so the comment shows one
   * outcome rather than an accumulated pile ("saw it" + "done" at once).
   * A human's reactions are never touched. Idempotent: re-running converges on
   * the same single marker.
   *
   * Returns true only when that end state was actually reached: the target is
   * present AND no prior bot marker was left behind. Reporting the add alone
   * would claim success while the surface still shows two contradictory markers —
   * and a caller checking this result is checking for exactly that contradiction,
   * since it is what makes a settled item look unsettled.
   */
  replaceCommentReaction?(comment: CommentRef, issue: IssueRef, reaction: Reaction): Promise<boolean>;

  /**
   * Make ``reaction`` the sole bot reaction on the ISSUE itself (not a comment) —
   * the at-a-glance status marker on a parent epic or a child, which matures
   * across separate invocations. Same replace-only-our-own-markers contract and
   * same all-or-nothing result as {@link replaceCommentReaction}.
   */
  replaceIssueReaction?(issue: IssueRef, reaction: Reaction): Promise<boolean>;

  /**
   * Move the issue to a workflow state. Optional — a surface without a
   * transition API omits this. Adapters must refuse to move an issue BACKWARD
   * (something a human or automation already advanced stays advanced), except
   * where ``options.allowRegression`` opts into a same-category re-open.
   * Returns true only on a confirmed transition (false when skipped as
   * already-there or backward).
   */
  transitionState?(issue: IssueRef, intent: StateIntent, options?: TransitionOptions): Promise<boolean>;

  /**
   * Move the issue BACK to a not-started state. The one sanctioned backward
   * move: work the engine had marked as running has stopped without succeeding
   * (a plan now awaits a human's approval, or a child failed), so leaving it
   * "in progress" would misreport a run that isn't happening. Adapters must
   * guard this to only demote an issue still in the state the engine itself
   * set, never one a human has since advanced or pulled back. Returns true only
   * on a confirmed move.
   */
  revertState?(issue: IssueRef): Promise<boolean>;

  /**
   * Post a threaded reply beneath an existing comment. Unlike editing, a reply
   * notifies and reads as a conversation turn under the original request.
   * Returns a ref to the new reply, or null on failure.
   */
  postThreadedReply?(issue: IssueRef, parent: CommentRef, body: string): Promise<CommentRef | null>;

  /**
   * The MATURING threaded reply: edit ``existing`` in place when given, else
   * create a reply under ``parent``. One reply that matures through its
   * lifecycle, instead of a new comment per transition. Returns the (new or
   * existing) ref, or null on failure.
   */
  upsertThreadedReply?(
    issue: IssueRef,
    parent: CommentRef,
    body: string,
    existing?: CommentRef,
    options?: ThreadedReplyOptions,
  ): Promise<CommentRef | null>;

  /**
   * Delete the engine's own transient planning notes from an issue thread,
   * keeping ``keep`` if given. Interim notes are posted fire-and-forget from
   * many places, so once a plan settles the thread needs collapsing to just the
   * outcome. Adapters must scope deletion to the bot's own notes — never a
   * human's comment, and never the durable status panel. Returns how many were
   * removed.
   */
  sweepNotes?(issue: IssueRef, keep?: CommentRef): Promise<number>;

  // --- graph (surface-specific derivation, uniform result) ---

  /** Read the sub-issue graph rooted at a parent, with dependency edges resolved
   *  however the surface expresses them. Optional — a surface with no native
   *  sub-issue/dependency model omits this and the engine falls back to a
   *  declarative graph source. */
  fetchChildGraph?(parent: IssueRef): Promise<readonly ChannelSubIssueNode[]>;
}
