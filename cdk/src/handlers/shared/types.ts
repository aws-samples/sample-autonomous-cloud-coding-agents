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

import sharedConstants from '../../../../contracts/constants.json';
import type { TaskStatusType } from '../../constructs/task-status';
import { classifyError, type ErrorClassification } from './error-classifier';
import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';
import type { ComputeType } from './repo-config';

export type { TaskStatusType };

/**
 * A resolved workflow pin: the ``{id, version}`` produced at the create-task
 * boundary from a ``workflow_ref`` (or the resolution fallback). Persisted on
 * the TaskRecord and threaded to the agent so it loads the exact pinned
 * workflow file.
 */
export type ResolvedWorkflow = {
  readonly id: string;
  readonly version: string;
};

/**
 * A resolved registry-asset pin stamped on the TaskRecord for audit (#246):
 * ``{kind, id, version}`` where ``id`` is ``namespace/name``. The full runtime
 * payload is NOT persisted here — it rides in the agent invocation payload; this
 * triple is the immutable record of *what* the task loaded.
 */
export type ResolvedAssetTriple = {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
};

/** `POST /registry/records` request body. */
export type RegistryPublishRequest = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  /** semver string, immutable once written. */
  readonly asset_version: string;
  /** discovery descriptor body (server.json / SKILL.md / arbitrary JSON). */
  readonly discovery: Record<string, unknown>;
  /** ABCA runtime payload (connection config / cedar text / prompt fragment). */
  readonly runtime: Record<string, unknown>;
  /** force CUSTOM (verbatim) storage instead of a native descriptor. */
  readonly custom?: boolean;
  /** dev convenience: drive create→submit→approve so the record resolves. */
  readonly auto_approve?: boolean;
};

/** One version row in a `show` response. */
export type RegistryVersionSummary = {
  readonly version: string;
  readonly status: string;
  readonly created_at: string | null;
  readonly publisher: string | null;
  /** True when the record's descriptor payload failed to parse. `publisher` lives
   *  in the erased payload so it is unrecoverable (reads `null`); `created_at` is
   *  envelope data and is nulled only by the `show` marker's convention, not
   *  because it is lost. */
  readonly malformed?: boolean;
};

/** `GET /registry/records/{kind}/{namespace}/{name}` response — one asset's
 *  versions. */
export type RegistryShowResponse = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly versions: readonly RegistryVersionSummary[];
};

/** A record envelope returned by publish / show. */
export type RegistryRecordResponse = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: string;
  readonly storage_mode: string;
};

/** `GET /registry/resolve?ref=…` response. */
export type RegistryResolveResponse = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly runtime: Record<string, unknown>;
  readonly warnings: readonly string[];
};

/** One asset row in a `list` response. */
export type RegistryListEntry = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly latest_version: string | null;
  readonly status: string;
};

export type AttachmentType = 'image' | 'file' | 'url';

/**
 * Provenance of a task's submission. Shared across inbound adapters:
 * - ``api``: CLI / Cognito-authenticated submissions
 * - ``webhook``: HMAC-signed inbound webhook submissions (generic webhook endpoint)
 * - ``slack``: Slack @mention / slash-command submissions (see SlackIntegration)
 * - ``linear``: Linear label-triggered submissions (see LinearIntegration)
 * - ``jira``: Jira Cloud label-triggered submissions (see JiraIntegration)
 */
export type ChannelSource = 'api' | 'webhook' | 'slack' | 'linear' | 'jira';

/**
 * Full task record as stored in DynamoDB.
 */
