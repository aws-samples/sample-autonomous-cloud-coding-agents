"use strict";
/**
 * Mock data for the TUI prototype.
 * Simulates the DynamoDB data shapes from TaskTable, TaskEventsTable,
 * and TaskApprovalsTable without any real API calls.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOCK_POLICIES = exports.MockEventStream = exports.MOCK_PENDING_APPROVALS = exports.MOCK_EVENTS = exports.MOCK_TASKS = exports.MOCK_REPOS = void 0;
exports.fetchTasks = fetchTasks;
exports.fetchTask = fetchTask;
exports.fetchPendingApprovals = fetchPendingApprovals;
exports.approveRequest = approveRequest;
exports.denyRequest = denyRequest;
exports.submitTask = submitTask;
exports.MOCK_REPOS = [
    { repo: 'aws-samples/my-project', status: 'active', default_branch: 'main' },
    { repo: 'aws-samples/billing-service', status: 'active', default_branch: 'main' },
    { repo: 'aws-samples/auth-lib', status: 'active', default_branch: 'develop' },
];
// ─── Mock Tasks ─────────────────────────────────────────────────────
const NOW = new Date();
function minutesAgo(m) {
    return new Date(NOW.getTime() - m * 60_000).toISOString();
}
exports.MOCK_TASKS = [
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
function eid() {
    return `01JBX7EVT${String(++eventCounter).padStart(6, '0')}`;
}
exports.MOCK_EVENTS = [
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'task_started', timestamp: minutesAgo(3),
        metadata: {},
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'turn_start', timestamp: minutesAgo(2.9),
        metadata: { turn: 1 },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_call', timestamp: minutesAgo(2.8),
        metadata: { tool_name: 'ReadFile', args_preview: 'src/api/users.ts' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_result', timestamp: minutesAgo(2.7),
        metadata: { tool_name: 'ReadFile', status: 'success', preview: '1.2KB read' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_call', timestamp: minutesAgo(2.5),
        metadata: { tool_name: 'ReadFile', args_preview: 'package.json' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_result', timestamp: minutesAgo(2.4),
        metadata: { tool_name: 'ReadFile', status: 'success', preview: '0.8KB read' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'milestone', timestamp: minutesAgo(2.3),
        metadata: { message: 'Analyzed codebase structure. Found Express + TypeScript stack.' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'turn_start', timestamp: minutesAgo(2.2),
        metadata: { turn: 2 },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_call', timestamp: minutesAgo(2.1),
        metadata: { tool_name: 'Bash', args_preview: 'npm install zod' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
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
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'approval_granted', timestamp: minutesAgo(1.8),
        metadata: { request_id: '01JBX7RRPK3QW9FM2JD6NX8B1T', scope: 'this_call' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_result', timestamp: minutesAgo(1.6),
        metadata: { tool_name: 'Bash', status: 'success', preview: 'added 1 package' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_call', timestamp: minutesAgo(1.5),
        metadata: { tool_name: 'EditFile', args_preview: 'src/api/users.ts' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
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
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'cost_update', timestamp: minutesAgo(1.4),
        metadata: { total_usd: 0.1847, input_tokens: 12400, output_tokens: 3200 },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'turn_start', timestamp: minutesAgo(1.0),
        metadata: { turn: 3 },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_call', timestamp: minutesAgo(0.8),
        metadata: { tool_name: 'ReadFile', args_preview: 'src/api/middleware/validate.ts' },
    },
    {
        event_id: eid(), task_id: exports.MOCK_TASKS[0].task_id,
        event_type: 'tool_result', timestamp: minutesAgo(0.7),
        metadata: { tool_name: 'ReadFile', status: 'success', preview: '0.4KB read' },
    },
];
// ─── Mock Pending Approvals ─────────────────────────────────────────
exports.MOCK_PENDING_APPROVALS = [
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
class MockEventStream {
    queue;
    index = 0;
    constructor(taskId) {
        this.queue = exports.MOCK_EVENTS.filter(e => e.task_id === taskId);
    }
    /** Get next batch of events (simulates polling) */
    poll(afterIndex) {
        // Return 1-3 events at a time to simulate realistic polling
        const batch = this.queue.slice(afterIndex, afterIndex + Math.ceil(Math.random() * 3));
        return batch;
    }
    get totalEvents() {
        return this.queue.length;
    }
}
exports.MockEventStream = MockEventStream;
// ─── Mock API Functions ─────────────────────────────────────────────
async function fetchTasks() {
    // Simulate API latency
    await new Promise(r => setTimeout(r, 200));
    return exports.MOCK_TASKS;
}
async function fetchTask(taskId) {
    await new Promise(r => setTimeout(r, 150));
    return exports.MOCK_TASKS.find(t => t.task_id === taskId);
}
async function fetchPendingApprovals() {
    await new Promise(r => setTimeout(r, 200));
    return exports.MOCK_PENDING_APPROVALS;
}
async function approveRequest(taskId, requestId, scope) {
    await new Promise(r => setTimeout(r, 300));
    return {
        success: true,
        message: `Approved ${requestId.slice(-6)} for task ${taskId.slice(-4)}` +
            (scope ? ` (scope: ${scope})` : ''),
    };
}
async function denyRequest(taskId, requestId, reason) {
    await new Promise(r => setTimeout(r, 300));
    return {
        success: true,
        message: `Denied ${requestId.slice(-6)} for task ${taskId.slice(-4)}: ${reason}`,
    };
}
// ─── Mock Cedar Policies ────────────────────────────────────────────
exports.MOCK_POLICIES = [
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
function submitTask(repo, description) {
    const id = '01JBX9' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const task = {
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
    exports.MOCK_TASKS.push(task);
    return task;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGF0YS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImRhdGEudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7OztBQTBUSCxnQ0FJQztBQUVELDhCQUdDO0FBRUQsc0RBR0M7QUFFRCx3Q0FTQztBQUVELGtDQVFDO0FBaUVELGdDQW1CQztBQXZhWSxRQUFBLFVBQVUsR0FBcUI7SUFDMUMsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFO0lBQzVFLEVBQUUsSUFBSSxFQUFFLDZCQUE2QixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRTtJQUNqRixFQUFFLElBQUksRUFBRSxzQkFBc0IsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLGNBQWMsRUFBRSxTQUFTLEVBQUU7Q0FDOUUsQ0FBQztBQXFERix1RUFBdUU7QUFFdkUsTUFBTSxHQUFHLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztBQUN2QixTQUFTLFVBQVUsQ0FBQyxDQUFTO0lBQzNCLE9BQU8sSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztBQUM1RCxDQUFDO0FBRVksUUFBQSxVQUFVLEdBQWtCO0lBQ3ZDO1FBQ0UsT0FBTyxFQUFFLDJCQUEyQjtRQUNwQyxNQUFNLEVBQUUsU0FBUztRQUNqQixJQUFJLEVBQUUsd0JBQXdCO1FBQzlCLFVBQVUsRUFBRSxVQUFVLENBQUMsQ0FBQyxDQUFDO1FBQ3pCLGdCQUFnQixFQUFFLG1FQUFtRTtRQUNyRixTQUFTLEVBQUUsVUFBVTtRQUNyQixTQUFTLEVBQUUsSUFBSTtRQUNmLFlBQVksRUFBRSxFQUFFO1FBQ2hCLFdBQVcsRUFBRSwyQkFBMkI7UUFDeEMsUUFBUSxFQUFFLE1BQU07UUFDaEIsVUFBVSxFQUFFLElBQUk7UUFDaEIsSUFB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