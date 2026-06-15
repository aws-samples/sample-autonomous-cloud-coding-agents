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

/*
 * Phase-1 deploy-then-verify lifecycle test for issue #317.
 *
 * Where Phase 0 (integ.task-api-smoke.ts) deployed a TRIMMED stack and asserted
 * a task merely persists at SUBMITTED, Phase 1 deploys the REAL, full AgentStack
 * (orchestrator + AgentCore runtime/memory + agent container) and drives a live
 * agent through its lifecycle, asserting the four terminal paths from the Cedar
 * HITL E2E matrix (docs/design/CEDAR_HITL_GATES.md §15.3):
 *
 *   1. submit -> run -> COMPLETED                       (repo-less default/agent-v1)
 *   2. submit -> run -> FAILED                          (coding/new-task-v1, bad repo)
 *   3. submit -> run -> AWAITING_APPROVAL -> approve    (write_env_files soft-deny gate)
 *   4. submit -> run -> AWAITING_APPROVAL -> deny       (write_env_files soft-deny gate)
 *
 * This runs in the DEDICATED E2E account (<integ-account>), which has no
 * backgroundagent-dev stack — so the AgentCore account-unique runtime/memory
 * name collision that forced Phase 0 to trim DOES NOT apply here. We deploy the
 * committed AgentStack unchanged: it leaves runtimeName/memoryName UNSET, and
 * CDK auto-generates names that include the stack name (backgroundagent-integ-
 * lifecycle), guaranteeing uniqueness. (A local developer's uncommitted agent.ts
 * pin must be stashed before a local `mise //cdk:integ`, or it would collide.)
 *
 * Determinism: there is no mock/scripted agent mode — every scenario runs the
 * real `claude` CLI against Bedrock. We bound cost and wall-clock with low
 * max_turns and a max_budget_usd cap, and steer terminal states with simple,
 * purpose-built task descriptions.
 */

import { randomBytes } from 'node:crypto';
import { ExpectedResult, IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App, type CfnOutput, Duration } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import { TaskStatus } from '../../src/constructs/task-status';
import { AgentStack } from '../../src/stacks/agent';

// Presence matcher for DynamoDB string attributes ({ S: <non-empty> }). Used to
// assert task-record fields exist and are populated without pinning their
// runtime-generated values (e.g. user_id is the caller's Cognito `sub`, a UUID
// not known at synth time; created_at/updated_at are ISO timestamps). #317 asks
// the terminal-state assertions to cover task_id, user_id, status, timestamps,
// and approval metadata — these matchers satisfy the "exists + non-empty" half
// while `status` is asserted exactly.
const presentString = Match.objectLike({ S: Match.stringLikeRegexp('.+') });

const app = new App();

// The real, full production stack. Environment-agnostic on purpose (same
// rationale as Phase 0): an explicit env would force the IntegTest DeployAssert
// stack — always environment-agnostic — into cross-region references it cannot
// resolve when reading this stack's outputs in the assertions below.
//
// DO NOT set runtimeName/memoryName here or pin them in agent.ts for this
// deploy: the committed defaults auto-generate stack-name-scoped unique names,
// which is exactly what lets backgroundagent-integ-lifecycle stand alone.
const stack = new AgentStack(app, 'backgroundagent-integ-lifecycle', {
  description: 'ABCA Phase-1 integ lifecycle stack (full AgentStack: orchestrator + agent runtime)',
});

// AgentStack exposes its API URL, Cognito IDs, and table names only as
// CfnOutputs (its constructs are private consts). Read the output tokens by
// construct id rather than adding public accessors to the production stack.
// CfnOutput exposes a `value` getter that returns the underlying token.
const output = (id: string): string => (stack.node.findChild(id) as CfnOutput).value;

const apiUrl = output('ApiUrl');
const userPoolId = output('UserPoolId');
const appClientId = output('AppClientId');
const taskTableName = output('TaskTableName');
const taskApprovalsTableName = output('TaskApprovalsTableName');
// AgentStack creates its OWN empty GitHubTokenSecret (agent.ts:181,
// RemovalPolicy.DESTROY) — it does not reference an external one. The gate
// scenarios populate it post-deploy from the pre-seeded secret below, which is
// exactly the documented operator flow (docs/guides/QUICK_START.md §4: read the
// GitHubTokenSecretArn output, put-secret-value the PAT into it). Automating
// that copy here keeps us aligned with the design (no agent.ts change) and the
// throwaway secret tears down with the stack.
const githubTokenSecretArn = output('GitHubTokenSecretArn');

