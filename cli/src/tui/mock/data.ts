/**
 * Mock data for the TUI prototype.
 * Simulates the DynamoDB data shapes from TaskTable, TaskEventsTable,
 * and TaskApprovalsTable without any real API calls.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface RegisteredRepo {
  repo: string;           // "owner/repo" format
  status: 'active' | 'removed';
  default_branch: string;
}

export const MOCK_REPOS: RegisteredRepo[] = [
  { repo: 'aws-samples/my-project', status: 'active', default_branch: 'main' },
  { repo: 'aws-samples/billing-service', status: 'active', default_branch: 'main' },
  { repo: 'aws-samples/auth-lib', status: 'active', default_branch: 'develop' },
];

export interface TaskSummary {
  task_id: string;
  status: string;
  repo: string;
  created_at: string;
  task_description: string;
  task_type: string;
  pr_number: number | null;
  issue_number: number | null;
  branch_name: string;
  cost_usd: number | null;
  duration_s: number | null;
  turn: number;
  max_turns: number | null;
}

export interface TaskEvent {
  event_id: string;
  task_id: string;
  event_type: string;
  timestamp: string;
  metadata: Record<string, any>;
}

export interface PendingApproval {
  task_id: string;
  request_id: string;
  tool_name: string;
  tool_input_preview: string;
  reason: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  matching_rule_ids: string[];
  status: 'PENDING';
  created_at: string;
  timeout_s: number;
  repo: string;
  task_description: string;
}

export interface CedarPolicy {
  rule_id: string;
  tier: 'hard-deny' | 'hard-gate';
  description: string;
  action: string;
  condition_summary: string;
  severity?: string;
  category?: string;
  approval_timeout_s?: number;
  cedar_source: string;
}

// ─── Mock Tasks ─────────────────────────────────────────────────────

const NOW = new Date();
function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

export const MOCK_TASKS: TaskSummary[] = [
  {
    task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
    status: 'RUNNING',
    repo: 'aws-samples/my-project',
    created_at: minutesAgo(3),
    task_description: 'Add input validation to the /api/users endpoint using zod schemas',
    task_type: 'new_task',
    pr_number: null,
    issue_number: 42,
    branch_name: 'agent/input-validation-42',
    cost_usd: 0.1847,
    duration_s: null,
    turn: 3,
    max_turns: 8,
  },
  {
    task_id: '01JBX5QPKR2MN8HW1FS6AY4M2',
    status: 'AWAITING_APPROVAL',
    repo: 'aws-samples/my-project',
    created_at: minutesAgo(15),
    task_description: 'Fix the failing unit tests in the auth module and update snapshots',
    task_type: 'new_task',
    pr_number: null,
    issue_number: 38,
    branch_name: 'agent/fix-auth-tests-38',
    cost_usd: 0.3412,
    duration_s: null,
    turn: 5,
    max_turns: 10,
  },
  {
    task_id: '01JBX3RTMK7QN2HW9FS4AY8P8',
    status: 'COMPLETED',
    repo: 'acme-corp/backend-api',
    created_at: minutesAgo(62),
    task_description: 'Refactor database connection pooling to use pgbouncer',
    task_type: 'new_task',
    pr_number: 156,
    issue_number: 29,
    branch_name: 'agent/refactor-db-pool-29',
    cost_usd: 0.8923,
    duration_s: 2847,
    turn: 12,
    max_turns: 15,
  },
  {
    task_id: '01JBX1WQNR3PG7HW5FS2AY6L4',
    status: 'FAILED',
    repo: 'acme-corp/frontend',
    created_at: minutesAgo(120),
    task_description: 'Migrate the dashboard from Class components to React hooks',
    task_type: 'new_task',
    pr_number: null,
    issue_number: 55,
    branch_name: 'agent/migrate-hooks-55',
    cost_usd: 1.2345,
    duration_s: 5400,
    turn: 15,
    max_turns: 15,
  },
];

// ─── Mock Events (for watch stream) ────────────────────────────────

let eventCounter = 0;
function eid(): string {
  return `01JBX7EVT${String(++eventCounter).padStart(6, '0')}`;
}

export const MOCK_EVENTS: TaskEvent[] = [
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'task_started', timestamp: minutesAgo(3),
    metadata: {},
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'turn_start', timestamp: minutesAgo(2.9),
    metadata: { turn: 1 },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_call', timestamp: minutesAgo(2.8),
    metadata: { tool_name: 'ReadFile', args_preview: 'src/api/users.ts' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_result', timestamp: minutesAgo(2.7),
    metadata: { tool_name: 'ReadFile', status: 'success', preview: '1.2KB read' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_call', timestamp: minutesAgo(2.5),
    metadata: { tool_name: 'ReadFile', args_preview: 'package.json' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_result', timestamp: minutesAgo(2.4),
    metadata: { tool_name: 'ReadFile', status: 'success', preview: '0.8KB read' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'milestone', timestamp: minutesAgo(2.3),
    metadata: { message: 'Analyzed codebase structure. Found Express + TypeScript stack.' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'turn_start', timestamp: minutesAgo(2.2),
    metadata: { turn: 2 },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_call', timestamp: minutesAgo(2.1),
    metadata: { tool_name: 'Bash', args_preview: 'npm install zod' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'approval_requested', timestamp: minutesAgo(2.1),
    metadata: {
      request_id: '01JBX7RRPK3QW9FM2JD6NX8B1T',
      tool_name: 'Bash',
      input_preview: 'npm install zod',
      reason: 'Shell command execution requires approval',
      severity: 'HIGH',
      matching_rule_ids: ['bash_exec_gate'],
      timeout_s: 600,
    },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'approval_granted', timestamp: minutesAgo(1.8),
    metadata: { request_id: '01JBX7RRPK3QW9FM2JD6NX8B1T', scope: 'this_call' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_result', timestamp: minutesAgo(1.6),
    metadata: { tool_name: 'Bash', status: 'success', preview: 'added 1 package' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_call', timestamp: minutesAgo(1.5),
    metadata: { tool_name: 'EditFile', args_preview: 'src/api/users.ts' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'approval_requested', timestamp: minutesAgo(1.5),
    metadata: {
      request_id: '01JBX7SSPK4RW0GM3KE7OY9C2U',
      tool_name: 'EditFile',
      input_preview: 'src/api/users.ts — Replace validation with zod schema',
      reason: 'File modification requires approval (hard-gate: file_edit_gate)',
      severity: 'MEDIUM',
      matching_rule_ids: ['file_edit_gate'],
      timeout_s: 600,
    },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'cost_update', timestamp: minutesAgo(1.4),
    metadata: { total_usd: 0.1847, input_tokens: 12400, output_tokens: 3200 },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'turn_start', timestamp: minutesAgo(1.0),
    metadata: { turn: 3 },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_call', timestamp: minutesAgo(0.8),
    metadata: { tool_name: 'ReadFile', args_preview: 'src/api/middleware/validate.ts' },
  },
  {
    event_id: eid(), task_id: MOCK_TASKS[0].task_id,
    event_type: 'tool_result', timestamp: minutesAgo(0.7),
    metadata: { tool_name: 'ReadFile', status: 'success', preview: '0.4KB read' },
  },
];

// ─── Mock Pending Approvals ─────────────────────────────────────────

export const MOCK_PENDING_APPROVALS: PendingApproval[] = [
  {
    task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
    request_id: '01JBX7SSPK4RW0GM3KE7OY9C2U',
    tool_name: 'EditFile',
    tool_input_preview: 'src/api/users.ts — Replace existing validation (lines 42-58) with zod schema: const userSchema = z.object({ name: z.string().min(1).max(100), email: z.string().email() })',
    reason: 'File modification requires approval (hard-gate: file_edit_gate)',
    severity: 'MEDIUM',
    matching_rule_ids: ['file_edit_gate'],
    status: 'PENDING',
    created_at: minutesAgo(1.5),
    timeout_s: 600,
    repo: 'aws-samples/my-project',
    task_description: 'Add input validation to the /api/users endpoint using zod schemas',
  },
  {
    task_id: '01JBX5QPKR2MN8HW1FS6AY4M2',
    request_id: '01JBX5TTPK5SW1HN4LF8PZ0D3V',
    tool_name: 'Bash',
    tool_input_preview: 'npm test -- --updateSnapshot',
    reason: 'Shell command execution requires approval (hard-gate: bash_exec_gate)',
    severity: 'HIGH',
    matching_rule_ids: ['bash_exec_gate'],
    status: 'PENDING',
    created_at: minutesAgo(0.5),
    timeout_s: 600,
    repo: 'aws-samples/my-project',
    task_description: 'Fix the failing unit tests in the auth module and update snapshots',
  },
];

// ─── Mock Upcoming Events (for watch simulation) ────────────────────

/**
 * Returns events one at a time to simulate a live watch stream.
 * Each call returns the next event or null if exhausted.
 */
