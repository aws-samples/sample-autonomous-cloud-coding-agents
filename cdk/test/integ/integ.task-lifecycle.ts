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
import { TaskStatus } from '../../src/constructs/task-status';
import { AgentStack } from '../../src/stacks/agent';

// NOTE on assertion shape: every terminal/gate check below runs inside
// `waitForAssertions` (a polling Step Functions waiter). Nested `Match.*`
// matchers (objectLike / stringLikeRegexp) CANNOT be used there — the assertion
// provider serializes the Match object's internals ({name, partial, pattern})
// into the expected pattern, and the waiter then treats those as literal
// required keys that never exist on the row, so the assertion fails forever even
// when the data is correct (observed live: a COMPLETED task polled 25× and timed
// out). Polled assertions therefore use ONLY flat, exact scalar values (the
// `status`/decision string), which serialize cleanly. Asserting field PRESENCE
// (task_id/user_id/timestamps/approval metadata, #317) needs a non-polled
// getItem with assertAtPath — tracked as a follow-up on #317.

const app = new App();

// Per-run UNIQUE stack name: `int-<commit-hash>`. A fixed name is a trap for this
// stack — the AgentCore Runtime injects service-managed `agentic_ai` ENIs that AWS
// releases ASYNCHRONOUSLY, so `cdk destroy` reliably fails the subnet/SG/VPC
// deletes (DependencyViolation) and strands the stack. With a fixed name that
// stranded stack BLOCKS the next run (name conflict). A unique per-commit name
// means a failed teardown never blocks a later run, and an out-of-band ephemeral
// sweeper can reclaim `int-*` stacks once their ENIs detach.
//
// The hash comes from the COMMIT_HASH env var (set by CI from the resolved head
// SHA; the mise //cdk:integ task falls back to the local git SHA). We read the
// ENV directly rather than CDK context: integ-runner synthesizes the test app in
// its own subprocess and does NOT forward CDK_CONTEXT_JSON / `-c` from our shell
// to that synth, but the subprocess DOES inherit the environment — so the env var
// reaches `process.env` here reliably where `tryGetContext` would not. Falls back
// to 'local' outside CI/git. (Date.now()/random are avoided — they'd break integ
// snapshot determinism; CI always supplies a real sha.)
const commitHash = (process.env.COMMIT_HASH ?? '').slice(0, 8) || 'local';
const stackName = `int-${commitHash}`;

