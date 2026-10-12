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
 * Linear workspace binding, end to end.
 *
 * A delivery runs through the REAL receiver, the receiver's processor invoke is
 * handed to the REAL processor, and the processor runs the REAL token resolver,
 * user lookup, orchestration store and `createTaskCore`. Every table and secret is
 * one stateful fake shared by both handlers, so the receiver's workspace count and
 * the processor's binding read the same registry — which is what the per-handler
 * unit tests cannot show.
 *
 * Each case asserts the outcome that matters: whether a task record was persisted,
 * and for which repository, platform user and workspace. Only the modules that call
 * Linear's API are mocked; network access is otherwise refused.
 *
 * Tenants:
 *   A — owns its signing secret (recorded).
 *   B — owns its signing secret (recorded).
 *   C — onboarded before per-workspace secrets: verifies via the stack-wide secret.
 *   D — holds a copy of A's secret, ownership not recorded.
 */

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ── Stateful fakes ──────────────────────────────────────────────────────
type Item = Record<string, unknown>;

const TABLE = {
  registry: 'LinearWorkspaceRegistry',
  projects: 'LinearProjects',
  users: 'LinearUsers',
  dedup: 'LinearDedup',
  tasks: 'TaskTable',
  events: 'TaskEventsTable',
  orch: 'OrchestrationTable',
} as const;

const KEY_SCHEMA: Record<string, readonly string[]> = {
  [TABLE.registry]: ['linear_workspace_id'],
  [TABLE.projects]: ['linear_project_id'],
  [TABLE.users]: ['linear_identity'],
  [TABLE.dedup]: ['dedup_key'],
  [TABLE.tasks]: ['task_id'],
  [TABLE.events]: ['task_id', 'event_id'],
  [TABLE.orch]: ['orchestration_id', 'sub_issue_id'],
};

const mockTables = new Map<string, Map<string, Item>>();
const mockSecrets = new Map<string, string>();
const mockInvokes: Array<{ FunctionName: string; payload: Record<string, unknown> }> = [];
const mockLogs: Array<{ level: string; message: string; ctx?: Record<string, unknown> }> = [];

