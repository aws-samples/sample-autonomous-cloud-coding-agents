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
 * Phase-0 deploy-then-verify smoke test for issue #236.
 *
 * integ-runner deploys a TRIMMED stack (Task API + the two DynamoDB tables it
 * needs) into a real AWS account, then asserts the create-task happy path
 * end-to-end: mint a Cognito token, POST /tasks, and confirm the record
 * persisted as SUBMITTED. The stack deliberately OMITS the orchestrator and the
 * AgentCore runtime/memory, so no agent ever runs — the task simply persists.
 * That keeps the test cheap, deterministic, and (critically) free of the
 * account-unique AgentCore name collision with the live `backgroundagent-dev`
 * stack in the target account. Poll-to-terminal / real agent runs are Phase 1.
 */

import { randomBytes } from 'node:crypto';
import { ExpectedResult, IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App, CfnOutput, PhysicalName, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { TaskApi } from '../../src/constructs/task-api';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { TaskStatus } from '../../src/constructs/task-status';
import { TaskTable } from '../../src/constructs/task-table';

/**
 * Trimmed stack: Task API backed by the task + events tables, with no
 * onboarding gate (no repoTable) and no orchestrator wiring. A submitted task
 * therefore persists at SUBMITTED and is never advanced.
 */
class TaskApiSmokeStack extends Stack {
  public readonly taskApi: TaskApi;
  public readonly taskTable: TaskTable;

  constructor(scope: Construct, id: string) {
    // Environment-agnostic on purpose. integ-runner deploys into whatever
    // account/region the active AWS credentials resolve to (the shared account
    // that also hosts the live backgroundagent-dev stack). An
    // explicit env here would force the IntegTest DeployAssert stack — which is
    // always environment-agnostic — into a cross-region reference it cannot
    // resolve (CrossRegionReferencesRequireExplicitRegion) when it reads this
    // stack's UserPool / API outputs in the assertions below.
    super(scope, id, {
      description: 'ABCA Phase-0 integ smoke stack (Task API + tables, no orchestrator/agent)',
    });

    // Explicit physical name so the DeployAssert stack (environment-agnostic)
    // can read the table cross-environment in the getItem assertion below.
    // Without it CDK throws CannotUseCrossEnvironment at synth.
    this.taskTable = new TaskTable(this, 'TaskTable', {
      tableName: PhysicalName.GENERATE_IF_NEEDED,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    const taskEventsTable = new TaskEventsTable(this, 'TaskEventsTable', {
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    // No repoTable → onboarding gate disabled (all repos accepted).
    // No orchestratorFunctionArn → create-task does not async-invoke anything.
    this.taskApi = new TaskApi(this, 'TaskApi', {
      taskTable: this.taskTable.table,
      taskEventsTable: taskEventsTable.table,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, 'ApiUrl', { value: this.taskApi.api.url });
    new CfnOutput(this, 'UserPoolId', { value: this.taskApi.userPool.userPoolId });
    new CfnOutput(this, 'AppClientId', { value: this.taskApi.appClientId });
    new CfnOutput(this, 'TaskTableName', { value: this.taskTable.table.tableName });
  }
}

// Stack name is run-unique in CI (`int-<short-sha>-<run-number>`, set by
// integ.yml) so a stranded stack from a cancelled/crashed run never collides
// with — or blocks — a later run under one fixed name. Falls back to a stable
// local name so the `mise //cdk:integ` dev path is unchanged. The `int-` prefix
// keeps it letter-led and the rest is lowercase-alphanumeric + hyphens, so the
// name is CloudFormation-valid.
const app = new App();
const stackName = process.env.INTEG_STACK_NAME || 'backgroundagent-integ-local';
const stack = new TaskApiSmokeStack(app, stackName);

const integ = new IntegTest(app, 'TaskApiSmoke', {
  testCases: [stack],
  // Force teardown on success and failure so a failed assertion never strands
  // the stack (and its billable resources) in the shared integ account.
  cdkCommandOptions: {
    destroy: { args: { force: true } },
  },
});

// A throwaway user the assertions authenticate as. The pool disables
// self-signup, so create + confirm it administratively, then mint a token via
// the USER_PASSWORD_AUTH flow the app client enables.
//
// The password is generated per-synth (not hardcoded) so no credential-shaped
// literal lives in source. It satisfies the Cognito default policy (>=8 chars,
// upper + lower + digit + symbol) by construction: a fixed symbol/case scaffold
// plus 18 bytes of randomness. The user and its pool are destroyed on teardown,
// so the value never outlives a single run.
const username = 'integ-smoke@example.com';
const password = `Aa1!${randomBytes(18).toString('base64url')}`;

// Service name MUST be the AWS SDK v2 form 'CognitoIdentityServiceProvider'.
// The assertion provider's normalizeServiceName() lowercases the string and
// resolves it through a v2→v3 client map; only the v2 key maps to the real
// package '@aws-sdk/client-cognito-identity-provider'. Passing the v3-style
// 'CognitoIdentityProvider' falls through unmapped and the provider Lambda
// fails at runtime trying to require the nonexistent
// '@aws-sdk/client-cognitoidentityprovider'.
const cognitoService = 'CognitoIdentityServiceProvider';

const createUser = integ.assertions.awsApiCall(cognitoService, 'adminCreateUser', {
  UserPoolId: stack.taskApi.userPool.userPoolId,
  Username: username,
  MessageAction: 'SUPPRESS',
  TemporaryPassword: password,
});

const setPassword = integ.assertions.awsApiCall(cognitoService, 'adminSetUserPassword', {
  UserPoolId: stack.taskApi.userPool.userPoolId,
  Username: username,
  Password: password,
  Permanent: true,
});

const auth = integ.assertions.awsApiCall(cognitoService, 'initiateAuth', {
  AuthFlow: 'USER_PASSWORD_AUTH',
  ClientId: stack.taskApi.appClientId,
  AuthParameters: { USERNAME: username, PASSWORD: password },
});

// POST /tasks with the minted ID token. No repoTable means the repo string is
// accepted without an onboarding check; the task persists at SUBMITTED.
//
// NOTE: no inline `.expect()` here. Reading `body.data.task_id` below via
// getAttString() flips this call's `flattenResponse` to true, so its response
// is returned as dotted leaf keys (apiCallResponse.body.data.task_id, …) with
// no nested `apiCallResponse` object. The provider's assertion path then reads
// `result.apiCallResponse` (undefined for a flattened call) and any nested
// objectLike expectation fails with "Expected type object but received
// undefined". HttpApiCall.assertAtPath is a no-op in this alpha, so we cannot
// assert-at-path either. The create is instead verified transitively: the GET
// below returns 200 + SUBMITTED for the returned task_id, and the DynamoDB
// getItem confirms the persisted row — a stronger check than a bare 201.
const createTask = integ.assertions.httpApiCall(`${stack.taskApi.api.url}tasks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // Raw ID token, no "Bearer " prefix — matches the API's Cognito authorizer.
    'Authorization': auth.getAttString('AuthenticationResult.IdToken'),
  },
  body: JSON.stringify({
    repo: 'aws-samples/sample-autonomous-cloud-coding-agents',
    task_description: 'integ smoke: create-and-persist only, no agent run',
    max_turns: 1,
  }),
});

// GET /tasks/{id} returns the persisted record via the API.
const getTask = integ.assertions.httpApiCall(
  `${stack.taskApi.api.url}tasks/${createTask.getAttString('body.data.task_id')}`,
  {
    method: 'GET',
    headers: { Authorization: auth.getAttString('AuthenticationResult.IdToken') },
  },
);
getTask.expect(
  ExpectedResult.objectLike({
    status: 200,
    body: { data: { status: TaskStatus.SUBMITTED } },
  }),
);

// Verify the user_id linkage directly in DynamoDB — the API's TaskDetail
// response intentionally omits user_id, so assert it at the source. The value
// is the Cognito sub (unknown at synth time).
//
// The `.+` regex only confirms user_id persisted as a NON-EMPTY string; it does
// not (and cannot, at synth time) check that the value equals this caller's sub.
// The real identity binding is proven transitively by the chain above: the
// authenticated GET /tasks/{id} returns 200 for the same task_id the POST
// created, which means the row was written under, and is readable by, the token
// we minted. This getItem just guards against a regression that writes a blank
// or missing user_id.
const getItem = integ.assertions.awsApiCall('DynamoDB', 'getItem', {
  TableName: stack.taskTable.table.tableName,
  Key: { task_id: { S: createTask.getAttString('body.data.task_id') } },
});
getItem.assertAtPath('Item.user_id.S', ExpectedResult.stringLikeRegexp('.+'));

// Negative path: an unauthenticated POST /tasks must be rejected by the API's
// Cognito authorizer (401) before any record is created. No getAttString is
// read off this call, so flattenResponse stays false and the inline .expect()
// works against the nested apiCallResponse.
const unauthPost = integ.assertions.httpApiCall(`${stack.taskApi.api.url}tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    repo: 'aws-samples/sample-autonomous-cloud-coding-agents',
    task_description: 'this request should be rejected (no auth)',
    max_turns: 1,
  }),
});
unauthPost.expect(ExpectedResult.objectLike({ status: 401 }));

// Chain the calls so they execute in order: create user → set password → auth →
// POST → GET → DynamoDB read → unauthenticated POST (must 401).
createUser.next(setPassword).next(auth).next(createTask).next(getTask).next(getItem).next(unauthPost);
