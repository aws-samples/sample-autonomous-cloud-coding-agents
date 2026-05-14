/**
 * Mock fixture source for the TUI.
 *
 * Wire shapes here mirror the real API contract in `cli/src/types.ts`
 * (TaskDetail, PendingApprovalSummary, PolicyRuleSummary). The TUI
 * data-layer (`tui/data.ts`) adapts either these mocks or live API
 * responses into view-models the panels bind to, so the panels never
 * need to know which source they came from.
 *
 * The exception is `CedarPolicyFixture.cedar_source`: the real
 * `PolicyRuleSummary` intentionally does NOT expose raw Cedar source.
 * We keep it on the fixture so the existing "view source" demo still
 * works in mock mode; in real mode the Policies panel hides that pane.
 */

import type {
  ApprovalScope,
  PendingApprovalSummary,
  PolicyRuleSummary,
  TaskDetail,
  TaskEvent,
  TaskType,
} from '../../types.js';

// ─── Fixture-only extensions ─────────────────────────────────────────
//
// These widen the wire shapes with mock-only attributes (Cedar source,
// registered repos). Panels MUST NOT read these directly — they get
// normalized-or-hidden at the data-layer boundary.

export interface RegisteredRepoFixture {
  readonly repo: string;
  readonly status: 'active' | 'removed';
  readonly default_branch: string;
}

/** Mock-only: raw Cedar source for the Policies panel's "view source"
 *  detail pane. Not on `PolicyRuleSummary` — the live API omits raw
 *  source from its response (see design §8.1). */
export interface CedarPolicyFixture extends PolicyRuleSummary {
  readonly tier: 'hard' | 'soft';
  readonly action: string;
  readonly condition_summary: string;
  readonly cedar_source: string;
}

/** Mock-only: the pending-approval fixture carries `repo` +
 *  `task_description` so the Approvals list can show them without an
 *  extra join. In real mode the data-layer hydrates those fields by
 *  GET-ing the corresponding TaskDetail. */
export interface PendingApprovalFixture extends PendingApprovalSummary {
  readonly repo: string;
  readonly task_description: string;
  readonly status: 'PENDING';
}

/** Mock-only: the task fixture carries enough of TaskDetail for the
 *  watch/list panels (turns, budget, approval-gate counters). Real
 *  mode reads the full TaskDetail directly. */
export type TaskFixture = Pick<
  TaskDetail,
  | 'task_id'
  | 'status'
  | 'repo'
  | 'issue_number'
  | 'task_type'
  | 'pr_number'
  | 'task_description'
  | 'branch_name'
  | 'pr_url'
  | 'created_at'
  | 'updated_at'
  | 'cost_usd'
  | 'duration_s'
  | 'max_turns'
  | 'turns_attempted'
  | 'turns_completed'
  | 'approval_gate_count'
  | 'approval_gate_cap'
  | 'awaiting_approval_request_id'
>;

// ─── Fixture data ────────────────────────────────────────────────────

export const MOCK_REPOS: readonly RegisteredRepoFixture[] = [
  { repo: 'aws-samples/my-project', status: 'active', default_branch: 'main' },
  { repo: 'aws-samples/billing-service', status: 'active', default_branch: 'main' },
  { repo: 'aws-samples/auth-lib', status: 'active', default_branch: 'develop' },
];

const NOW = new Date();
function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