function table(name: string): Map<string, Item> {
  if (!mockTables.has(name)) mockTables.set(name, new Map());
  return mockTables.get(name)!;
}
function keyFor(tableName: string, item: Item): string {
  const schema = KEY_SCHEMA[tableName];
  if (!schema) throw new Error(`fake DDB: no key schema for table ${tableName}`);
  return schema.map((k) => String(item[k])).join('\u0000');
}
function conditionalFail(): never {
  const e = new Error('The conditional request failed');
  e.name = 'ConditionalCheckFailedException';
  throw e;
}
function resolveName(token: string, names?: Record<string, string>): string {
  return token.startsWith('#') ? (names?.[token] ?? token) : token;
}
/** `attribute_not_exists(x)` / `attribute_exists(x)` — the only conditions these paths rely on. */
function checkCondition(expr: string | undefined, existing: Item | undefined, names?: Record<string, string>): void {
  if (!expr) return;
  const notExists = /attribute_not_exists\(([#\w]+)\)/.exec(expr);
  if (notExists && existing && existing[resolveName(notExists[1], names)] !== undefined) conditionalFail();
  const exists = /(?<!not_)attribute_exists\(([#\w]+)\)/.exec(expr);
  if (exists && (!existing || existing[resolveName(exists[1], names)] === undefined)) conditionalFail();
}
/** Equality filter from a KeyConditionExpression like `a = :x AND b = :y`. */
function keyMatcher(expr: string, values: Item, names?: Record<string, string>): (i: Item) => boolean {
  const clauses = expr.split(/\s+AND\s+/i).map((c) => /([#\w]+)\s*=\s*(:\w+)/.exec(c)).filter(Boolean) as RegExpExecArray[];
  return (i) => clauses.every((m) => i[resolveName(m[1], names)] === values[m[2]]);
}

const mockDdbSend = jest.fn(async (cmd: { _type: string; input: Item }) => {
  const input = cmd.input;
  const tn = input.TableName as string;
  const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
  const values = (input.ExpressionAttributeValues ?? {}) as Item;
  const t = table(tn);
  switch (cmd._type) {
    case 'Get':
      return { Item: t.get(keyFor(tn, input.Key as Item)) };
    case 'Put': {
      const item = input.Item as Item;
      checkCondition(input.ConditionExpression as string | undefined, t.get(keyFor(tn, item)), names);
      t.set(keyFor(tn, item), { ...item });
      return {};
    }
    case 'Delete':
      t.delete(keyFor(tn, input.Key as Item));
      return {};
    case 'Scan':
      return { Items: [...t.values()].map((i) => ({ ...i })) };
    case 'Query': {
      let items = [...t.values()].filter(keyMatcher(input.KeyConditionExpression as string, values, names));
      if (input.IndexName === 'LinearIssueIndex' || input.ScanIndexForward === false) {
        items = items.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      }
      if (typeof input.Limit === 'number') items = items.slice(0, input.Limit);
      return { Items: items.map((i) => ({ ...i })) };
    }
    case 'Update': {
      const k = keyFor(tn, input.Key as Item);
      const existing = t.get(k);
      checkCondition(input.ConditionExpression as string | undefined, existing, names);
      const next: Item = { ...(existing ?? (input.Key as Item)) };
      const set = /SET\s+(.+?)(?:\s+(?:REMOVE|ADD|DELETE)\s|$)/i.exec(String(input.UpdateExpression ?? ''));
      for (const part of set ? set[1].split(',') : []) {
        const m = /^\s*([#\w.]+)\s*=\s*(:\w+)\s*$/.exec(part);
        if (m) next[resolveName(m[1], names)] = values[m[2]];
      }
      t.set(k, next);
      return {};
    }
    case 'BatchWrite':
      for (const [tbl, reqs] of Object.entries(input.RequestItems as Record<string, Array<{ PutRequest?: { Item: Item } }>>)) {
        for (const r of reqs) if (r.PutRequest) table(tbl).set(keyFor(tbl, r.PutRequest.Item), r.PutRequest.Item);
      }
      return {};
    default:
      throw new Error(`fake DDB: unhandled ${cmd._type}`);
  }
});

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ _type: t, input }));
  return {
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: (c: never) => mockDdbSend(c) })) },
    GetCommand: cmd('Get'),
    PutCommand: cmd('Put'),
    DeleteCommand: cmd('Delete'),
    ScanCommand: cmd('Scan'),
    QueryCommand: cmd('Query'),
    UpdateCommand: cmd('Update'),
    BatchWriteCommand: cmd('BatchWrite'),
  };
});

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: async (c: { _type: string; input: { SecretId: string; SecretString?: string } }) => {
      if (c._type === 'Put') {
        mockSecrets.set(c.input.SecretId, c.input.SecretString!);
        return {};
      }
      const v = mockSecrets.get(c.input.SecretId);
      if (v === undefined) {
        const e = new Error('Secrets Manager can\'t find the specified secret.');
        e.name = 'ResourceNotFoundException';
        throw e;
      }
      return { SecretString: v };
    },
  })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({
    send: async (c: { input: { FunctionName: string; Payload: Uint8Array } }) => {
      mockInvokes.push({
        FunctionName: c.input.FunctionName,
        payload: JSON.parse(new TextDecoder().decode(c.input.Payload)) as Record<string, unknown>,
      });
      return { StatusCode: 202 };
    },
  })),
  InvokeCommand: jest.fn((input: unknown) => ({ input })),
}));

