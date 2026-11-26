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
 * Which surface an adapter talks to — for logging and metrics only. The engine
 * never branches on it.
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
  /** Optional surface workflow names resolved when the issue was admitted. */
  readonly stateOverrides?: {
    readonly started?: string;
    readonly inReview?: string;
  };
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
 * surface's actual states:
 *  - ``started``   ≈ In Progress — a child was released and is running.
 *  - ``in_review`` ≈ In Review — work finished, a human still has to merge it.
 *  - ``completed`` ≈ Done — the surface's terminal state.
 */
export type StateIntent = 'started' | 'in_review' | 'completed';

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

export interface ThreadedReplyOptions {
  /**
   * Carry over a preview/deploy link that a SEPARATE async writer may already
   * have appended to this reply. When set, the adapter reads the current body
   * and preserves that segment.
   */
  readonly preservePreview?: boolean;
  /**
   * Set on a PROGRESS render to yield to an outcome that has already landed.
   * A surface that cannot read a body back simply ignores this.
   */
  readonly skipIfSettled?: boolean;
  /**
   * Set on a TERMINAL render to check the outcome survived, and restore it if a
   * concurrently-delivered progress render landed on top. Adapters without a
   * body read simply ignore this.
   */
  readonly repairIfOverwritten?: boolean;
}

/**
 * A surface adapter. The orchestration engine holds one of these and never names
 * a concrete surface. Optional methods are capabilities a surface may lack: the
 * engine checks for presence and no-ops when one is absent. Every method is
 * best-effort and must not throw.
 */
export interface Channel {
  readonly kind: ChannelKind;

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

  /**
   * ADD a reaction to a comment, leaving any existing reaction in place.
   * Returns true if the reaction landed.
   */
  reactToComment?(comment: CommentRef, issue: IssueRef, reaction: Reaction): Promise<boolean>;

  /**
   * Make ``reaction`` the SOLE bot reaction on a comment, clearing the bot's own
   * prior markers first. A human's reactions are never touched. Idempotent:
   * re-running converges on the same single marker.
   *
   * Returns true only when that end state was actually reached: the target is
   * present AND no prior bot marker was left behind.
   */
  replaceCommentReaction?(comment: CommentRef, issue: IssueRef, reaction: Reaction): Promise<boolean>;

  /**
   * Make ``reaction`` the sole bot reaction on the ISSUE itself (not a comment).
   * Same replace-only-our-own-markers contract and same all-or-nothing result as
   * {@link replaceCommentReaction}.
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
   * Move the issue BACK to a not-started state. Adapters must guard this to
   * only demote an issue still in the state the engine itself set, never one a
   * human has since advanced or pulled back. Returns true only on a confirmed
   * move.
   */
  revertState?(issue: IssueRef): Promise<boolean>;

  /**
   * Post a threaded reply beneath an existing comment. Returns a ref to the new
   * reply, or null on failure.
   */
  postThreadedReply?(issue: IssueRef, parent: CommentRef, body: string): Promise<CommentRef | null>;

  /**
   * The MATURING threaded reply: edit ``existing`` in place when given, else
   * create a reply under ``parent``. Returns the (new or existing) ref, or null
   * on failure.
   */
  upsertThreadedReply?(
    issue: IssueRef,
    parent: CommentRef,
    body: string,
    existing?: CommentRef,
    options?: ThreadedReplyOptions,
  ): Promise<CommentRef | null>;
}