export const MOCK_TASKS: readonly TaskFixture[] = [
  {
    task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
    status: 'RUNNING',
    repo: 'aws-samples/my-project',
    issue_number: 42,
    task_type: 'new_task' as TaskType,
    pr_number: null,
    task_description: 'Add input validation to the /api/users endpoint using zod schemas',
    branch_name: 'agent/input-validation-42',
    pr_url: null,
    created_at: minutesAgo(3),
    updated_at: minutesAgo(0.1),
    cost_usd: 0.1847,
    duration_s: null,
    max_turns: 8,
    turns_attempted: 3,
    turns_completed: 3,
    approval_gate_count: 1,
    approval_gate_cap: 50,
    awaiting_approval_request_id: null,
  },
  {
    task_id: '01JBX5QPKR2MN8HW1FS6AY4M2',
    status: 'AWAITING_APPROVAL',
    repo: 'aws-samples/my-project',
    issue_number: 38,
    task_type: 'new_task' as TaskType,
    pr_number: null,
    task_description: 'Fix the failing unit tests in the auth module and update snapshots',
    branch_name: 'agent/fix-auth-tests-38',
    pr_url: null,
    created_at: minutesAgo(15),
    updated_at: minutesAgo(0.5),
    cost_usd: 0.3412,
    duration_s: null,
    max_turns: 10,
    turns_attempted: 5,
    turns_completed: 5,
    approval_gate_count: 2,
    approval_gate_cap: 50,
    awaiting_approval_request_id: '01JBX5TTPK5SW1HN4LF8PZ0D3V',
  },
  {
    task_id: '01JBX3RTMK7QN2HW9FS4AY8P8',
    status: 'COMPLETED',
    repo: 'acme-corp/backend-api',
    issue_number: 29,
    task_type: 'new_task' as TaskType,
    pr_number: 156,
    task_description: 'Refactor database connection pooling to use pgbouncer',
    branch_name: 'agent/refactor-db-pool-29',
    pr_url: 'https://github.com/acme-corp/backend-api/pull/156',
    created_at: minutesAgo(62),
    updated_at: minutesAgo(15),
    cost_usd: 0.8923,
    duration_s: 2847,
    max_turns: 15,
    turns_attempted: 12,
    turns_completed: 12,
    approval_gate_count: 4,
    approval_gate_cap: 50,
    awaiting_approval_request_id: null,
  },
  {
    task_id: '01JBX1WQNR3PG7HW5FS2AY6L4',
    status: 'FAILED',
    repo: 'acme-corp/frontend',
    issue_number: 55,
    task_type: 'new_task' as TaskType,
    pr_number: null,
    task_description: 'Migrate the dashboard from Class components to React hooks',
    branch_name: 'agent/migrate-hooks-55',
    pr_url: null,
    created_at: minutesAgo(120),
    updated_at: minutesAgo(30),
    cost_usd: 1.2345,
    duration_s: 5400,
    max_turns: 15,
    turns_attempted: 15,
    turns_completed: 15,
    approval_gate_count: 3,
    approval_gate_cap: 50,
    awaiting_approval_request_id: null,
  },
];

// ─── Mock Events (for watch stream) ──────────────────────────────────

let eventCounter = 0;
function eid(): string {
  return `01JBX7EVT${String(++eventCounter).padStart(6, '0')}`;
}

export const MOCK_EVENTS: readonly TaskEvent[] = [
  { event_id: eid(), event_type: 'task_started', timestamp: minutesAgo(3),
    metadata: { task_id: MOCK_TASKS[0].task_id } },
  { event_id: eid(), event_type: 'turn_start', timestamp: minutesAgo(2.9),
    metadata: { task_id: MOCK_TASKS[0].task_id, turn: 1 } },
  { event_id: eid(), event_type: 'tool_call', timestamp: minutesAgo(2.8),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'ReadFile', args_preview: 'src/api/users.ts' } },
  { event_id: eid(), event_type: 'tool_result', timestamp: minutesAgo(2.7),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'ReadFile', status: 'success', preview: '1.2KB read' } },
  { event_id: eid(), event_type: 'tool_call', timestamp: minutesAgo(2.5),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'ReadFile', args_preview: 'package.json' } },
  { event_id: eid(), event_type: 'tool_result', timestamp: minutesAgo(2.4),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'ReadFile', status: 'success', preview: '0.8KB read' } },
  { event_id: eid(), event_type: 'milestone', timestamp: minutesAgo(2.3),
    metadata: { task_id: MOCK_TASKS[0].task_id, message: 'Analyzed codebase structure. Found Express + TypeScript stack.' } },
  { event_id: eid(), event_type: 'turn_start', timestamp: minutesAgo(2.2),
    metadata: { task_id: MOCK_TASKS[0].task_id, turn: 2 } },
  { event_id: eid(), event_type: 'tool_call', timestamp: minutesAgo(2.1),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'Bash', args_preview: 'npm install zod' } },
  { event_id: eid(), event_type: 'approval_requested', timestamp: minutesAgo(2.1),
    metadata: {
      task_id: MOCK_TASKS[0].task_id,
      request_id: '01JBX7RRPK3QW9FM2JD6NX8B1T',
      tool_name: 'Bash',
      input_preview: 'npm install zod',
      reason: 'Shell command execution requires approval',
      severity: 'high',
      matching_rule_ids: ['bash_exec_gate'],
      timeout_s: 600,
    } },
  { event_id: eid(), event_type: 'approval_granted', timestamp: minutesAgo(1.8),
    metadata: { task_id: MOCK_TASKS[0].task_id, request_id: '01JBX7RRPK3QW9FM2JD6NX8B1T', scope: 'this_call' } },
  { event_id: eid(), event_type: 'tool_result', timestamp: minutesAgo(1.6),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'Bash', status: 'success', preview: 'added 1 package' } },
  { event_id: eid(), event_type: 'tool_call', timestamp: minutesAgo(1.5),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'EditFile', args_preview: 'src/api/users.ts' } },
  { event_id: eid(), event_type: 'approval_requested', timestamp: minutesAgo(1.5),
    metadata: {
      task_id: MOCK_TASKS[0].task_id,
      request_id: '01JBX7SSPK4RW0GM3KE7OY9C2U',
      tool_name: 'EditFile',
      input_preview: 'src/api/users.ts — Replace validation with zod schema',
      reason: 'File modification requires approval (hard-gate: file_edit_gate)',
      severity: 'medium',
      matching_rule_ids: ['file_edit_gate'],
      timeout_s: 600,
    } },
  { event_id: eid(), event_type: 'cost_update', timestamp: minutesAgo(1.4),
    metadata: { task_id: MOCK_TASKS[0].task_id, total_usd: 0.1847, input_tokens: 12400, output_tokens: 3200 } },
  { event_id: eid(), event_type: 'turn_start', timestamp: minutesAgo(1.0),
    metadata: { task_id: MOCK_TASKS[0].task_id, turn: 3 } },
  { event_id: eid(), event_type: 'tool_call', timestamp: minutesAgo(0.8),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'ReadFile', args_preview: 'src/api/middleware/validate.ts' } },
  { event_id: eid(), event_type: 'tool_result', timestamp: minutesAgo(0.7),
    metadata: { task_id: MOCK_TASKS[0].task_id, tool_name: 'ReadFile', status: 'success', preview: '0.4KB read' } },
];