export interface TaskRecord {
  readonly task_id: string;
  readonly user_id: string;
  /** Cognito group names captured at admission for team-budget rollups. */
  readonly team_ids?: readonly string[];
  readonly status: TaskStatusType;
  /** Target repository (``owner/repo``). Optional: a repo-less workflow
   *  (``requires_repo: false``) runs with no repo. */
  readonly repo?: string;
  readonly issue_number?: number;
  /** GitHub issue title, stored when the issue is read at hydration so lists can
   *  name the task. Display only; never fed back into the prompt. */
  readonly issue_title?: string;
  /** The ref the caller supplied (if any); resolution may fall back to a
   *  default when absent. Persisted for audit alongside ``resolved_workflow``. */
  readonly workflow_ref?: string;
  /** The pinned ``{id, version}`` this task runs. Resolved at the create-task
   *  boundary; optional only on records that predate the cutover. */
  readonly resolved_workflow?: ResolvedWorkflow;
  /** Registry assets (#246) resolved for this task, stamped by the orchestrator
   *  at task start for audit. Absent when the blueprint pins no assets. */
  readonly resolved_assets?: ResolvedAssetTriple[];
  readonly pr_number?: number;
  readonly task_description?: string;
  readonly branch_name: string;
  readonly session_id?: string;
  /** AgentCore runtime ARN used for this session (StopRuntimeSession on cancel). */
  readonly agent_runtime_arn?: string;
  /** ISO timestamp of last agent heartbeat (DynamoDB); optional, written by the runtime. */
  readonly agent_heartbeat_at?: string;
  readonly execution_id?: string;
  readonly pr_url?: string;
  /**
   * Public CloudFront URL of the deploy-preview screenshot captured for this
   * task's PR (#247). Absent until a preview deploys (and for tasks with no UI
   * to screenshot).
   */
  readonly screenshot_url?: string;
  /**
   * Live deploy-preview URL the {@link screenshot_url} image was captured from
   * (e.g. the Vercel/Netlify preview deploy). Absent when no preview deployed.
   */
  readonly screenshot_preview_url?: string;
  readonly error_message?: string;
  readonly idempotency_key?: string;
  readonly channel_source: ChannelSource;
  readonly channel_metadata?: Record<string, string>;
  /**
   * Linear issue UUID, hoisted to the top level from
   * ``channel_metadata.linear_issue_id`` at task-create time (#247 UX.3).
   * Top-level because a DynamoDB GSI (``LinearIssueIndex``) cannot key off a
   * nested map field. Present only for Linear-origin tasks.
   */
  readonly linear_issue_id?: string;
  /** Sparse JiraIssueIndex key (`{cloudId}#{issueKey}`); internal only. */
  readonly jira_issue_identity?: string;
  readonly status_created_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  /** The agent stores these two and the turn counters below as DynamoDB
   *  Strings; read them through ``coerceNumericOrNull``. */
  readonly cost_usd?: number | string;
  readonly duration_s?: number | string;
  readonly build_passed?: boolean;
  /**
   * Whether a PR-iteration advanced the branch HEAD (a real commit) vs. ran
   * with no change (a question-only ``@bgagent`` comment) (#299). Absent for
   * pre-fix tasks / non-iterations.
   */
  readonly code_changed?: boolean;
  /** The agent's answer, surfaced on a no-change iteration reply (#299). */
  readonly answer_text?: string;
  /**
   * The branch HEAD sha this iteration pushed. Absent on pre-fix / non-PR tasks.
   */
  readonly head_sha?: string;
  /** Whether the post-run lint gate passed (#515). Written with `build_passed`
   *  at terminal state; absent on tasks that predate the field. */
  readonly lint_passed?: boolean;
  /**
   * OTEL trace id (32-char hex) of the task's root span (#515), captured at
   * terminal write for cross-plane correlation in the replay bundle. Absent on
   * tasks that predate the field or that ran with tracing unavailable.
   */
  readonly otel_trace_id?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  /**
   * Whether the task was submitted with ``--trace`` (design §10.1).
   * When true the orchestrator threads a ``trace: true`` flag into the
   * agent payload; the agent's ``_ProgressWriter`` raises its preview
   * cap from 200 chars to 4 KB.
   */
  readonly trace?: boolean;
  /**
   * S3 URI of the gzipped JSONL trajectory dump written by the agent on
   * terminal state when ``trace`` is true (design §10.1). Shape:
   * ``s3://<trace-bucket>/traces/<user_id>/<task_id>.jsonl.gz``. Absent
   * until the agent finishes the upload; also absent for tasks that ran
   * without ``--trace`` or whose upload failed.
   */
  readonly trace_s3_uri?: string;
  /** S3 URI of a repo-less workflow's delivered artifact (deliver_artifact,
   *  #248 Phase 3); absent for coding tasks / comment-only delivery. */
  readonly artifact_uri?: string;
  /** The Claude Code CLI's own turn count, kept raw for debugging. Not the
   *  count `max_turns` limits, and it can exceed the limit on a task that
   *  never reached it: see `TaskResult` in `agent/src/models.py`. */
  readonly turns_attempted?: number | string;
  /** Turns that actually completed: the model's answers, which is what
   *  `max_turns` limits (clamped to it). */
  readonly turns_completed?: number | string;
  readonly prompt_version?: string;
  readonly memory_written?: boolean;
  readonly compute_type?: ComputeType;
  /** Approval-wait seconds before MicroVM sleep; 0 keeps it awake. Captured at submission. */
  readonly microvm_sleep_after_s?: number;
  readonly compute_metadata?: Record<string, string>;
  readonly ttl?: number;
  /**
   * Optional per-task override for the FanOutConsumer's channel filters
   * (design §6.5). When present, the router uses these settings instead
   * of the per-channel defaults.
   */
  readonly notifications?: TaskNotificationsConfig;
  /**
   * ID of the single GitHub issue comment the fan-out plane maintains
   * for this task (design §6.4 — edit-in-place). Written by the
   * GitHub dispatcher on the first delivery; read on subsequent
   * deliveries to PATCH instead of POST. Absent until the first
   * dispatch fires successfully.
   */
  readonly github_comment_id?: number;
  /**
   * Event ID of the terminal event whose Linear final-status comment
   * was successfully posted (fan-out plane). This marker makes the
   * post idempotent across partial-batch Lambda retries. Absent until
   * the first successful post.
   */
  readonly linear_final_comment_event_id?: string;
  /**
   * Event ID of the ``pr_created`` milestone whose Linear "PR opened"
   * courtesy comment was successfully posted (fan-out plane, ADR-016 P4.5).
   * Makes the first-run PR-opened comment post-once across partial-batch
   * Lambda retries. Absent until the first successful post.
   */
  readonly linear_pr_comment_event_id?: string;
  /**
   * ISO timestamp of the last keep-alive activity the fan-out plane emitted
   * into this task's Linear agent session (ADR-018 Phase 2). Throttles the
   * per-turn heartbeat to one activity per window so a long run never lets
   * the session go ``stale`` (30 min idle) without flooding it. Absent for
   * non-session tasks.
   */
  readonly linear_session_heartbeat_at?: string;
  /**
   * Event id of the ``pr_created`` whose PR link was attached to the Linear
   * agent session's header. Separate from ``linear_pr_comment_event_id``
   * (the "Opened pull request" activity) so each is retried on its own and the
   * appended link is never duplicated.
   */
  readonly linear_session_pr_link_event_id?: string;
  /**
   * Event ID of the terminal event whose ordinary Jira final-status comment
   * was successfully posted (fan-out plane). This marker makes that create
   * idempotent across partial-batch Lambda retries. Comment-triggered
   * iterations edit their stored status comment instead and do not use this
   * marker. Absent until the first successful ordinary-task post.
   */
  readonly jira_final_comment_event_id?: string;
  /** Durable Jira iteration body, merged with preview metadata by every writer. */
  readonly jira_iteration_status?: { readonly body: Record<string, unknown>; readonly terminal: boolean };
  /**
   * At-most-once claim for the standalone preview comment POST. The claim is
   * the presence of the attribute (the write is conditional on
   * ``attribute_not_exists``), so it is never ``false``.
   */
  readonly jira_preview_claimed?: true;
  readonly jira_preview_comment_id?: string;
  readonly attachments?: AttachmentRecord[];
  /**
   * Cedar HITL: per-task default approval timeout (design §10.2).
   * Default 300s when absent. The engine clamps to
   * ``[APPROVAL_TIMEOUT_S_MIN, APPROVAL_TIMEOUT_S_MAX]`` at task
   * start; min-wins against per-rule ``@approval_timeout_s`` at
   * gate-firing time.
   */
  readonly approval_timeout_s?: number;
  /**
   * Cedar HITL: pre-approval allowlist scopes from submit time
   * (design §10.2, §7.3 step 4). The engine seeds
   * ``ApprovalAllowlist`` from this list at container start so
   * gates matching any scope here never fire.
   */
  readonly initial_approvals?: readonly string[];
  /**
   * Cedar HITL: running counter of approval gates fired on this
   * task (design §10.2, §13.6). Enforced against
   * ``approvalGateCap`` (decision #13); survives container restart
   * so cumulative damage is bounded across restarts.
   */
  readonly approval_gate_count?: number;
  /**
   * Cedar HITL: per-task cap on total approval gates (design §4 step 5,
   * §13.6, decision #13). Resolved at submit-time from
   * ``Blueprint.security.approvalGateCap ?? 50`` and persisted here so
   * the cap is captured at submit and NOT re-read from the blueprint
   * during a container restart (mid-task blueprint edits must not
   * shift the cap beneath a running task). Bounded to ``[1, 500]``
   * by create-task validation to match the agent-side
   * ``APPROVAL_GATE_CAP_MIN / MAX`` constants in ``agent/src/policy.py``.
   */
  readonly approval_gate_cap?: number;
  /**
   * Cedar HITL: when ``status = AWAITING_APPROVAL``, the
   * ``request_id`` of the pending approval row. Cleared
   * atomically on resume (§10.2, §9).
   */
  readonly awaiting_approval_request_id?: string;
  /**
   * Admission queue (#441): ISO timestamp of the task's FIRST entry
   * into QUEUED (set once; a re-queue after a lost admission race does
   * not overwrite it). Used for observability — FIFO order itself is
   * keyed on ``created_at``, which never changes.
   */
  readonly queued_at?: string;
  /**
   * Admission queue (#441): number of admission attempts made by the
   * queue pickup Lambda. Incremented on each pickup attempt; used to
   * spot tasks that repeatedly lose the admission race.
   */
  readonly admission_attempts?: number;
  /**
   * Linear parent/sub-issue orchestration (issue #247, Mode A).
   * ``orchestration_id`` PK of the row in ``OrchestrationTable`` whose
   * DAG this task is a child of. Absent on ordinary (non-orchestrated)
   * tasks.
   */
  readonly orchestration_id?: string;
  /**
   * Linear orchestration (#247): the ``task_id`` of the parent task
   * for attribution and rollup, when a parent task exists. Absent on
   * non-orchestrated tasks and on root children whose parent is the
   * Linear issue rather than an ABCA task.
   */
  readonly parent_task_id?: string;
  /**
   * Linear orchestration (#247): sibling ``sub_issue_id``s this child
   * is blocked by — the predecessors that must reach terminal-success
   * (``COMPLETED`` with ``build_passed !== false``) before the
   * reconciler releases this child. Empty/absent for root children.
   * Authoritative gating state lives on the ``OrchestrationTable`` row;
   * this is the denormalized copy threaded onto the task record.
   */
  readonly depends_on?: readonly string[];
  /**
   * The state on GitHub of the pull request this task opened, as the hourly read
   * of pull requests last recorded it. Absent until a read records a state, and on
   * every task whose pull request that read does not follow: one that opened no new
   * pull request, and one that is part of an orchestration. ``merged`` and
   * ``closed`` are final: a pull request recorded as either is not read again.
   * ``not_found`` ends the reading as well, without being a final state: GitHub
   * had no pull request of this task under the recorded number, and nothing else
   * is written with it. Internal, like the three fields below: no API mapper
   * exposes them.
   */
  readonly pr_state?: 'open' | 'merged' | 'closed' | 'not_found';
  /** GitHub's merge time (``merged``) or close time (``closed``), ISO; written with the final state. */
  readonly pr_closed_at?: string;
  /**
   * ISO time of the first review by a person with write access to the repository,
   * other than the pull request's author; written with the final state, and absent
   * when there was none by then.
   */
  readonly pr_first_review_at?: string;
  /** Reviews by such people that requested changes, counted when the final state was recorded. */
  readonly pr_changes_requested?: number;
}

