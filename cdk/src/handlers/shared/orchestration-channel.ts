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

/** Which surface an adapter talks to. For logging/metrics only — the engine
 *  never branches on it. */
export type ChannelKind = 'linear' | 'jira';

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

/** Workflow-state intent the engine expresses; the adapter maps it to the
 *  surface's actual states. ``started`` ≈ In Progress, ``completed`` ≈ In Review /
 *  Done — the adapter picks the concrete state. */
export type StateIntent = 'started' | 'completed';

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

  /** Set a reaction on a comment, replacing any prior bot reaction. Optional —
   *  a surface without reactions omits this. */
  reactToComment?(comment: CommentRef, issue: IssueRef, reaction: Reaction): Promise<void>;

  /** Move the issue to a workflow state. Optional — a surface without a
   *  transition API omits this. */
  transitionState?(issue: IssueRef, intent: StateIntent): Promise<void>;

  // --- graph (surface-specific derivation, uniform result) ---

  /** Read the sub-issue graph rooted at a parent, with dependency edges resolved
   *  however the surface expresses them. Optional — a surface with no native
   *  sub-issue/dependency model omits this and the engine falls back to a
   *  declarative graph source. */
  fetchChildGraph?(parent: IssueRef): Promise<readonly ChannelSubIssueNode[]>;
}