// ─── Mock Pending Approvals ──────────────────────────────────────────

export const MOCK_PENDING_APPROVALS: readonly PendingApprovalFixture[] = [
  {
    task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
    request_id: '01JBX7SSPK4RW0GM3KE7OY9C2U',
    tool_name: 'EditFile',
    tool_input_preview: 'src/api/users.ts — Replace existing validation (lines 42-58) with zod schema: const userSchema = z.object({ name: z.string().min(1).max(100), email: z.string().email() })',
    reason: 'File modification requires approval (hard-gate: file_edit_gate)',
    severity: 'medium',
    matching_rule_ids: ['file_edit_gate'],
    created_at: minutesAgo(1.5),
    timeout_s: 600,
    expires_at: new Date(NOW.getTime() + (600 - 90) * 1000).toISOString(),
    status: 'PENDING',
    repo: 'aws-samples/my-project',
    task_description: 'Add input validation to the /api/users endpoint using zod schemas',
  },
  {
    task_id: '01JBX5QPKR2MN8HW1FS6AY4M2',
    request_id: '01JBX5TTPK5SW1HN4LF8PZ0D3V',
    tool_name: 'Bash',
    tool_input_preview: 'npm test -- --updateSnapshot',
    reason: 'Shell command execution requires approval (hard-gate: bash_exec_gate)',
    severity: 'high',
    matching_rule_ids: ['bash_exec_gate'],
    created_at: minutesAgo(0.5),
    timeout_s: 600,
    expires_at: new Date(NOW.getTime() + (600 - 30) * 1000).toISOString(),
    status: 'PENDING',
    repo: 'aws-samples/my-project',
    task_description: 'Fix the failing unit tests in the auth module and update snapshots',
  },
];

// ─── Mock Cedar Policies ─────────────────────────────────────────────
// Grouped by the API's `hard`/`soft` buckets. Mock-only fields:
// `action`, `condition_summary`, `cedar_source` — these are not on
// `PolicyRuleSummary` and are hidden in real mode.