/** Per-channel override for one notification channel. See
 *  ``handlers/fanout-task-events.ts::resolveChannelFilter`` for the
 *  resolution semantics — explicit ``events`` REPLACE the channel
 *  default; a ``"default"`` token inside ``events`` expands to the
 *  default set. */
export interface ChannelConfig {
  /** If false, the channel is opted-out and no events dispatch. */
  readonly enabled?: boolean;
  /** Override the subscribed event types. ``["default"]`` resolves to
   *  the channel default; an explicit list replaces defaults entirely. */
  readonly events?: readonly string[];
}

/** Per-task notification overrides (design §6.5). */
export interface TaskNotificationsConfig {
  readonly slack?: ChannelConfig;
  readonly email?: ChannelConfig;
  readonly github?: ChannelConfig;
  readonly linear?: ChannelConfig;
  readonly jira?: ChannelConfig;
}

/**
 * Task detail for GET /v1/tasks/{task_id} responses.
 * Strips internal fields not exposed in the API.
 */
export interface TaskDetail {
  /** Configured MicroVM approval-wait delay; 0 disables sleep. Absent on legacy records. */
  readonly microvm_sleep_after_s?: number;
  readonly task_id: string;
  readonly status: TaskStatusType;
  /** ``null`` for a repo-less workflow (#248 Phase 3). */
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly issue_title: string | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  /** Registry assets resolved for this task (#246); null when none pinned. */
  readonly resolved_assets: ResolvedAssetTriple[] | null;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly session_id: string | null;
  readonly pr_url: string | null;
  readonly error_message: string | null;
  readonly error_classification: ErrorClassification | null;
  /** Provenance of the task's submission. */
  readonly channel_source: ChannelSource;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  /**
   * ISO timestamp of the agent's last heartbeat, written by the in-guest pipeline
   * every 45 s on the agentcore and lambda-microvm backends (``agent/src/server.py``
   * ``_heartbeat_worker``) and once at start on ecs, which runs the pipeline
   * without that server. ``null`` before the first beat, on tasks that never
   * ran, and on records predating the field.
   */
  readonly agent_heartbeat_at: string | null;
  /** The compute backend the task's session was started on; ``null`` before a
   *  session starts and on records that predate the field. */
  readonly compute_type: ComputeType | null;
  readonly duration_s: number | null;
  readonly cost_usd: number | null;
  readonly build_passed: boolean | null;
  /** Post-run lint gate result (#515); null on tasks that predate the field. */
  readonly lint_passed: boolean | null;
  /** OTEL trace id (32-char hex) for cross-plane correlation (#515); null when
   *  unavailable or on tasks that predate the field. */
  readonly otel_trace_id: string | null;
  readonly max_turns: number | null;
  readonly max_budget_usd: number | null;
  /** The Claude Code CLI's own turn count, kept for debugging.
   *  Not the count `max_turns` limits, and it can exceed the limit on a task
   *  that never reached it: see `TaskResult` in `agent/src/models.py`. */
  readonly turns_attempted: number | null;
  /** Actually-completed turns: the model's answers, which is
   *  what `max_turns` limits (clamped to it). */
  readonly turns_completed: number | null;
  readonly prompt_version: string | null;
  /** True when the task was submitted with ``--trace``. */
  readonly trace: boolean;
  /** S3 URI of the uploaded ``--trace`` trajectory dump, or ``null``
   *  until the agent finishes the terminal upload (or for tasks that
   *  ran without ``--trace``). */
  readonly trace_s3_uri: string | null;
  /** S3 URI of a repo-less delivered artifact (#248 Phase 3); ``null`` for
   *  coding tasks or comment-only delivery. */
  readonly artifact_uri: string | null;
  readonly attachments: AttachmentSummary[] | null;
  /** Cedar HITL: running counter of approval gates fired on this
   *  task (TaskRecord §10.2, §13.6). Null when the task predates
   *  the counter or the agent never wrote one. */
  readonly approval_gate_count: number | null;
  /** Cedar HITL: per-task cap on total approval gates (TaskRecord
   *  §4 step 5, §13.6). Captured at submit time from
   *  ``Blueprint.security.approvalGateCap ?? 50``. Null only on
   *  pre-Chunk-7b records. */
  readonly approval_gate_cap: number | null;
  /** Cedar HITL: when ``status = AWAITING_APPROVAL``, the
   *  ``request_id`` of the pending approval row. Null otherwise. */
  readonly awaiting_approval_request_id: string | null;
  /** Admission queue (#441): ISO timestamp the task first entered
   *  QUEUED; null for tasks that were admitted directly. */
  readonly queued_at: string | null;
  /** Admission queue (#441): 1-based FIFO position among the caller's
   *  QUEUED tasks when ``status = QUEUED``. Computed at read time by
   *  the get-task handler (never persisted — it changes as the queue
   *  drains); null otherwise or when the handler could not compute it. */
  readonly queue_position: number | null;
  /** Admission queue (#441): rough ETA (seconds) until this task is
   *  picked up, derived from queue_position × the recent average task
   *  duration heuristic. Null when queue_position is null. */
  readonly estimated_wait_s: number | null;
}