// --- Gate-scenario configuration (scenarios 3 & 4) ----------------------------
// These two constants are the ONLY out-of-band wiring the gate scenarios need.
// They point at resources an admin provisions once in the E2E account
// (<integ-account>); scenarios 1 & 2 do NOT depend on them and run regardless.
//
//   SANDBOX_REPO  — a throwaway GitHub repo (owner/name) with a committed
//                   baseline (README + default branch). coding/new-task-v1
//                   clones it, the agent attempts a `config.env` write that
//                   trips the write_env_files soft-deny gate, and (on approve)
//                   pushes a `bgagent/<task_id>/<slug>` branch + opens a PR. The
//                   CI `always()` cleanup step deletes those branches each run.
//   PRESEEDED_PAT_SECRET — name (or ARN) of a STABLE Secrets Manager secret in
//                   the E2E account holding a fine-grained PAT scoped to
//                   SANDBOX_REPO. Copied into the stack-created GitHubTokenSecret
//                   by the token-seeding assertion below.
//
// Until these hold real values the gate submits will FAIL at clone/preflight
// (like scenario 2) rather than reaching AWAITING_APPROVAL — so flip them to the
// provisioned repo/secret before relying on scenarios 3 & 4.
const SANDBOX_REPO = 'ayushtr-aws/abca-integ-sandbox';
const PRESEEDED_PAT_SECRET = 'bgagent/integ/github-pat';

const integ = new IntegTest(app, 'TaskLifecycle', {
  testCases: [stack],
  // Force teardown on success and failure so a failed assertion never strands
  // the (expensive) full stack in the shared E2E account. The CI workflow keeps
  // a CloudFormation delete-stack safety net on top of this.
  cdkCommandOptions: {
    destroy: { args: { force: true } },
  },
});

// --- Authentication (same pattern as Phase 0) ---------------------------------
// A throwaway user the assertions authenticate as. The pool disables self-signup,
// so create + confirm it administratively, then mint a token via USER_PASSWORD_AUTH.
// The password is generated per-synth (no credential-shaped literal in source) and
// satisfies the Cognito default policy by construction.
const username = 'integ-lifecycle@example.com';
const password = `Aa1!${randomBytes(18).toString('base64url')}`;

// Service name MUST be the AWS SDK v2 form 'CognitoIdentityServiceProvider' — the
// assertion provider maps only the v2 key to the real client package (see the
// long note in integ.task-api-smoke.ts).
const cognitoService = 'CognitoIdentityServiceProvider';

const createUser = integ.assertions.awsApiCall(cognitoService, 'adminCreateUser', {
  UserPoolId: userPoolId,
  Username: username,
  MessageAction: 'SUPPRESS',
  TemporaryPassword: password,
});

const setPassword = integ.assertions.awsApiCall(cognitoService, 'adminSetUserPassword', {
  UserPoolId: userPoolId,
  Username: username,
  Password: password,
  Permanent: true,
});

const auth = integ.assertions.awsApiCall(cognitoService, 'initiateAuth', {
  AuthFlow: 'USER_PASSWORD_AUTH',
  ClientId: appClientId,
  AuthParameters: { USERNAME: username, PASSWORD: password },
});

const idToken = auth.getAttString('AuthenticationResult.IdToken');

// Conservative polling windows. Agent runs are real LLM sessions over a freshly
// cold-started AgentCore runtime; the first invocation pays the cold-start tax.
const TERMINAL_POLL = { totalTimeout: Duration.minutes(12), interval: Duration.seconds(30) };
// The interim AWAITING_APPROVAL state appears mid-run, before terminal — poll it
// on a shorter window so a stuck gate fails fast instead of burning the full
// terminal budget waiting for a state that will never arrive.
const GATE_POLL = { totalTimeout: Duration.minutes(8), interval: Duration.seconds(15) };