export const MOCK_POLICIES_HARD: readonly CedarPolicyFixture[] = [
  {
    rule_id: 'rm_slash', tier: 'hard',
    summary: 'Block rm -rf / and variants',
    category: 'destructive',
    action: 'execute_bash', condition_summary: 'command matches *rm -rf /*',
    cedar_source: '@tier("hard-deny")\n@rule_id("rm_slash")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*rm -rf /*" };',
  },
  {
    rule_id: 'write_git_internals', tier: 'hard',
    summary: 'Block writes to .git/ directory',
    category: 'filesystem',
    action: 'write_file', condition_summary: 'file_path matches .git/*',
    cedar_source: '@tier("hard-deny")\n@rule_id("write_git_internals")\nforbid (principal, action == Agent::Action::"write_file", resource)\n  when { context.file_path like ".git/*" };',
  },
  {
    rule_id: 'drop_table', tier: 'hard',
    summary: 'Block DROP TABLE commands',
    category: 'destructive',
    action: 'execute_bash', condition_summary: 'command matches *DROP TABLE*',
    cedar_source: '@tier("hard-deny")\n@rule_id("drop_table")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*DROP TABLE*" };',
  },
  {
    rule_id: 'force_push_main', tier: 'hard',
    summary: 'Block force-push to main/prod branches',
    severity: 'high', category: 'destructive',
    action: 'execute_bash', condition_summary: 'command matches *git push --force origin main*',
    cedar_source: '@tier("hard-deny")\n@rule_id("force_push_main")\n@severity("high")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*git push --force origin main*" };',
  },
];

export const MOCK_POLICIES_SOFT: readonly CedarPolicyFixture[] = [
  {
    rule_id: 'bash_exec_gate', tier: 'soft',
    summary: 'Shell command execution requires approval',
    severity: 'high', category: 'auth', approval_timeout_s: 600,
    action: 'execute_bash', condition_summary: 'all bash commands (catch-all)',
    cedar_source: '@tier("hard-gate")\n@rule_id("bash_exec_gate")\n@severity("high")\n@approval_timeout_s("600")\nforbid (principal, action == Agent::Action::"execute_bash", resource);',
  },
  {
    rule_id: 'file_edit_gate', tier: 'soft',
    summary: 'File modifications require approval',
    severity: 'medium', category: 'filesystem', approval_timeout_s: 600,
    action: 'write_file', condition_summary: 'all file writes and edits',
    cedar_source: '@tier("hard-gate")\n@rule_id("file_edit_gate")\n@severity("medium")\n@approval_timeout_s("600")\nforbid (principal, action == Agent::Action::"write_file", resource);',
  },
  {
    rule_id: 'deploy_staging', tier: 'soft',
    summary: 'Terraform/CDK deploy requires approval',
    severity: 'high', category: 'destructive', approval_timeout_s: 900,
    action: 'execute_bash', condition_summary: 'command matches *terraform apply* or *cdk deploy*',
    cedar_source: '@tier("hard-gate")\n@rule_id("deploy_staging")\n@severity("high")\n@approval_timeout_s("900")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*terraform apply*" };',
  },
  {
    rule_id: 'npm_install_gate', tier: 'soft',
    summary: 'Package installation requires approval',
    severity: 'medium', category: 'auth', approval_timeout_s: 300,
    action: 'execute_bash', condition_summary: 'command matches *npm install* or *yarn add*',
    cedar_source: '@tier("hard-gate")\n@rule_id("npm_install_gate")\n@severity("medium")\n@approval_timeout_s("300")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*npm install*" };',
  },
];

export const MOCK_POLICIES: readonly CedarPolicyFixture[] = [
  ...MOCK_POLICIES_HARD,
  ...MOCK_POLICIES_SOFT,
];

// ─── Mutations (mock-only; no-op on real backend) ────────────────────

/** Mock: seed a new task and return its fixture. Real mode calls
 *  `ApiClient.createTask` directly; the Submit panel does not import
 *  this. */
export function submitMockTask(
  repo: string,
  description: string,
  extras?: {
    approval_timeout_s?: number;
    initial_approvals?: readonly ApprovalScope[];
  },
): TaskFixture {
  void extras; // recorded only for parity — mock doesn't persist it.
  const id = '01JBX9' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const t: TaskFixture = {
    task_id: id,
    status: 'SUBMITTED',
    repo,
    issue_number: null,
    task_type: 'new_task',
    pr_number: null,
    task_description: description,
    branch_name: `agent/${id.slice(-6).toLowerCase()}`,
    pr_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cost_usd: null,
    duration_s: null,
    max_turns: 8,
    turns_attempted: 0,
    turns_completed: 0,
    approval_gate_count: 0,
    approval_gate_cap: 50,
    awaiting_approval_request_id: null,
  };
  (MOCK_TASKS as TaskFixture[]).push(t);
  return t;
}