/**
 * Task summary for GET /v1/tasks list responses (subset of fields).
 */
export interface TaskSummary {
  readonly task_id: string;
  readonly status: TaskStatusType;
  /** ``null`` for a repo-less workflow (#248 Phase 3). */
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly issue_title: string | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  /** Registry assets resolved for this task (#246); null when none pinned. */
  readonly resolved_assets: ResolvedAssetTriple[] | null;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly pr_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /**
   * Last in-guest liveness beat (ISO-8601), or ``null`` when the agent has not
   * beaten yet, on a substrate whose agent never beats, or on records predating
   * the field.
   */
  readonly agent_heartbeat_at: string | null;
  /** The compute backend the task's session was started on; ``null`` before a
   *  session starts and on records that predate the field. */
  readonly compute_type: ComputeType | null;
  /** Estimated spend in USD (null until the agent reports one). */
  readonly cost_usd: number | null;
  /** When the task reached a terminal state (null while it runs). */
  readonly completed_at: string | null;
  /** Where the task was submitted from (console/CLI API, webhook, Slack, Linear, Jira). */
  readonly channel_source: ChannelSource;
}

/** Authenticated caller's personal monthly budget status. */
export interface PersonalBudgetStatus {
  /** UTC calendar month in ``YYYY-MM`` form. */
  readonly period: string;
  /** First instant of the next UTC calendar month. */
  readonly resets_at: string;
  /** Whether an administrator configured a recurring personal limit. */
  readonly configured: boolean;
  /** Estimated terminal-task spend attributed to the caller this month. */
  readonly spend_usd: number;
  /** Configured recurring limit, or null when no personal limit exists. */
  readonly monthly_limit_usd: number | null;
  /** Non-negative estimated amount remaining, or null without a limit. */
  readonly remaining_usd: number | null;
  /** Percentage of the configured limit used, or null without a limit. */
  readonly utilization_percent: number | null;
  /** Whether the administrator enabled admission hard-stop enforcement. */
  readonly hard_stop: boolean;
  /** Whether the configured hard stop is currently blocking new tasks. */
  readonly hard_stop_active: boolean;
}

/** What a finished task counts as on the scoreboard. `failed`, `cancelled` and `timed_out` are the statuses of those names; `verified_pr`, `unverified_pr` and `no_new_pr` split the completed tasks. */
export type TaskOutcome = 'verified_pr' | 'unverified_pr' | 'no_new_pr' | 'failed' | 'cancelled' | 'timed_out';

/** A place the work waited for, or was redirected by, a person. `approve` counts approval requests, whatever the answer. */
export type TouchpointKind = 'approve' | 'clarify' | 'follow_up' | 'cancel';

/** The state on GitHub of a new pull request that ABCA follows, as its reads recorded it. `unread`: no read has recorded one yet, or a read found no pull request of the task under the recorded number and does not ask again. In `pull_requests` it is the state at the period's end: a merge or a close after that end counts as `open`. */
export type PullRequestState = 'merged' | 'closed' | 'open' | 'unread';

/** How far back a scoreboard looks: that many days up to now. */
export type ScoreboardRange = '7d' | '30d';

/** `count` of `total`. A rate is count / total; with a total of 0 there is none. */
export interface Fraction {
  readonly count: number;
  readonly total: number;
}

/** A count, with the ids of up to 10 of the tasks behind it. */
export interface Flagged {
  readonly count: number;
  readonly task_ids: readonly string[];
}

/** The median and the 90th percentile of durations in whole seconds, and how many durations there are. */
export interface DurationSummary {
  readonly p50: number;
  readonly p90: number;
  readonly count: number;
}

/** The scoreboard's numbers over the tasks that finished in one period. */
export interface ScoreboardPeriod {
  /** ISO bounds: tasks that finished at or after `from` and before `to`. The current period has no upper test: a finish time ahead of the clock belongs to it. */
  readonly from: string;
  readonly to: string;
  /** Tasks that reached a terminal state, and their split. */
  readonly finished: number;
  readonly outcomes: Readonly<Record<TaskOutcome, number>>;
  /** Seconds from task creation to a verified pull request; null when there is none. With fewer than 10 values, `p90` is the largest or close to it. */
  readonly time_to_verified_pr_s: DurationSummary | null;
  /** Median seconds from creation to the start of the session, time in the admission queue included, over the verified pull requests above whose start is known; null when there is none. */
  readonly wait_p50_s: number | null;
  /** Tasks that waited in the admission queue, of the tasks that waited or ran. */
  readonly queued: Fraction;
  /** Verified pull requests, of the tasks that asked for a new pull request. */
  readonly verified: Fraction;
  /** New pull requests with no follow-up task before the period's end (a follow-up known to have changed no code is not one), of the new pull requests whose number is known. */
  readonly not_reworked: Fraction;
  /** Verified pull requests whose task never stopped for a person, of the tasks that asked for a new pull request. */
  readonly untouched: Fraction;
  /** Touchpoints on coding tasks. Shown per verified pull request: divide the sum by `outcomes.verified_pr`. */
  readonly touchpoints: Readonly<Record<TouchpointKind, number>>;
  /** Recorded spend of coding tasks, all outcomes, to the micro-dollar. Shown per verified pull request: divide by `outcomes.verified_pr`. */
  readonly spend_usd: number;
  /** Coding tasks that ran and recorded no cost: `spend_usd` under-counts by them. */
  readonly uncosted: number;
  /** Finished tasks of any kind, not only coding tasks, that a guardrail stopped; newest first. Each is also one of `outcomes.failed`. */
  readonly guardrail_stops: Flagged;
  /** Finished tasks of any kind that were submitted with every approval granted in advance; newest first. */
  readonly blanket_approvals: Flagged;
  /** Coding tasks that stopped for at least one approval request, of the coding tasks that ran. */
  readonly gated: Fraction;
  /** The new pull requests of the period that ABCA follows, by their state at the period's end: the four add up to those pull requests. A pull request opened by a task of an orchestration is not followed, and is in none of them. Shown as the merged share: `merged` of `merged` + `closed` + `open`, with `unread` outside it. */
  readonly pull_requests: Readonly<Record<PullRequestState, number>>;
  /** Merged pull requests nobody sent back first (no change request by a reviewer with write access, no reworking follow-up before the merge), of the merged ones. */
  readonly merged_clean: Fraction;
  /** Seconds from task creation to the merge, over the pull requests merged before the period's end; null when none was merged. */
  readonly time_to_merge_s: DurationSummary | null;
  /** Seconds from the end of the task to the first review of its pull request by a person with write access to the repository, other than the pull request's author, over the merged ones that had one; null when none had. A review before that end counts as 0. */
  readonly first_review_s: DurationSummary | null;
}