jest.mock('./../../src/handlers/shared/logger', () => {
  const rec = (level: string) => (message: string, ctx?: Record<string, unknown>) => {
    mockLogs.push({ level, message, ctx });
  };
  return { logger: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
});

// ── Linear API boundary ────────────────────────────────────────────────
const mockFeedback = {
  reportIssueFailure: jest.fn(async () => true),
  swapIssueReaction: jest.fn(async () => true),
  swapCommentReaction: jest.fn(async () => true),
  transitionIssueState: jest.fn(async () => true),
  upsertStatusComment: jest.fn(async () => 'status-comment-1'),
  reactToComment: jest.fn(async () => true),
  replyToComment: jest.fn(async () => true),
  upsertThreadedReply: jest.fn(async () => 'reply-1'),
  fetchRecentComments: jest.fn(async () => []),
  postIssueComment: jest.fn(async () => true),
};
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  ...mockFeedback,
  EMOJI_STARTED: 'eyes',
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
}));

const mockParentOf = new Map<string, string>();
jest.mock('../../src/handlers/shared/linear-subissue-fetch', () => {
  const lookup = jest.requireActual('../../src/handlers/shared/lookup-result');
  return {
    fetchSubIssueGraph: jest.fn(async () => ({ kind: 'no_children' })),
    fetchIssueParentId: jest.fn(async (_token: string, issueId: string) => {
      const parent = mockParentOf.get(issueId);
      return parent ? lookup.lookupFound(parent) : lookup.LOOKUP_ABSENT;
    }),
  };
});

jest.mock('../../src/handlers/shared/linear-issue-context-probe', () => ({
  probeLinearIssueContext: jest.fn(async () => ({
    attachmentTitles: [],
    attachments: [],
    projectName: null,
    projectHasDocuments: false,
    projectDocuments: [],
    ok: true,
    projectDocumentCount: 0,
  })),
  renderIssueContextHint: jest.fn(() => ''),
}));

// ── Environment (read at module load) ───────────────────────────────────
const STACK_WIDE_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:bgagent/linear/webhook-TEST';
process.env.LINEAR_WEBHOOK_SECRET_ARN = STACK_WIDE_ARN;
process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME = TABLE.dedup;
process.env.LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'linear-processor';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = TABLE.registry;
process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = TABLE.projects;
process.env.LINEAR_USER_MAPPING_TABLE_NAME = TABLE.users;
process.env.TASK_TABLE_NAME = TABLE.tasks;
process.env.TASK_EVENTS_TABLE_NAME = TABLE.events;
process.env.ORCHESTRATION_TABLE_NAME = TABLE.orch;

import { handler as receiver } from '../../src/handlers/linear-webhook';
import { handler as processor } from '../../src/handlers/linear-webhook-processor';
import { _resetCachesForTesting } from '../../src/handlers/shared/linear-oauth-resolver';
import * as linearVerify from '../../src/handlers/shared/linear-verify';
import { deriveOrchestrationId } from '../../src/handlers/shared/orchestration-store';

// Optional so this file also runs against code that predates the count cache, which
// is how it was checked to fail on the unfixed handlers.
const _resetActiveWorkspaceCountCache = (): void => {
  (linearVerify as { _resetActiveWorkspaceCountCache?: () => void })._resetActiveWorkspaceCountCache?.();
};
const invalidateLinearSecretCache = linearVerify.invalidateLinearSecretCache;

