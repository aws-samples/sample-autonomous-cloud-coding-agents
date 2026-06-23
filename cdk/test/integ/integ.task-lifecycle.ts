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
 * This is environment-agnostic: it deploys to whatever account/region the
 * caller's AWS credentials resolve to (CI assumes the integ role; local runs use
 * your own creds). It should run in a DEDICATED integ account with no
 * backgroundagent-dev/main stack, so the AgentCore account-unique runtime/memory
 * names don't collide. We deploy the committed AgentStack unchanged: it leaves
 * runtimeName/memoryName UNSET and CDK auto-generates names scoped to the
 * per-run stack name (int-<commit-hash>, see below), guaranteeing uniqueness.
 * (A local developer's uncommitted agent.ts name pin must be stashed before a
 * local `mise //cdk:integ`, or it would collide.)
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
// means a failed teardown never blocks a later run, and the out-of-band ephemeral
// sweeper (.github/workflows/integ-sweeper.yml) reclaims `int-*` stacks once their
// ENIs detach, alarming if any stays stuck past its age threshold.
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
// They point at resources an operator provisions once in the integ account
// (whichever account the run deploys to); scenarios 1 & 2 do NOT depend on them
// and run regardless.
//
//   SANDBOX_REPO  — a throwaway GitHub repo (owner/name) with a committed
//                   baseline (README + default branch). coding/new-task-v1
//                   clones it, the agent attempts a `config.env` write that
//                   trips the write_env_files soft-deny gate, and (on approve)
//                   pushes a `bgagent/<task_id>/<slug>` branch + opens a PR. The
//                   CI `always()` cleanup step deletes those branches each run.
//                   The PAT below must have Contents+PR WRITE on this repo (a
//                   read-only token clones fine but the agent's `git push` 403s).
//   PRESEEDED_PAT_SECRET — name of a STABLE Secrets Manager secret in the integ
//                   account holding a fine-grained PAT scoped to SANDBOX_REPO.
//                   Resolved by NAME (not ARN) so it is account-agnostic; copied
//                   into the stack-created GitHubTokenSecret by the token-seeding
//                   assertion below.
//
// Sourced from CI repo vars (INTEG_SANDBOX_REPO / INTEG_PAT_SECRET_ID — the same
// vars the integ.yml sandbox-cleanup step reads), so the gate scenarios bind to
// whatever sandbox+secret the running account provisioned. There is deliberately
// NO fallback literal: an account that hasn't provisioned a sandbox (e.g. upstream
// aws-samples, or any fork) leaves both unset, and scenarios 3 & 4 SKIP with a
// clear message (see the chain-assembly block at the bottom) rather than silently
// routing the gate runs — which clone and push with a write-PAT — into one
// contributor's personal repo. Set both vars to exercise the Cedar gates;
// scenarios 1 & 2 always run regardless.
const SANDBOX_REPO = process.env.INTEG_SANDBOX_REPO;
const PRESEEDED_PAT_SECRET = process.env.INTEG_PAT_SECRET_ID;

// Gate scenarios (3 & 4) require BOTH a sandbox repo and its pre-seeded PAT. When
// either is unset, skip them (scenarios 1 & 2 still run). This keeps the test
// account-agnostic: it never falls back to a hardcoded personal repo.
const gatesEnabled = Boolean(SANDBOX_REPO && PRESEEDED_PAT_SECRET);
if (!gatesEnabled) {
  // eslint-disable-next-line no-console
  console.warn(
    '[integ.task-lifecycle] INTEG_SANDBOX_REPO / INTEG_PAT_SECRET_ID not set — ' +
      'skipping Cedar gate scenarios 3 & 4 (approve/deny). Set both to exercise the gates.',
  );
}

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
  // out-of-band ephemeral sweeper (.github/workflows/integ-sweeper.yml), which
  // reclaims it once AWS detaches the ENIs and alarms if it stays stuck.
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

// --- Execution order (scenarios 1 & 2) ----------------------------------------
// Auth first, then SEED THE GITHUB TOKEN BEFORE ANY SUBMIT. This ordering is
// load-bearing: the orchestrator's resolveGitHubToken caches the secret value
// for 5 min keyed by ARN (context-hydration.ts). Any coding-workflow task that
// runs GitHub preflight reads + caches the token. Scenario 2 (coding/new-task-v1)
// runs preflight too — so if it ran BEFORE the seed, it would cache the stack's
// INITIAL EMPTY secret and every later gate task would reuse that empty token →
// preflight 401 GITHUB_UNREACHABLE → FAILED before ever reaching the gate
// (observed live). Seeding right after auth means the secret is populated before
// the first token read, so no empty value is ever cached. This is exactly the
// documented operator flow (QUICK_START §4: populate the secret before submitting
// tasks) — no agent.ts change. The seed only happens when the gates are enabled
// (it is sourced from the pre-seeded PAT secret); scenario 2 targets a
// nonexistent repo and fails at clone regardless of token, so it is unaffected.
//
// Onboarding: scenario 2's repo and the sandbox both need a RepoTable row before
// submit (else 422 REPO_NOT_ONBOARDED), so both onboard steps precede their
// submits. Gate approve/deny run sequentially since each POST needs the
// request_id read from the parked task's approval row.
let chain = createUser
  .next(setPassword)
  .next(auth)
  .next(onboardFailRepo)
  .next(submitComplete)
  .next(submitFail)
  .next(pollComplete)
  .next(pollFail);