/** GET /v1/tasks?view=scoreboard: the caller's scoreboard for a range. */
export interface Scoreboard {
  readonly range: ScoreboardRange;
  /** The read hit its cap inside the current period: `current` starts later than the range asked for, and `previous` is null. */
  readonly truncated: boolean;
  readonly current: ScoreboardPeriod;
  /** The period of equal length before `current`; null when the read did not cover it. */
  readonly previous: ScoreboardPeriod | null;
  /**
   * New pull requests that ABCA follows and that were open at its last read more than 7 days
   * after their task finished, oldest first, over the tasks of both periods. Null when the
   * count is not known: the read did not cover the earlier period, so the pull requests of
   * the tasks it left out would be missing; or some pull requests are that old and ABCA has
   * read none of them on GitHub.
   */
  readonly open_over_7d: Flagged | null;
}

/**
 * Task event record as stored in DynamoDB.
 */
export interface EventRecord {
  readonly task_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
  readonly ttl?: number;
  // Correlation envelope (#245): present on events written after task creation;
  // absent on `task_created` and any pre-envelope safety-net writer.
  readonly user_id?: string;
  readonly repo?: string;
  readonly trace_id?: string;
}

/**
 * A single event as embedded in a {@link ReplayBundle} (#515). Normalized to
 * match the ``GET /tasks/{id}/events`` feed exactly — ``task_id``/``ttl`` are
 * stripped and ``metadata`` defaults to ``{}``.
 */
export interface ReplayEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
  readonly user_id?: string;
  readonly repo?: string;
  readonly trace_id?: string;
}

/**
 * Truncation marker embedded in a {@link ReplayBundle} (#523) when the event
 * list was clipped. ``null`` on the bundle means the full list fit; a non-null
 * value names which cap tripped so a consumer never mistakes a clipped replay
 * for a complete one. Use ``GET /tasks/{id}/events`` for the full paginated feed.
 */
export interface ReplayTruncation {
  readonly reason: 'max_events' | 'max_bytes';
  /** Number of events actually embedded in the bundle. */
  readonly returned_events: number;
}

/**
 * Verification verdict embedded in a {@link ReplayBundle} (#515). Reconstructed
 * from the persisted post-run gate booleans. Either field is ``null`` on tasks
 * that predate the verification-persistence change or whose gate did not run
 * (e.g. a repo-less workflow has no build/lint step).
 */
export interface VerificationReport {
  readonly build_passed: boolean | null;
  readonly lint_passed: boolean | null;
}

/**
 * Operator-facing replay bundle returned by ``GET /v1/tasks/{task_id}/replay``
 * (#515).
 *
 * Fields sourced from stores that may not have run for a given task are
 * ``null``/empty rather than omitted, so consumers get a stable schema:
 * ``trace_uri`` is null when the task ran without ``--trace``; ``otel_trace_id``
 * is null on pre-#515 tasks or when tracing was unavailable; ``verification``
 * booleans are null when the gate did not run.
 */
export interface ReplayBundle {
  readonly task_id: string;
  /** Raw caller-supplied workflow selector (audit value); null if unset. */
  readonly workflow_ref: string | null;
  /** Resolved/pinned workflow ``{id, version}`` actually executed; null for
   *  legacy tasks created before workflow resolution. */
  readonly resolved_workflow: ResolvedWorkflow | null;
  readonly prompt_version: string | null;
  /** TaskEvents for this task in chronological order (ULID event_id),
   *  normalized to the same shape as the ``/events`` feed. */
  readonly events: ReplayEvent[];
  /** Non-null when the event list was clipped by a cap (count or bytes); null
   *  when the full list fit. Lets a consumer detect a partial replay. */
  readonly events_truncation: ReplayTruncation | null;
  /** Verification verdict, or null if no gate result was persisted. */
  readonly verification: VerificationReport | null;
  /** S3 URI of the ``--trace`` trajectory dump; null when the task ran without
   *  ``--trace`` or the upload did not complete. */
  readonly trace_uri: string | null;
  /** OTEL trace id (32-char hex) for cross-plane correlation; null when
   *  unavailable. */
  readonly otel_trace_id: string | null;
  /** AgentCore session id — the available correlation id when otel_trace_id is
   *  absent. */
  readonly session_id: string | null;
  readonly cost_usd: number | null;
  /** ISO8601 timestamp the bundle was assembled (server-side). */
  readonly collected_at: string;
}

export interface CreateTaskRequest {
  /** MicroVM approval-wait seconds before sleep (0 = off, omitted = the contract default). Does not extend approval deadlines. */
  readonly microvm_sleep_after_s?: number;
  /** Target repository (``owner/repo``). Optional: a
   *  repo-less workflow (``requires_repo: false``) is submitted without it.
   *  Required-ness is enforced conditionally in ``createTaskCore`` based on
   *  the resolved workflow's ``requiresRepo``. */
  readonly repo?: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  /** Workflow selector ``<id>[@<constraint>]``.
   *  Omitted ⇒ the create-task boundary resolves via the fallback ladder. */
  readonly workflow_ref?: string;
  readonly pr_number?: number;
  readonly attachments?: readonly Attachment[];
  /** Enable 4 KB debug previews (design §10.1, opt-in per task). */
  readonly trace?: boolean;
  /** Cedar HITL: per-task approval timeout (§7.3). Bounded by
   *  ``[APPROVAL_TIMEOUT_S_MIN, APPROVAL_TIMEOUT_S_MAX]``. */
  readonly approval_timeout_s?: number;
  /** Cedar HITL: pre-approved scopes that skip the gate (§7.3 step 4).
   *  Typed as ``ApprovalScope[]`` (the strict union accepted by the
   *  agent's ``parse_approval_scope``); CDK validates the parse result
   *  before forwarding. */
  readonly initial_approvals?: readonly ApprovalScope[];
}

/**
 * Wire format — parsed from untrusted JSON. Validate before use.
 */
export interface Attachment {
  readonly type: AttachmentType;
  readonly content_type?: string;
  readonly data?: string;
  readonly url?: string;
  readonly filename?: string;
  readonly expected_size_bytes?: number;
}

interface BaseValidatedAttachment {
  readonly filename: string;
  readonly content_type: string;
}

/** Inline image/file: data present, validated, decoded, magic-bytes checked. */
export interface InlineAttachment extends BaseValidatedAttachment {
  readonly delivery: 'inline';
  readonly type: 'image' | 'file';
  readonly data: string;
  readonly url?: never;
  readonly decoded_size_bytes: number;
}