// --- Scenario 1: COMPLETED (repo-less default/agent-v1) -----------------------
// The default workflow is read-only (Read/Glob/Grep/WebFetch), requires no repo,
// and delivers an artifact to S3. A trivial, self-contained instruction completes
// in a single turn. No GitHub repo or token is involved.
const submitComplete = integ.assertions.httpApiCall(`${apiUrl}tasks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': idToken,
  },
  body: JSON.stringify({
    workflow_ref: 'default/agent-v1',
    task_description: 'Reply with exactly the single word: done. Do not use any tools.',
    max_turns: 2,
    max_budget_usd: 0.5,
  }),
});

// Poll the task row until it reaches COMPLETED. No getAttString is read off this
// call, so flattenResponse stays false and the nested objectLike expect works.
const pollComplete = integ.assertions.awsApiCall('DynamoDB', 'getItem', {
  TableName: taskTableName,
  Key: { task_id: { S: submitComplete.getAttString('body.data.task_id') } },
});
pollComplete
  .expect(ExpectedResult.objectLike({
    Item: Match.objectLike({
      status: { S: TaskStatus.COMPLETED },
      task_id: presentString,
      user_id: presentString,
      created_at: presentString,
      updated_at: presentString,
    }),
  }))
  .waitForAssertions(TERMINAL_POLL);

// --- Scenario 2: FAILED (coding/new-task-v1 against a nonexistent repo) --------
// The coding workflow requires a repo and clones it. Pointing it at a repo that
// does not exist makes preflight/clone fail fast, so the orchestrator writes a
// terminal FAILED with an error_message — no agent turn, no runtime spin-up, and
// no valid GitHub token required.
const submitFail = integ.assertions.httpApiCall(`${apiUrl}tasks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': idToken,
  },
  body: JSON.stringify({
    workflow_ref: 'coding/new-task-v1',
    repo: `abca-integ-nonexistent/does-not-exist-${randomBytes(6).toString('hex')}`,
    task_description: 'This task targets a nonexistent repo and must fail at clone/preflight.',
    max_turns: 1,
    max_budget_usd: 0.5,
  }),
});

const pollFail = integ.assertions.awsApiCall('DynamoDB', 'getItem', {
  TableName: taskTableName,
  Key: { task_id: { S: submitFail.getAttString('body.data.task_id') } },
});
pollFail
  .expect(ExpectedResult.objectLike({
    Item: Match.objectLike({
      status: { S: TaskStatus.FAILED },
      task_id: presentString,
      user_id: presentString,
      created_at: presentString,
      updated_at: presentString,
      // The terminal error path must record WHY it failed (clone/preflight).
      error_message: presentString,
    }),
  }))
  .waitForAssertions(TERMINAL_POLL);

// --- Token seeding (prerequisite for gate scenarios) --------------------------
// Copy the pre-seeded PAT into the stack-created GitHubTokenSecret so the agent
// runtime can clone SANDBOX_REPO and push a branch. This automates the documented
// operator step (QUICK_START.md §4). No getAttString is read off seedPut, and the
// SecretString token is consumed inline by seedPut, never asserted on.
const seedGet = integ.assertions.awsApiCall('SecretsManager', 'getSecretValue', {
  SecretId: PRESEEDED_PAT_SECRET,
});

const seedPut = integ.assertions.awsApiCall('SecretsManager', 'putSecretValue', {
  SecretId: githubTokenSecretArn,
  SecretString: seedGet.getAttString('SecretString'),
});

// --- Scenario 3: AWAITING_APPROVAL -> approve ---------------------------------
// coding/new-task-v1 against the sandbox. The task asks the agent to write a
// `config.env` file, which the Write tool routes through the write_env_files
// soft-deny rule (agent/policies/soft_deny.cedar) -> the task parks at
// AWAITING_APPROVAL with a PENDING approval row. We approve it, then assert the
// row flips to APPROVED. (Post-approval the agent may COMPLETE or FAIL — both
// terminal — so the deterministic assertion is the recorded decision, not a
// specific terminal status.)
const submitApprove = integ.assertions.httpApiCall(`${apiUrl}tasks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': idToken,
  },
  body: JSON.stringify({
    workflow_ref: 'coding/new-task-v1',
    repo: SANDBOX_REPO,
    task_description: 'Create a file named config.env at the repo root with the single line FOO=bar, then commit it.',
    max_turns: 6,
    max_budget_usd: 0.5,
  }),
});
const approveTaskId = submitApprove.getAttString('body.data.task_id');

// Wait for the gate to open (interim AWAITING_APPROVAL).
const pollGateApprove = integ.assertions.awsApiCall('DynamoDB', 'getItem', {
  TableName: taskTableName,
  Key: { task_id: { S: approveTaskId } },
});
pollGateApprove
  .expect(ExpectedResult.objectLike({
    Item: Match.objectLike({
      status: { S: TaskStatus.AWAITING_APPROVAL },
      task_id: presentString,
      user_id: presentString,
      // Cedar HITL invariant: AWAITING_APPROVAL rows carry the pending request id
      // that the approve/deny call must reference (task-status.ts §invariant).
      awaiting_approval_request_id: presentString,
    }),
  }))
  .waitForAssertions(GATE_POLL);

// Read the PENDING approval row's request_id (SK). Querying by task_id (PK) is
// required because we do not know the agent-minted request_id. getAttString here
// flips this call to a flattened response, so we do NOT .expect() on it — the
// decision assertion below uses a separate getItem.
const queryApprove = integ.assertions.awsApiCall('DynamoDB', 'query', {
  TableName: taskApprovalsTableName,
  KeyConditionExpression: 'task_id = :tid',
  ExpressionAttributeValues: { ':tid': { S: approveTaskId } },
});
const approveRequestId = queryApprove.getAttString('Items.0.request_id.S');

const approve = integ.assertions.httpApiCall(`${apiUrl}tasks/${approveTaskId}/approve`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': idToken,
  },
  body: JSON.stringify({ request_id: approveRequestId, decision: 'approve', scope: 'this_call' }),
});

// Assert the decision was recorded on the approval row. Now that request_id is
// known we read the exact row by its full key.
const pollApproveDecision = integ.assertions.awsApiCall('DynamoDB', 'getItem', {
  TableName: taskApprovalsTableName,
  Key: { task_id: { S: approveTaskId }, request_id: { S: approveRequestId } },
});
pollApproveDecision
  .expect(ExpectedResult.objectLike({
    Item: Match.objectLike({
      status: { S: 'APPROVED' },
      task_id: presentString,
      request_id: presentString,
      // ApproveTaskFn writes decided_at + the caller's user_id on the row; their
      // presence proves the decision was recorded by the owning caller, not just
      // that a status string flipped (approval metadata, per #317).
      user_id: presentString,
      decided_at: presentString,
    }),
  }))
  .waitForAssertions(GATE_POLL);

// --- Scenario 4: AWAITING_APPROVAL -> deny ------------------------------------
// Identical trigger to scenario 3; we deny instead and assert the row flips to
// DENIED.
const submitDeny = integ.assertions.httpApiCall(`${apiUrl}tasks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': idToken,
  },
  body: JSON.stringify({
    workflow_ref: 'coding/new-task-v1',
    repo: SANDBOX_REPO,
    task_description: 'Create a file named config.env at the repo root with the single line FOO=bar, then commit it.',
    max_turns: 6,
    max_budget_usd: 0.5,
  }),
});
const denyTaskId = submitDeny.getAttString('body.data.task_id');