// The real, full production stack. Environment-agnostic on purpose (same
// rationale as Phase 0): an explicit env would force the IntegTest DeployAssert
// stack — always environment-agnostic — into cross-region references it cannot
// resolve when reading this stack's outputs in the assertions below.
//
// DO NOT set runtimeName/memoryName here or pin them in agent.ts for this
// deploy: the committed defaults auto-generate stack-name-scoped unique names,
// so each `int-<hash>` stack gets its own non-colliding AgentCore names.
const stack = new AgentStack(app, stackName, {
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
// The submit path enforces an onboarding gate: a repo must have an active row in
// RepoTable or POST /tasks returns 422 REPO_NOT_ONBOARDED before clone/preflight.
// The gate scenarios onboard SANDBOX_REPO here (a putItem assertion) rather than
// adding a Blueprint construct to the production stack — test-side only.
const repoTableName = output('RepoTableName');
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
  // Disable the two-phase update workflow. By default integ-runner deploys the
  // committed snapshot first, then re-deploys the current version to verify
  // in-place updates don't break. The AgentCore Runtime takes several minutes to
  // go CREATING -> READY and is partly immutable; the second deploy phase races
  // the first (Runtime still CREATING) -> 409 "agent is currently being modified"
  // -> integ-runner aborts mid-deploy and teardown strands a CREATING Runtime.
  // We validate runtime BEHAVIOR, not stack-update safety, so a single clean
  // deploy is correct here.
  stackUpdateWorkflow: false,
  // Force teardown on success and failure so a failed assertion never strands
  // the (expensive) full stack in the shared E2E account.
  //
  // expectError on destroy: `cdk destroy` RELIABLY fails this stack — the
  // AgentCore Runtime's service-managed `agentic_ai` ENIs are released
  // asynchronously by AWS, so the subnet/SG/VPC deletes hit DependencyViolation
  // ("has dependencies and cannot be deleted" / "has a dependent object") while
  // the ENIs linger. Without expectError, integ-runner would mark the whole run
  // FAILED on teardown alone — masking whether the ASSERTIONS passed. We tolerate
  // the teardown failure (scoped to the dependency-violation message so unrelated
  // teardown bugs still surface) and hand the stranded `int-<hash>` stack to the
  // out-of-band ephemeral sweeper, which reclaims it once AWS detaches the ENIs.
  cdkCommandOptions: {
    destroy: {
      args: { force: true },
      expectError: true,
      expectedMessage: 'cannot be deleted|dependent object|DELETE_FAILED',
    },
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
    // Keep this a plain, benign natural-language request. An earlier terse,
    // imperative phrasing ("Reply with exactly the single word: done. Do not
    // use any tools.") tripped the Bedrock content-policy guardrail at submit
    // (400 VALIDATION_ERROR "Task description was blocked by content policy").
    task_description: 'Please write a one-sentence summary explaining what a pull request is in software development.',
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
  .expect(ExpectedResult.objectLike({ Item: { status: { S: TaskStatus.COMPLETED } } }))
  .waitForAssertions(TERMINAL_POLL);

// --- Scenario 2: FAILED (coding/new-task-v1, onboarded repo, clone fails) ------
// The submit path runs the onboarding gate (RepoTable) BEFORE clone/preflight,
// so an un-onboarded repo is rejected at submit (422 REPO_NOT_ONBOARDED) and the
// task never reaches a terminal FAILED. To exercise the terminal-error path we
// must therefore ONBOARD the repo first, then make CLONE fail: the onboarding
// gate only checks RepoTable, not GitHub, so we onboard a repo slug that does
// not exist on GitHub. Submit then passes admission, preflight/clone 404s, and
// the orchestrator writes terminal FAILED + error_message — no agent turn, no
// runtime spin-up. (onboardFailRepo is sequenced before this submit.)
const failRepo = `abca-integ-nonexistent/does-not-exist-${randomBytes(6).toString('hex')}`;
const onboardFailRepo = integ.assertions.awsApiCall('DynamoDB', 'putItem', {
  TableName: repoTableName,
  Item: {
    repo: { S: failRepo },
    status: { S: 'active' },
    onboarded_at: { S: '2026-01-01T00:00:00.000Z' },
    updated_at: { S: '2026-01-01T00:00:00.000Z' },
  },
});

const submitFail = integ.assertions.httpApiCall(`${apiUrl}tasks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': idToken,
  },
  body: JSON.stringify({
    workflow_ref: 'coding/new-task-v1',
    repo: failRepo,
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
  .expect(ExpectedResult.objectLike({ Item: { status: { S: TaskStatus.FAILED } } }))
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

// Onboard SANDBOX_REPO so the gate submits pass the onboarding gate (otherwise
// 422 REPO_NOT_ONBOARDED at submit, before the agent ever runs). A minimal active
// row is enough — the agent reads the GitHub token from the platform-default
// GitHubTokenSecret we seeded above, so the blueprint needs no per-repo token.
const onboardSandbox = integ.assertions.awsApiCall('DynamoDB', 'putItem', {
  TableName: repoTableName,
  Item: {
    repo: { S: SANDBOX_REPO },
    status: { S: 'active' },
    onboarded_at: { S: '2026-01-01T00:00:00.000Z' },
    updated_at: { S: '2026-01-01T00:00:00.000Z' },
  },
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
  .expect(ExpectedResult.objectLike({ Item: { status: { S: TaskStatus.AWAITING_APPROVAL } } }))
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
  .expect(ExpectedResult.objectLike({ Item: { status: { S: 'APPROVED' } } }))
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
  .expect(ExpectedResult.objectLike({ Item: { status: { S: TaskStatus.AWAITING_APPROVAL } } }))
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
  .expect(ExpectedResult.objectLike({ Item: { status: { S: 'DENIED' } } }))
  .waitForAssertions(GATE_POLL);

// --- Execution order ----------------------------------------------------------
// Auth first. Scenario 1 (no repo) can submit immediately. Scenario 2 needs its
// repo onboarded BEFORE submit (else 422 at the onboarding gate), so onboardFail
// precedes submitFail. Both no-repo/clone-fail terminals are then awaited so they
// proceed concurrently. Next seed the GitHub token AND onboard the sandbox, then
// submit both gate tasks so they spin up concurrently and park at their gates;
// finally drive approve then deny. The approve/deny flows are sequential because
// each POST needs the request_id read from the parked task's approval row.
createUser
  .next(setPassword)
  .next(auth)
  .next(submitComplete)
  .next(onboardFailRepo)
  .next(submitFail)
  .next(pollComplete)
  .next(pollFail)
  .next(seedGet)
  .next(seedPut)
  .next(onboardSandbox)
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