/** Presigned upload: metadata only, no data, no url. */
export interface PresignedAttachment extends BaseValidatedAttachment {
  readonly delivery: 'presigned';
  readonly type: 'image' | 'file';
  readonly data?: never;
  readonly url?: never;
  readonly expected_size_bytes: number;
}

/** URL to fetch during hydration. */
export interface UrlAttachment extends BaseValidatedAttachment {
  readonly delivery: 'url_fetch';
  readonly type: 'url';
  readonly url: string;
  readonly data?: never;
}

/** Output of validateAttachments() — illegal combinations are unrepresentable. */
export type ValidatedAttachment = InlineAttachment | PresignedAttachment | UrlAttachment;

/** Screening outcome — discriminated union prevents invalid combinations. */
export type ScreeningResult =
  | { readonly status: 'pending' }
  | { readonly status: 'passed'; readonly screened_at: string }
  | { readonly status: 'blocked'; readonly screened_at: string; readonly categories: [string, ...string[]] };

interface BaseAttachmentRecord {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly content_type: string;
  readonly filename: string;
  readonly source_url?: string;
  readonly token_estimate?: number;
}

export interface PendingAttachmentRecord extends BaseAttachmentRecord {
  readonly screening: { readonly status: 'pending' };
  readonly s3_key?: string;
  readonly s3_version_id?: string;
  readonly size_bytes?: number;
  readonly checksum_sha256?: string;
}

export interface PassedAttachmentRecord extends BaseAttachmentRecord {
  readonly screening: { readonly status: 'passed'; readonly screened_at: string };
  readonly s3_key: string;
  readonly s3_version_id: string;
  readonly size_bytes: number;
  readonly checksum_sha256: string;
}

export interface BlockedAttachmentRecord extends BaseAttachmentRecord {
  readonly screening: { readonly status: 'blocked'; readonly screened_at: string; readonly categories: [string, ...string[]] };
  readonly s3_key?: string;
  readonly s3_version_id?: string;
  readonly size_bytes?: number;
  readonly checksum_sha256?: string;
}

export type AttachmentRecord = PendingAttachmentRecord | PassedAttachmentRecord | BlockedAttachmentRecord;

/** Parameters for creating an AttachmentRecord — accepts the union of all fields. */
export type CreateAttachmentRecordParams = {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly content_type: string;
  readonly filename: string;
  readonly s3_key?: string;
  readonly s3_version_id?: string;
  readonly size_bytes?: number;
  readonly screening: ScreeningResult;
  readonly source_url?: string;
  readonly checksum_sha256?: string;
  readonly token_estimate?: number;
};

/**
 * Factory function enforcing cross-field invariants on AttachmentRecord construction.
 * Returns the appropriate discriminated union variant based on screening status.
 */
export function createAttachmentRecord(params: CreateAttachmentRecordParams): AttachmentRecord {
  if (params.screening.status === 'passed') {
    if (!params.s3_key || !params.s3_version_id || !params.checksum_sha256 || !params.size_bytes) {
      throw new Error('Passed screening requires s3_key, s3_version_id, checksum_sha256, and size_bytes');
    }
    return params as PassedAttachmentRecord;
  }
  if (params.screening.status === 'blocked') {
    return params as BlockedAttachmentRecord;
  }
  return params as PendingAttachmentRecord;
}

export interface AttachmentSummary {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly screening_status: 'passed' | 'blocked' | 'pending';
}

export interface AttachmentUploadInstruction {
  readonly attachment_id: string;
  readonly filename: string;
  readonly upload_url: string;
  readonly upload_fields: Record<string, string>;
  readonly upload_expires_at: string;
}

/** Response from POST /v1/tasks when presigned uploads are required. */
export interface CreateTaskResponse extends TaskDetail {
  readonly upload_instructions?: readonly AttachmentUploadInstruction[];
  readonly task_expires_at?: string;
}

/** Attachment descriptor sent to the agent runtime. */
export interface AgentAttachmentPayload {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly content_type: string;
  readonly filename: string;
  readonly s3_uri: string;
  readonly s3_version_id: string;
  readonly size_bytes: number;
  readonly source_url?: string;
  readonly token_estimate?: number;
  readonly checksum_sha256: string;
}

/**
 * Map a DynamoDB task record to the API detail response shape. The numeric
 * fields that may be stored as strings are routed through
 * ``coerceNumericOrNull``.
 *
 * @param queueInfo - read-time queue position/ETA for QUEUED tasks (#441).
 *   Computed by the caller (get-task) and never persisted; omitted everywhere
 *   else.
 */
export function toTaskDetail(
  record: TaskRecord,
  queueInfo?: { readonly queue_position: number; readonly estimated_wait_s: number | null },
): TaskDetail {
  const ctx = { task_id: record.task_id };
  return {
    ...(typeof record.microvm_sleep_after_s === 'number' && Number.isInteger(record.microvm_sleep_after_s)
      && record.microvm_sleep_after_s >= MICROVM_SLEEP_AFTER_S_MIN && record.microvm_sleep_after_s <= MICROVM_SLEEP_AFTER_S_MAX
      && { microvm_sleep_after_s: record.microvm_sleep_after_s }),
    task_id: record.task_id,
    status: record.status,
    repo: record.repo ?? null,
    issue_number: record.issue_number ?? null,
    issue_title: record.issue_title ?? null,
    resolved_workflow: record.resolved_workflow ?? null,
    resolved_assets: record.resolved_assets ?? null,
    pr_number: record.pr_number ?? null,
    task_description: record.task_description ?? null,
    branch_name: record.branch_name,
    session_id: record.session_id ?? null,
    pr_url: record.pr_url ?? null,
    error_message: record.error_message ?? null,
    error_classification: classifyError(record.error_message),
    channel_source: record.channel_source,
    created_at: record.created_at,
    updated_at: record.updated_at,
    started_at: record.started_at ?? null,
    completed_at: record.completed_at ?? null,
    agent_heartbeat_at: record.agent_heartbeat_at ?? null,
    compute_type: record.compute_type ?? null,
    duration_s: coerceNumericOrNull(record.duration_s, { ...ctx, field: 'duration_s' }, logger),
    cost_usd: coerceNumericOrNull(record.cost_usd, { ...ctx, field: 'cost_usd' }, logger),
    build_passed: record.build_passed ?? null,
    lint_passed: record.lint_passed ?? null,
    otel_trace_id: record.otel_trace_id ?? null,
    max_turns: coerceNumericOrNull(record.max_turns, { ...ctx, field: 'max_turns' }, logger),
    max_budget_usd: coerceNumericOrNull(record.max_budget_usd, { ...ctx, field: 'max_budget_usd' }, logger),
    turns_attempted: coerceNumericOrNull(record.turns_attempted, { ...ctx, field: 'turns_attempted' }, logger),
    turns_completed: coerceNumericOrNull(record.turns_completed, { ...ctx, field: 'turns_completed' }, logger),
    prompt_version: record.prompt_version ?? null,
    trace: record.trace === true,
    trace_s3_uri: record.trace_s3_uri ?? null,
    artifact_uri: record.artifact_uri ?? null,
    attachments: record.attachments
      ? record.attachments.map(a => ({
        attachment_id: a.attachment_id,
        type: a.type,
        filename: a.filename,
        content_type: a.content_type,
        size_bytes: a.size_bytes ?? 0,
        screening_status: a.screening.status,
      }))
      : null,
    approval_gate_count: coerceNumericOrNull(
      record.approval_gate_count,
      { ...ctx, field: 'approval_gate_count' },
      logger,
    ),
    approval_gate_cap: coerceNumericOrNull(
      record.approval_gate_cap,
      { ...ctx, field: 'approval_gate_cap' },
      logger,
    ),
    awaiting_approval_request_id: record.awaiting_approval_request_id ?? null,
    queued_at: record.queued_at ?? null,
    queue_position: queueInfo?.queue_position ?? null,
    estimated_wait_s: queueInfo?.estimated_wait_s ?? null,
  };
}