export class MockEventStream {
  private queue: TaskEvent[];
  private index = 0;

  constructor(taskId: string) {
    this.queue = MOCK_EVENTS.filter(e => e.task_id === taskId);
  }

  /** Get next batch of events (simulates polling) */
  poll(afterIndex: number): TaskEvent[] {
    // Return 1-3 events at a time to simulate realistic polling
    const batch = this.queue.slice(afterIndex, afterIndex + Math.ceil(Math.random() * 3));
    return batch;
  }

  get totalEvents(): number {
    return this.queue.length;
  }
}

// ─── Mock API Functions ─────────────────────────────────────────────

export async function fetchTasks(): Promise<TaskSummary[]> {
  // Simulate API latency
  await new Promise(r => setTimeout(r, 200));
  return MOCK_TASKS;
}

export async function fetchTask(taskId: string): Promise<TaskSummary | undefined> {
  await new Promise(r => setTimeout(r, 150));
  return MOCK_TASKS.find(t => t.task_id === taskId);
}

export async function fetchPendingApprovals(): Promise<PendingApproval[]> {
  await new Promise(r => setTimeout(r, 200));
  return MOCK_PENDING_APPROVALS;
}

export async function approveRequest(
  taskId: string, requestId: string, scope?: string
): Promise<{ success: boolean; message: string }> {
  await new Promise(r => setTimeout(r, 300));
  return {
    success: true,
    message: `Approved ${requestId.slice(-6)} for task ${taskId.slice(-4)}` +
             (scope ? ` (scope: ${scope})` : ''),
  };
}