// ── Tenants ─────────────────────────────────────────────────────────────
// UUID-shaped ids whose last group is not twelve digits, so nothing here reads as
// an account number to the repo's scanners.
const STACK_WIDE_SECRET = 'lin_wh_stackwide_0000000000000000';
interface Tenant { id: string; slug: string; secret?: string; owned: boolean; repo: string; project: string; actor: string; platformUser: string }
const T: Record<'A' | 'B' | 'C' | 'D', Tenant> = {
  A: { id: 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', slug: 'ws-a', secret: 'lin_wh_a_aaaaaaaaaaaaaaaaaaaaaaaa', owned: true, repo: 'org-a/repo-a', project: 'proj-a', actor: 'user-a', platformUser: 'platform-a' },
  B: { id: 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', slug: 'ws-b', secret: 'lin_wh_b_bbbbbbbbbbbbbbbbbbbbbbbb', owned: true, repo: 'org-b/repo-b', project: 'proj-b', actor: 'user-b', platformUser: 'platform-b' },
  C: { id: 'cccccccc-0000-4000-8000-cccccccccccc', slug: 'ws-c', owned: false, repo: 'org-c/repo-c', project: 'proj-c', actor: 'user-c', platformUser: 'platform-c' },
  D: { id: 'dddddddd-0000-4000-8000-dddddddddddd', slug: 'ws-d', secret: 'lin_wh_a_aaaaaaaaaaaaaaaaaaaaaaaa', owned: false, repo: 'org-d/repo-d', project: 'proj-d', actor: 'user-d', platformUser: 'platform-d' },
};
const UNREGISTERED = 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee';

function oauthArn(t: Tenant): string {
  return `arn:aws:secretsmanager:us-east-1:000000000000:secret:bgagent-linear-oauth-${t.slug}`;
}

function onboard(t: Tenant, opts: { status?: string; withProject?: boolean; projectOwner?: string | null } = {}): void {
  const now = new Date().toISOString();
  mockSecrets.set(oauthArn(t), JSON.stringify({
    access_token: `lin_oauth_${t.slug}`,
    refresh_token: `lin_refresh_${t.slug}`,
    expires_at: '2099-01-01T00:00:00.000Z',
    scope: 'read write',
    client_id: 'cid',
    client_secret: 'csec',
    workspace_id: t.id,
    workspace_slug: t.slug,
    installed_at: now,
    updated_at: now,
    installed_by_platform_user_id: t.platformUser,
    ...(t.secret && { webhook_signing_secret: t.secret }),
  }));
  table(TABLE.registry).set(t.id, {
    linear_workspace_id: t.id,
    workspace_slug: t.slug,
    oauth_secret_arn: oauthArn(t),
    status: opts.status ?? 'active',
    installed_at: now,
    ...(t.owned && { webhook_secret_owned: true }),
  });
  table(TABLE.users).set(`${t.id}#${t.actor}`, {
    linear_identity: `${t.id}#${t.actor}`, platform_user_id: t.platformUser, status: 'active',
  });
  if (opts.withProject !== false) mapProject(t.project, t.repo, opts.projectOwner === undefined ? t.id : opts.projectOwner);
}

function mapProject(projectId: string, repo: string, ownerWorkspaceId: string | null): void {
  table(TABLE.projects).set(projectId, {
    linear_project_id: projectId,
    repo,
    status: 'active',
    label_filter: 'bgagent',
    ...(ownerWorkspaceId && { linear_workspace_id: ownerWorkspaceId }),
  });
}

/** An orchestration owned by `owner`: an epic with one started child that has a PR. */
function seedEpic(owner: Tenant, epicId: string, childId: string, childIdentifier: string): void {
  const orchestrationId = deriveOrchestrationId(epicId);
  const base = {
    orchestration_id: orchestrationId,
    parent_issue_ref: epicId,
    credentials_ref: owner.id,
    repo: owner.repo,
  };
  const t = table(TABLE.orch);
  t.set(`${orchestrationId}\u0000#meta`, { ...base, sub_issue_id: '#meta', child_count: 1, platform_user_id: owner.platformUser });
  t.set(`${orchestrationId}\u0000${childId}`, {
    ...base,
    sub_issue_id: childId,
    depends_on: [],
    child_status: 'succeeded',
    linear_identifier: childIdentifier,
    title: 'Child work',
    child_task_id: `task-${childId}`,
  });
  table(TABLE.tasks).set(`task-${childId}`, { task_id: `task-${childId}`, repo: owner.repo, user_id: owner.platformUser, pr_number: 41, status: 'COMPLETED' });
  mockParentOf.set(childId, epicId);
}

/** A plain (non-orchestration) issue that already has a task with a PR, owned by `owner`. */
function seedStandaloneTask(owner: Tenant, issueId: string): void {
  table(TABLE.tasks).set(`task-${issueId}`, {
    task_id: `task-${issueId}`,
    linear_issue_id: issueId,
    created_at: '2026-10-01T00:00:00.000Z',
    repo: owner.repo,
    user_id: owner.platformUser,
    pr_number: 52,
    status: 'COMPLETED',
    channel_metadata: { linear_workspace_id: owner.id },
  });
}

// ── Deliveries ──────────────────────────────────────────────────────────
let seq = 0;
function issueEvent(org: string | undefined, projectId: string, actor: string): string {
  seq += 1;
  return JSON.stringify({
    action: 'create',
    type: 'Issue',
    ...(org !== undefined && { organizationId: org }),
    webhookTimestamp: Date.now(),
    actor: { id: actor, type: 'user' },
    data: {
      id: `issue-${seq}`,
      identifier: `ISS-${seq}`,
      title: `Issue ${seq}`,
      description: 'Do the thing.',
      projectId,
      teamId: 'team-1',
      labels: [{ id: 'lbl', name: 'bgagent' }],
    },
  });
}
function commentEvent(org: string, issueId: string, actor: string, text: string): string {
  seq += 1;
  return JSON.stringify({
    action: 'create',
    type: 'Comment',
    organizationId: org,
    webhookTimestamp: Date.now(),
    actor: { id: actor, type: 'user' },
    data: { id: `comment-${seq}`, body: text, issueId },
  });
}

interface Outcome {
  status: number;
  error?: string;
  /** What the receiver told the processor, when it invoked it. */
  forwarded?: Record<string, unknown>;
  /** Tasks persisted by this delivery. */
  tasks: Item[];
  /** Warn/error log messages emitted while handling it. */
  warnings: string[];
}

async function deliver(raw: string, signingKey: string, tamper?: (raw: string) => string): Promise<Outcome> {
  const before = new Set(table(TABLE.tasks).keys());
  const logStart = mockLogs.length;
  const invokeStart = mockInvokes.length;
  const signature = crypto.createHmac('sha256', signingKey).update(raw).digest('hex');
  const res = await receiver({
    body: tamper ? tamper(raw) : raw,
    headers: { 'linear-signature': signature },
    httpMethod: 'POST',
  } as unknown as APIGatewayProxyEvent);

  const invoked = mockInvokes.slice(invokeStart).find((i) => i.FunctionName === 'linear-processor');
  if (invoked) await processor(invoked.payload as never);

  const tasks = [...table(TABLE.tasks).entries()].filter(([k]) => !before.has(k)).map(([, v]) => v);
  return {
    status: res.statusCode,
    error: res.statusCode >= 400 ? (JSON.parse(res.body) as { error?: string }).error : undefined,
    forwarded: invoked?.payload,
    tasks,
    warnings: mockLogs.slice(logStart).filter((l) => l.level === 'warn' || l.level === 'error').map((l) => l.message),
  };
}

function expectNoTask(o: Outcome): void {
  expect(o.tasks).toEqual([]);
}
function expectOneTask(o: Outcome, t: Tenant): Item {
  expect(o.status).toBe(200);
  expect(o.tasks).toHaveLength(1);
  const task = o.tasks[0];
  expect(task.repo).toBe(t.repo);
  expect(task.user_id).toBe(t.platformUser);
  expect((task.channel_metadata as Record<string, string>).linear_workspace_id).toBe(t.id);
  return task;
}
/** No Linear write of any kind — a silent drop tells the sender nothing. */
function expectNoLinearWrites(): void {
  for (const fn of Object.values(mockFeedback)) {
    if (fn === mockFeedback.fetchRecentComments) continue;
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  mockTables.clear();
  mockSecrets.clear();
  mockInvokes.length = 0;
  mockLogs.length = 0;
  mockParentOf.clear();
  for (const fn of Object.values(mockFeedback)) fn.mockClear();
  invalidateLinearSecretCache();
  _resetCachesForTesting();
  _resetActiveWorkspaceCountCache();
  mockSecrets.set(STACK_WIDE_ARN, STACK_WIDE_SECRET);
  // Nothing in these flows may reach the network; a stray call fails loudly.
  global.fetch = jest.fn(async () => { throw new Error('unexpected network call in e2e test'); }) as never;
});

// ═══════════════════════════════════════════════════════════════════════
describe('several workspaces: the signature must attest the workspace', () => {
  beforeEach(() => {
    onboard(T.A);
    onboard(T.B);
    onboard(T.C);
    onboard(T.D);
  });

  test('control: a workspace signing its own delivery for its own project gets a task', async () => {
    const o = await deliver(issueEvent(T.A.id, T.A.project, T.A.actor), T.A.secret!);
    expectOneTask(o, T.A);
    expect(o.forwarded?.verified_via_stack_wide).toBe(false);
  });

  test('control: the same holds for the other owned workspace', async () => {
    expectOneTask(await deliver(issueEvent(T.B.id, T.B.project, T.B.actor), T.B.secret!), T.B);
  });

  test('the stack-wide secret naming a workspace with no secret of its own is refused, even with that workspace\'s project and user', async () => {
    const o = await deliver(issueEvent(T.C.id, T.C.project, T.C.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
    expect(o.error).toMatch(/Per-workspace signing secret required/);
    expect(o.forwarded).toBeUndefined();
  });

  test('the stack-wide secret naming another workspace\'s project and user is refused', async () => {
    const o = await deliver(issueEvent(T.C.id, T.B.project, T.B.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('the stack-wide secret naming a workspace that has its own secret is a mismatch', async () => {
    const o = await deliver(issueEvent(T.B.id, T.B.project, T.B.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
    expect(o.error).toMatch(/Invalid signature/);
  });

  test('the stack-wide secret naming an unregistered workspace is refused', async () => {
    const o = await deliver(issueEvent(UNREGISTERED, T.B.project, T.B.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('the stack-wide secret with no organizationId at all is refused', async () => {
    const o = await deliver(issueEvent(undefined, T.B.project, T.B.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('one workspace\'s secret cannot sign for another workspace', async () => {
    const o = await deliver(issueEvent(T.B.id, T.B.project, T.B.actor), T.A.secret!);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('a secret held by two workspaces attests neither, whichever one is named', async () => {
    // D holds a copy of A's secret. Signing with it and naming D must not pass,
    // because the signer could equally be A.
    const asD = await deliver(issueEvent(T.D.id, T.D.project, T.D.actor), T.D.secret!);
    expectNoTask(asD);
    expect(asD.status).toBe(401);
    expect(asD.error).toMatch(/not its own/);
  });

  test('a body altered after signing is refused', async () => {
    const o = await deliver(
      issueEvent(T.A.id, T.A.project, T.A.actor),
      T.A.secret!,
      (raw) => raw.replace(T.A.project, T.B.project),
    );
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('a correctly signed delivery naming another workspace\'s project creates nothing', async () => {
    const o = await deliver(issueEvent(T.A.id, T.B.project, T.A.actor), T.A.secret!);
    expectNoTask(o);
    expect(o.status).toBe(200);
    expect(o.warnings).toContain('Linear project is mapped to a different workspace than this webhook — dropping');
    expectNoLinearWrites();
  });

  test('...and naming the other workspace\'s user as the actor changes nothing', async () => {
    // User links are keyed by workspace, so B's user does not exist inside A.
    const o = await deliver(issueEvent(T.A.id, T.B.project, T.B.actor), T.A.secret!);
    expectNoTask(o);
  });

  test('a correctly signed delivery with an actor from another workspace does not run as that user', async () => {
    const o = await deliver(issueEvent(T.A.id, T.A.project, T.B.actor), T.A.secret!);
    expectNoTask(o);
  });

  test('a project mapped before owners were recorded is still served (reported by platform doctor)', async () => {
    // Pins the documented back-compat behaviour so a change to it is deliberate.
    mapProject('proj-legacy', 'org-legacy/repo', null);
    const o = await deliver(issueEvent(T.A.id, 'proj-legacy', T.A.actor), T.A.secret!);
    expect(o.tasks).toHaveLength(1);
    expect(o.warnings).toContain('Linear project mapping records no owning workspace — cannot verify the tenant');
  });

  test('a revoked workspace is refused even with its own secret', async () => {
    table(TABLE.registry).get(T.B.id)!.status = 'revoked';
    _resetCachesForTesting();
    const o = await deliver(issueEvent(T.B.id, T.B.project, T.B.actor), T.B.secret!);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('one workspace: the stack-wide secret binds to it, never to the body', () => {
  beforeEach(() => {
    // A single install that predates per-workspace secrets: C has no secret of its own.
    onboard(T.C);
  });

  test('control: the stack-wide fallback still works for the only workspace', async () => {
    const o = await deliver(issueEvent(T.C.id, T.C.project, T.C.actor), STACK_WIDE_SECRET);
    expectOneTask(o, T.C);
    expect(o.forwarded?.verified_via_stack_wide).toBe(true);
  });

  test('a claimed organizationId is replaced by the only workspace there is', async () => {
    const o = await deliver(issueEvent(UNREGISTERED, T.C.project, T.C.actor), STACK_WIDE_SECRET);
    const task = expectOneTask(o, T.C);
    expect((task.channel_metadata as Record<string, string>).linear_workspace_id).not.toBe(UNREGISTERED);
    expect(o.warnings).toContain('Ignoring body organizationId on a stack-wide-verified delivery; binding to the sole active workspace');
  });

  test('a lingering mapping from a workspace that is no longer active is not served', async () => {
    onboard(T.B, { status: 'revoked' });
    _resetActiveWorkspaceCountCache();
    const o = await deliver(issueEvent(UNREGISTERED, T.B.project, T.C.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.warnings).toContain('Linear project is mapped to a different workspace than this webhook — dropping');
  });

  test('a revoked workspace cannot ride the stack-wide fallback', async () => {
    onboard(T.B, { status: 'revoked' });
    const o = await deliver(issueEvent(T.B.id, T.B.project, T.B.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('a second workspace arriving inside the receiver\'s cache window is caught by the processor', async () => {
    // Warm the receiver's count cache at 1.
    await deliver(issueEvent(T.C.id, T.C.project, T.C.actor), STACK_WIDE_SECRET);
    // A second workspace is onboarded; the receiver still believes there is one.
    onboard(T.A);
    const o = await deliver(issueEvent(T.A.id, T.A.project, T.A.actor).replace(T.A.id, UNREGISTERED), STACK_WIDE_SECRET);
    expectNoTask(o);
    // The receiver lets it through on its stale count, flagged as stack-wide…
    expect(o.status).toBe(200);
    expect(o.forwarded?.verified_via_stack_wide).toBe(true);
    // …and the processor, reading the registry itself, refuses to pick a tenant.
    expect(o.warnings).toContain('Dropping stack-wide-verified Linear delivery: cannot determine the sending workspace');
  });

  test('once the cache expires the receiver refuses the fallback outright', async () => {
    onboard(T.A);
    _resetActiveWorkspaceCountCache();
    const o = await deliver(issueEvent(T.C.id, T.C.project, T.C.actor), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('an unrecorded secret provenance is fine while there is only one workspace', async () => {
    const solo: Tenant = { ...T.D, secret: 'lin_wh_d_dddddddddddddddddddddddd' };
    mockTables.clear();
    onboard(solo);
    const o = await deliver(issueEvent(solo.id, solo.project, solo.actor), solo.secret!);
    expectOneTask(o, solo);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('@bgagent comments act only on the sending workspace\'s work', () => {
  beforeEach(() => {
    onboard(T.A);
    onboard(T.B);
    seedEpic(T.B, 'epic-b', 'child-b', 'BBB-1');
    seedStandaloneTask(T.B, 'plain-b');
  });

  test('control: a comment on its own epic iterates that epic\'s child PR', async () => {
    const o = await deliver(commentEvent(T.B.id, 'epic-b', T.B.actor, '@bgagent BBB-1: tighten the timeout'), T.B.secret!);
    const task = expectOneTask(o, T.B);
    expect(task.pr_number).toBe(41);
  });

  test('control: a comment on its own sub-issue iterates it', async () => {
    const o = await deliver(commentEvent(T.B.id, 'child-b', T.B.actor, '@bgagent tighten the timeout'), T.B.secret!);
    expect(expectOneTask(o, T.B).pr_number).toBe(41);
  });

  test('control: a comment on its own plain issue iterates its PR', async () => {
    const o = await deliver(commentEvent(T.B.id, 'plain-b', T.B.actor, '@bgagent tighten the timeout'), T.B.secret!);
    expect(expectOneTask(o, T.B).pr_number).toBe(52);
  });

  test('another workspace\'s epic: nothing is created and nothing is posted', async () => {
    const o = await deliver(commentEvent(T.A.id, 'epic-b', T.A.actor, '@bgagent BBB-1: tighten the timeout'), T.A.secret!);
    expectNoTask(o);
    expect(o.status).toBe(200);
    expect(o.warnings).toContain('Comment trigger: commented issue belongs to a different workspace than this webhook — dropping');
    expectNoLinearWrites();
  });

  test('another workspace\'s sub-issue: nothing is created', async () => {
    const o = await deliver(commentEvent(T.A.id, 'child-b', T.A.actor, '@bgagent tighten the timeout'), T.A.secret!);
    expectNoTask(o);
    expectNoLinearWrites();
  });

  test('another workspace\'s plain issue: nothing is created', async () => {
    const o = await deliver(commentEvent(T.A.id, 'plain-b', T.A.actor, '@bgagent tighten the timeout'), T.A.secret!);
    expectNoTask(o);
    expectNoLinearWrites();
  });

  test('a "retry" on another workspace\'s epic does not re-run its work', async () => {
    table(TABLE.orch).get(`${deriveOrchestrationId('epic-b')}\u0000child-b`)!.child_status = 'failed';
    const o = await deliver(commentEvent(T.A.id, 'epic-b', T.A.actor, '@bgagent retry'), T.A.secret!);
    expectNoTask(o);
    expectNoLinearWrites();
  });

  test('a comment signed with the stack-wide secret on a multi-workspace stack is refused', async () => {
    const o = await deliver(commentEvent(T.B.id, 'epic-b', T.B.actor, '@bgagent BBB-1: x'), STACK_WIDE_SECRET);
    expectNoTask(o);
    expect(o.status).toBe(401);
  });

  test('a task with no recorded workspace is not acted on', async () => {
    delete table(TABLE.tasks).get('task-plain-b')!.channel_metadata;
    const o = await deliver(commentEvent(T.B.id, 'plain-b', T.B.actor, '@bgagent tighten the timeout'), T.B.secret!);
    expectNoTask(o);
  });
});

describe('@bgagent comments on a single-workspace stack', () => {
  test('a stack-wide comment claiming another organization is bound to the only workspace', async () => {
    onboard(T.C);
    seedEpic(T.C, 'epic-c', 'child-c', 'CCC-1');
    // The body claims B; the only workspace is C, and C's epic is what it reaches.
    const o = await deliver(commentEvent(T.B.id, 'epic-c', T.C.actor, '@bgagent CCC-1: x'), STACK_WIDE_SECRET);
    expectOneTask(o, T.C);
  });
});