/**
 * Maximum length (in characters, after trim) of a nudge ``message``.
 */
export const NUDGE_MAX_MESSAGE_LENGTH = 2000;

/**
 * Nudge request body for POST /v1/tasks/{task_id}/nudge (Phase 2).
 *
 * A nudge is a short, between-turns steering message from the user to a
 * running agent. It is written to `TaskNudgesTable` after guardrail
 * screening + rate limiting, then picked up by the agent's nudge_reader
 * at the next between-turns seam and injected as an authoritative
 * `<user_nudge>` XML block.
 */
export interface NudgeRequest {
  /** Free-text steering message. Max 2000 chars after trim; guardrail-screened. */
  readonly message: string;
}

/**
 * Nudge response body. Returned with HTTP 202 Accepted — the nudge has
 * been persisted but has not yet reached the agent; it will be injected
 * at the next between-turns seam. Callers wanting confirmation that the
 * agent saw the nudge should watch task events for `nudge_consumed`.
 */
export interface NudgeResponse {
  readonly task_id: string;
  readonly nudge_id: string;
  readonly submitted_at: string;
}

/**
 * Full nudge record as stored in `TaskNudgesTable`.
 *
 * - PK = `task_id` (groups all nudges for a task together)
 * - SK = `nudge_id` (ULID — lexicographic sort == chronological sort)
 */
export interface NudgeRecord {
  readonly task_id: string;
  readonly nudge_id: string;
  readonly user_id: string;
  readonly message: string;
  readonly created_at: string;
  readonly consumed: boolean;
  readonly consumed_at?: string;
  readonly ttl?: number;
}

/**
 * Full webhook record as stored in DynamoDB.
 */
export interface WebhookRecord {
  readonly webhook_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly revoked_at?: string;
  readonly ttl?: number;
}

export interface WebhookDetail {
  readonly webhook_id: string;
  readonly name: string;
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly revoked_at: string | null;
}

export interface CreateWebhookRequest {
  readonly name: string;
}

/**
 * Create webhook response — includes the secret (shown only once).
 */
export interface CreateWebhookResponse {
  readonly webhook_id: string;
  readonly name: string;
  readonly secret: string;
  /**
   * URL that external systems post tasks to (`POST /webhooks/tasks`). It belongs to the
   * API deployment, not to the webhook: every webhook of a deployment gets the same URL.
   */
  readonly webhook_url: string;
  readonly created_at: string;
}

export function toWebhookDetail(record: WebhookRecord): WebhookDetail {
  return {
    webhook_id: record.webhook_id,
    name: record.name,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    revoked_at: record.revoked_at ?? null,
  };
}

/**
 * Scopes a platform API key may hold.
 */
export type ApiKeyScope = 'webhooks:manage' | 'webhooks:invoke' | 'tasks:read' | 'tasks:cancel';

/** Scopes recognized by the platform. Order is not significant. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  'webhooks:manage',
  'webhooks:invoke',
  'tasks:read',
  'tasks:cancel',
];

/**
 * Full platform API key record as stored in DynamoDB.
 *
 * `key_hash` is the SHA-256 hex digest of the secret portion of the presented
 * key. The raw secret is never stored — it is returned once at creation.
 */
export interface ApiKeyRecord {
  readonly key_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly key_hash: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at?: string;
  readonly revoked_at?: string;
  readonly ttl?: number;
}

/**
 * Platform API key detail for API responses. Excludes `key_hash` and `user_id`.
 */