// --- Scenarios 3 & 4 (Cedar gates) — only when a sandbox is configured --------
// Every assertion call below is CONSTRUCTED only inside this block, so when the
// gates are disabled nothing is registered with the integ provider and the run
// reduces cleanly to scenarios 1 & 2 (no skipped/failing gate steps, no PAT seed
// into the stack secret, no clone of a personal repo).
if (gatesEnabled) {
  // Narrow the env-sourced config to non-null for this block.
  const sandboxRepo = SANDBOX_REPO as string;
  const patSecretId = PRESEEDED_PAT_SECRET as string;

  // Re-mint a FRESH token right before each approve/deny POST. The Cognito app
  // client uses the default 60-min ID-token validity (task-api.ts sets no
  // idTokenValidity), but the strictly-serial .next() chain reaches the gate POSTs
  // only after ~32 min (approve) / ~48 min (deny) of polling budget PLUS real agent
  // cold-start + runtime — the live run took ~54 min. Reusing the original token
  // would risk a 401 (expired) → the decision never records → false timeout keyed
  // to agent latency. These re-auths run just before their POSTs in the chain, so
  // each token is minted minutes (not ~50 min) before use. The user/password are
  // permanent (adminSetUserPassword above), so re-auth needs no new setup.
  const reAuthApprove = integ.assertions.awsApiCall(cognitoService, 'initiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: appClientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });
  const approveToken = reAuthApprove.getAttString('AuthenticationResult.IdToken');

  const reAuthDeny = integ.assertions.awsApiCall(cognitoService, 'initiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: appClientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });
  const denyToken = reAuthDeny.getAttString('AuthenticationResult.IdToken');

  // --- Token seeding (prerequisite for gate scenarios) ------------------------
  // Copy the pre-seeded PAT into the stack-created GitHubTokenSecret so the agent
  // runtime can clone the sandbox and push a branch. This automates the documented
  // operator step (QUICK_START.md §4). No getAttString is read off seedPut, and the
  // SecretString token is consumed inline by seedPut, never asserted on.
  const seedGet = integ.assertions.awsApiCall('SecretsManager', 'getSecretValue', {
    SecretId: patSecretId,
  });

  const seedPut = integ.assertions.awsApiCall('SecretsManager', 'putSecretValue', {
    SecretId: githubTokenSecretArn,
    SecretString: seedGet.getAttString('SecretString'),
  });

  // Onboard the sandbox so the gate submits pass the onboarding gate (otherwise
  // 422 REPO_NOT_ONBOARDED at submit, before the agent ever runs). A minimal active
  // row is enough — the agent reads the GitHub token from the platform-default
  // GitHubTokenSecret we seeded above, so the blueprint needs no per-repo token.
  const onboardSandbox = integ.assertions.awsApiCall('DynamoDB', 'putItem', {
    TableName: repoTableName,
    Item: {
      repo: { S: sandboxRepo },
      status: { S: 'active' },
      onboarded_at: { S: '2026-01-01T00:00:00.000Z' },
      updated_at: { S: '2026-01-01T00:00:00.000Z' },
    },
  });

  // --- Scenario 3: AWAITING_APPROVAL -> approve -------------------------------
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
      repo: sandboxRepo,
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
  // required because we do not know the agent-minted request_id. The status=PENDING
  // FilterExpression makes Items[0] deterministic: a task could trip the gate more
  // than once (or carry already-decided rows), and an unfiltered query orders only
  // by SK, so without the filter Items[0] could be the wrong/decided row and the
  // POST would target the wrong request_id. getAttString here flips this call to a
  // flattened response, so we do NOT .expect() on it.
  const queryApprove = integ.assertions.awsApiCall('DynamoDB', 'query', {
    TableName: taskApprovalsTableName,
    KeyConditionExpression: 'task_id = :tid',
    FilterExpression: '#st = :pending',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':tid': { S: approveTaskId }, ':pending': { S: 'PENDING' } },
  });
  const approveRequestId = queryApprove.getAttString('Items.0.request_id.S');

  const approve = integ.assertions.httpApiCall(`${apiUrl}tasks/${approveTaskId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Fresh token (see reAuthApprove) — the original idToken may be expired by now.
      'Authorization': approveToken,
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

  // --- Scenario 4: AWAITING_APPROVAL -> deny ----------------------------------
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
      repo: sandboxRepo,
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
    FilterExpression: '#st = :pending',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':tid': { S: denyTaskId }, ':pending': { S: 'PENDING' } },
  });
  const denyRequestId = queryDeny.getAttString('Items.0.request_id.S');

  const deny = integ.assertions.httpApiCall(`${apiUrl}tasks/${denyTaskId}/deny`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Fresh token (see reAuthDeny) — the original idToken may be expired by now.
      'Authorization': denyToken,
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

  // Splice the gate steps into the chain. seedPut/onboardSandbox precede the gate
  // submits (token + onboarding must exist first); approve/deny run sequentially.
  chain = chain
    .next(seedGet)
    .next(seedPut)
    .next(onboardSandbox)
    .next(submitApprove)
    .next(submitDeny)
    .next(pollGateApprove)
    .next(queryApprove)
    .next(reAuthApprove)
    .next(approve)
    .next(pollApproveDecision)
    .next(pollGateDeny)
    .next(queryDeny)
    .next(reAuthDeny)
    .next(deny)
    .next(pollDenyDecision);
}