export async function denyRequest(
  taskId: string, requestId: string, reason: string
): Promise<{ success: boolean; message: string }> {
  await new Promise(r => setTimeout(r, 300));
  return {
    success: true,
    message: `Denied ${requestId.slice(-6)} for task ${taskId.slice(-4)}: ${reason}`,
  };
}

// ─── Mock Cedar Policies ────────────────────────────────────────────

export const MOCK_POLICIES: CedarPolicy[] = [
  {
    rule_id: 'rm_slash', tier: 'hard-deny',
    description: 'Block rm -rf / and variants',
    action: 'execute_bash', condition_summary: 'command matches *rm -rf /*',
    category: 'destructive',
    cedar_source: '@tier("hard-deny")\n@rule_id("rm_slash")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*rm -rf /*" };',
  },
  {
    rule_id: 'write_git_internals', tier: 'hard-deny',
    description: 'Block writes to .git/ directory',
    action: 'write_file', condition_summary: 'file_path matches .git/*',
    category: 'filesystem',
    cedar_source: '@tier("hard-deny")\n@rule_id("write_git_internals")\nforbid (principal, action == Agent::Action::"write_file", resource)\n  when { context.file_path like ".git/*" };',
  },
  {
    rule_id: 'drop_table', tier: 'hard-deny',
    description: 'Block DROP TABLE commands',
    action: 'execute_bash', condition_summary: 'command matches *DROP TABLE*',
    category: 'destructive',
    cedar_source: '@tier("hard-deny")\n@rule_id("drop_table")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*DROP TABLE*" };',
  },
  {
    rule_id: 'force_push_main', tier: 'hard-deny',
    description: 'Block force-push to main/prod branches',
    action: 'execute_bash', condition_summary: 'command matches *git push --force origin main*',
    severity: 'high', category: 'destructive',
    cedar_source: '@tier("hard-deny")\n@rule_id("force_push_main")\n@severity("high")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*git push --force origin main*" };',
  },
  {
    rule_id: 'bash_exec_gate', tier: 'hard-gate',
    description: 'Shell command execution requires approval',
    action: 'execute_bash', condition_summary: 'all bash commands (catch-all)',
    severity: 'high', category: 'auth', approval_timeout_s: 600,
    cedar_source: '@tier("hard-gate")\n@rule_id("bash_exec_gate")\n@severity("high")\n@approval_timeout_s("600")\nforbid (principal, action == Agent::Action::"execute_bash", resource);',
  },
  {
    rule_id: 'file_edit_gate', tier: 'hard-gate',
    description: 'File modifications require approval',
    action: 'write_file', condition_summary: 'all file writes and edits',
    severity: 'medium', category: 'filesystem', approval_timeout_s: 600,
    cedar_source: '@tier("hard-gate")\n@rule_id("file_edit_gate")\n@severity("medium")\n@approval_timeout_s("600")\nforbid (principal, action == Agent::Action::"write_file", resource);',
  },
  {
    rule_id: 'deploy_staging', tier: 'hard-gate',
    description: 'Terraform/CDK deploy requires approval',
    action: 'execute_bash', condition_summary: 'command matches *terraform apply* or *cdk deploy*',
    severity: 'high', category: 'destructive', approval_timeout_s: 900,
    cedar_source: '@tier("hard-gate")\n@rule_id("deploy_staging")\n@severity("high")\n@approval_timeout_s("900")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*terraform apply*" };',
  },
  {
    rule_id: 'npm_install_gate', tier: 'hard-gate',
    description: 'Package installation requires approval',
    action: 'execute_bash', condition_summary: 'command matches *npm install* or *yarn add*',
    severity: 'medium', category: 'auth', approval_timeout_s: 300,
    cedar_source: '@tier("hard-gate")\n@rule_id("npm_install_gate")\n@severity("medium")\n@approval_timeout_s("300")\nforbid (principal, action == Agent::Action::"execute_bash", resource)\n  when { context.command like "*npm install*" };',
  },
];

// ─── Submit Task Mock ───────────────────────────────────────────────

export function submitTask(repo: string, description: string): TaskSummary {
  const id = '01JBX9' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const task: TaskSummary = {
    task_id: id,
    status: 'SUBMITTED',
    repo,
    created_at: new Date().toISOString(),
    task_description: description,
    task_type: 'new_task',
    pr_number: null,
    issue_number: null,
    branch_name: `agent/${id.slice(-6).toLowerCase()}`,
    cost_usd: null,
    duration_s: null,
    turn: 0,
    max_turns: 8,
  };
  MOCK_TASKS.push(task);
  return task;
}