export interface ApiKeyDetail {
  readonly key_id: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

export interface CreateApiKeyRequest {
  readonly name: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly expires_at?: string;
}

/**
 * Create API key response — includes the full key material (shown only once).
 * The `key` is the value the caller sends in the `X-API-Key` header.
 */
export interface CreateApiKeyResponse {
  readonly key_id: string;
  readonly name: string;
  readonly key: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly expires_at: string | null;
  readonly created_at: string;
}

/**
 * Map a DynamoDB API key record to the API detail response shape.
 * @returns the API-facing API key detail (never includes the hash or owner).
 */
export function toApiKeyDetail(record: ApiKeyRecord): ApiKeyDetail {
  return {
    key_id: record.key_id,
    name: record.name,
    scopes: record.scopes,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    expires_at: record.expires_at ?? null,
    revoked_at: record.revoked_at ?? null,
  };
}

export function toTaskSummary(record: TaskRecord): TaskSummary {
  return {
    task_id: record.task_id,
    status: record.status,
    repo: record.repo ?? null,
    issue_number: record.issue_number ?? null,
    issue_title: record.issue_title ?? null,
    resolved_workflow: record.resolved_workflow ?? null,
    resolved_assets: record.resolved_assets ?? null,
    pr_number: record.pr_number ?? null,
    task_description: record.task_description ?? null,
    branch_name: record.branch_name,
    pr_url: record.pr_url ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    agent_heartbeat_at: record.agent_heartbeat_at ?? null,
    compute_type: record.compute_type ?? null,
    cost_usd: coerceNumericOrNull(record.cost_usd, { task_id: record.task_id, field: 'cost_usd' }, logger),
    completed_at: record.completed_at ?? null,
    channel_source: record.channel_source,
  };
}

/**
 * Scope of an approval grant.
 *
 * - `this_call`          — one-shot. Does NOT grow the allowlist.
 * - `tool_type_session`  — allow any further invocation of the same tool name
 *                          for the rest of the session.
 * - `tool_group_session` — allow any tool in the matching tool group
 *                          (currently `file_write` → Write/Edit).
 * - `bash_pattern:...`   — allow Bash commands matching the pattern (fnmatch).
 * - `write_path:...`     — allow Write/Edit against paths matching the pattern.
 * - `rule:<rule_id>`     — allow soft-deny hits whose rule_id matches.
 * - `all_session`        — allow anything for the rest of the session. Gated
 *                          by blueprint `maxPreApprovalScope` (§7.5).
 */
export type ApprovalScope =
  | 'this_call'
  | 'tool_type_session'
  | 'tool_group_session'
  | 'all_session'
  | `tool_type:${string}`
  | `tool_group:${string}`
  | `bash_pattern:${string}`
  | `write_path:${string}`
  | `rule:${string}`;

/**
 * Approval row status values. PENDING is the only non-terminal state —
 * every other transition is final, which matches the
 * `ConditionExpression: status = :pending` guard on every mutator.
 */
export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DENIED'
  | 'TIMED_OUT'
  | 'STRANDED';

/**
 * Cedar HITL severity, surfaced in the CLI approval prompt and used
 * for severity-gated channel routing (§11.2: high-severity rules
 * skip Slack-button auto-approval).
 */
export type Severity = 'low' | 'medium' | 'high';

/**
 * Pending approval summary returned by `GET /v1/pending` (§7.7).
 * Derived from the GSI projection attributes only.
 */
export interface PendingApprovalSummary {
  readonly task_id: string;
  readonly request_id: string;
  readonly tool_name: string;
  readonly tool_input_preview: string;
  readonly severity: Severity;
  readonly reason: string;
  readonly created_at: string;
  readonly timeout_s: number;
  /** Derived: `created_at + timeout_s` in ISO 8601 UTC. */
  readonly expires_at: string;
  /** Cedar rule ids that matched this request (design §10.1). Empty array
   *  on pre-Cedar-HITL rows. */
  readonly matching_rule_ids: readonly string[];
}

/**
 * `POST /v1/tasks/{task_id}/approve` request body (§7.1).
 *
 * `scope` is optional — defaults to `this_call` when omitted.
 */
export interface ApprovalRequest {
  readonly request_id: string;
  readonly decision: 'approve';
  readonly scope?: ApprovalScope;
}

/**
 * `POST /v1/tasks/{task_id}/approve` response body.
 */
export interface ApprovalResponse {
  readonly task_id: string;
  readonly request_id: string;
  readonly status: 'APPROVED';
  readonly scope: ApprovalScope;
  readonly decided_at: string;
}

/**
 * `POST /v1/tasks/{task_id}/deny` request body (§7.2).
 *
 * `reason` is passed through `output_scanner.scanDenyReason` before
 * persistence — user-facing secrets (AWS keys, GitHub PATs, API tokens)
 * are redacted with `[REDACTED-...]` markers. Truncated to
 * `DENY_REASON_MAX_LENGTH` chars AFTER scanning.
 */
export interface DenyRequest {
  readonly request_id: string;
  readonly decision: 'deny';
  readonly reason?: string;
}

/**
 * `POST /v1/tasks/{task_id}/deny` response body.
 */
export interface DenyResponse {
  readonly task_id: string;
  readonly request_id: string;
  readonly status: 'DENIED';
  readonly decided_at: string;
}

/**
 * Maximum length of a sanitized deny reason after `output_scanner`
 * redaction (§7.2 step 3).
 */
export const DENY_REASON_MAX_LENGTH = 2000;

/**
 * Rule metadata returned by `GET /v1/repos/{repo}/policies` (§7.6).
 * `approval_timeout_s` and `severity` are absent for hard-deny rules.
 */
export interface PolicyRuleSummary {
  readonly rule_id: string;
  readonly category?: string;
  readonly severity?: Severity;
  readonly approval_timeout_s?: number;
  readonly summary: string;
}

/** One open issue in GET /v1/repos/{repo_id}/issues. Titles and metadata only, no body. */
export interface RepoIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly updated_at: string;
  readonly labels: readonly string[];
}

/** GET /v1/repos/{repo_id}/issues response (console issue picker). */
export interface ListRepoIssuesResponse {
  readonly repo: string;
  readonly issues: readonly RepoIssueSummary[];
}

/** `GET /v1/repos/{repo_id}/policies` response body. */
export interface GetPoliciesResponse {
  readonly repo_id: string;
  readonly policies: {
    readonly hard: readonly PolicyRuleSummary[];
    readonly soft: readonly PolicyRuleSummary[];
  };
}

/**
 * `GET /v1/pending` response body (§7.7).
 */
export interface GetPendingResponse {
  readonly pending: readonly PendingApprovalSummary[];
}

/**
 * Lambda-written audit event type for an approve/deny decision
 * (IMPL-6). Emitted to TaskEventsTable.
 */
export interface ApprovalDecisionRecordedEvent {
  readonly request_id: string;
  readonly status: 'APPROVED' | 'DENIED';
  readonly scope?: ApprovalScope;
  readonly reason?: string;
  readonly decided_at: string;
  readonly caller_user_id: string;
}

/** Maximum `initial_approvals` entries per §7.3. */
export const INITIAL_APPROVALS_MAX_ENTRIES = 20;

/** Maximum per-entry length for an `initial_approvals` scope string. */
export const INITIAL_APPROVALS_MAX_ENTRY_LENGTH = 128;

/** Floor for `approval_timeout_s` (§6 decision #6). */
export const APPROVAL_TIMEOUT_S_MIN = sharedConstants.approval_timeout_s.min;

/** Absolute ceiling for `approval_timeout_s` before the
 *  `maxLifetime - 300` clip is applied (§7.3). */
export const APPROVAL_TIMEOUT_S_MAX = sharedConstants.approval_timeout_s.max;

/** Per-task MicroVM sleep delay bounds; zero disables automatic sleep. */
export const MICROVM_SLEEP_AFTER_S_MIN = sharedConstants.microvm_sleep_after_s.min;
export const MICROVM_SLEEP_AFTER_S_MAX = sharedConstants.microvm_sleep_after_s.max;
export const MICROVM_SLEEP_AFTER_S_DEFAULT = sharedConstants.microvm_sleep_after_s.default;

/**
 * Cedar HITL: bounds + platform default for the per-task approval-gate cap
 * (design decision #13, §4 step 5). Blueprints may override via
 * ``security.approvalGateCap``; the submit path bounds-checks the
 * resolved value against these constants.
 */
export const APPROVAL_GATE_CAP_MIN = sharedConstants.approval_gate_cap.min;
export const APPROVAL_GATE_CAP_MAX = sharedConstants.approval_gate_cap.max;
export const APPROVAL_GATE_CAP_DEFAULT = sharedConstants.approval_gate_cap.default;

/** Minimum allowed `max_budget_usd` (1 cent). */
export const MAX_BUDGET_USD_MIN = sharedConstants.max_budget_usd.min;

/** Maximum allowed `max_budget_usd` ($100). */
export const MAX_BUDGET_USD_MAX = sharedConstants.max_budget_usd.max;
