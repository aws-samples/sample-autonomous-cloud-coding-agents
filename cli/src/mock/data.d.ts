/**
 * Mock data for the TUI prototype.
 * Simulates the DynamoDB data shapes from TaskTable, TaskEventsTable,
 * and TaskApprovalsTable without any real API calls.
 */
export interface RegisteredRepo {
    repo: string;
    status: 'active' | 'removed';
    default_branch: string;
}
export declare const MOCK_REPOS: RegisteredRepo[];
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
export declare const MOCK_TASKS: TaskSummary[];
export declare const MOCK_EVENTS: TaskEvent[];
export declare const MOCK_PENDING_APPROVALS: PendingApproval[];
/**
 * Returns events one at a time to simulate a live watch stream.
 * Each call returns the next event or null if exhausted.
 */
export declare class MockEventStream {
    private queue;
    private index;
    constructor(taskId: string);
    /** Get next batch of events (simulates polling) */
    poll(afterIndex: number): TaskEvent[];
    get totalEvents(): number;
}
export declare function fetchTasks(): Promise<TaskSummary[]>;
export declare function fetchTask(taskId: string): Promise<TaskSummary | undefined>;
export declare function fetchPendingApprovals(): Promise<PendingApproval[]>;
export declare function approveRequest(taskId: string, requestId: string, scope?: string): Promise<{
    success: boolean;
    message: string;
}>;
export declare function denyRequest(taskId: string, requestId: string, reason: string): Promise<{
    success: boolean;
    message: string;
}>;
export declare const MOCK_POLICIES: CedarPolicy[];
export declare function submitTask(repo: string, description: string): TaskSummary;