const pollGateDeny = integ.assertions.awsApiCall('DynamoDB', 'getItem', {
  TableName: taskTableName,
  Key: { task_id: { S: denyTaskId } },
});
pollGateDeny
  .expect(ExpectedResult.objectLike({
    Item: Match.objectLike({
      status: { S: TaskStatus.AWAITING_APPROVAL },
      task_id: presentString,
      user_id: presentString,
      awaiting_approval_request_id: presentString,
    }),
  }))
  .waitForAssertions(GATE_POLL);

const queryDeny = integ.assertions.awsApiCall('DynamoDB', 'query', {
  TableName: taskApprovalsTableName,
  KeyConditionExpression: 'task_id = :tid',
  ExpressionAttributeValues: { ':tid': { S: denyTaskId } },
});
const denyRequestId = queryDeny.getAttString('Items.0.request_id.S');

const deny = integ.assertions.httpApiCall(`${apiUrl}tasks/${denyTaskId}/deny`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': idToken,
  },
  body: JSON.stringify({ request_id: denyRequestId, decision: 'deny', reason: 'integ: exercising the deny path' }),
});

const pollDenyDecision = integ.assertions.awsApiCall('DynamoDB', 'getItem', {
  TableName: taskApprovalsTableName,
  Key: { task_id: { S: denyTaskId }, request_id: { S: denyRequestId } },
});
pollDenyDecision
  .expect(ExpectedResult.objectLike({
    Item: Match.objectLike({
      status: { S: 'DENIED' },
      task_id: presentString,
      request_id: presentString,
      user_id: presentString,
      decided_at: presentString,
      // DenyTaskFn persists the (sanitized) reason; we sent a non-empty one.
      deny_reason: presentString,
    }),
  }))
  .waitForAssertions(GATE_POLL);

// --- Execution order ----------------------------------------------------------
// Auth first, then the two no-repo scenarios (submit both, then wait so their
// agent runs proceed concurrently). Next seed the GitHub token, then submit both
// gate tasks so they spin up concurrently and park at their gates; finally drive
// approve then deny. The approve/deny flows are sequential because each
// approve/deny POST needs the request_id read from the parked task's approval row.
createUser
  .next(setPassword)
  .next(auth)
  .next(submitComplete)
  .next(submitFail)
  .next(pollComplete)
  .next(pollFail)
  .next(seedGet)
  .next(seedPut)
  .next(submitApprove)
  .next(submitDeny)
  .next(pollGateApprove)
  .next(queryApprove)
  .next(approve)
  .next(pollApproveDecision)
  .next(pollGateDeny)
  .next(queryDeny)
  .next(deny)
  .next(pollDenyDecision);
