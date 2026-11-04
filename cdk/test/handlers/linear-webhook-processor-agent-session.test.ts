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

// Processor routing for AgentSessionEvent deliveries (ADR-018 Phase 2). The
// session behaviour itself is covered in linear-agent-session-handler.test.ts.

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  GetCommand: jest.fn(),
  UpdateCommand: jest.fn(),
}));

const handleAgentSessionEventMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-agent-session-handler', () => ({
  handleAgentSessionEvent: (...args: unknown[]) => handleAgentSessionEventMock(...args),
}));

const resolveSoleActiveLinearWorkspaceMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: jest.fn(),
  resolveSoleActiveLinearWorkspace: (...args: unknown[]) => resolveSoleActiveLinearWorkspaceMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

import { handler } from '../../src/handlers/linear-webhook-processor';

const SESSION_EVENT = {
  type: 'AgentSessionEvent',
  action: 'created',
  organizationId: 'org-claimed',
  agentSession: { id: 'session-1', issueId: 'issue-1' },
};

beforeEach(() => {
  handleAgentSessionEventMock.mockReset().mockResolvedValue(undefined);
  resolveSoleActiveLinearWorkspaceMock.mockReset();
});
afterEach(() => {
  delete process.env.LINEAR_AGENT_SESSIONS_ENABLED;
});

test('flag on: an AgentSessionEvent is handed to the session handler', async () => {
  process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
  await handler({ raw_body: JSON.stringify(SESSION_EVENT) });
  expect(handleAgentSessionEventMock).toHaveBeenCalledWith(SESSION_EVENT);
});

test('flag off: a misrouted AgentSessionEvent is dropped', async () => {
  await handler({ raw_body: JSON.stringify(SESSION_EVENT) });
  expect(handleAgentSessionEventMock).not.toHaveBeenCalled();
});

test('stack-wide verification binds the workspace before the session handler sees it', async () => {
  process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
  resolveSoleActiveLinearWorkspaceMock.mockResolvedValue('org-bound');
  await handler({ raw_body: JSON.stringify(SESSION_EVENT), verified_via_stack_wide: true });
  expect(handleAgentSessionEventMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-bound' }));
});

test('stack-wide verification with no sole workspace drops the delivery', async () => {
  process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
  resolveSoleActiveLinearWorkspaceMock.mockResolvedValue(null);
  await handler({ raw_body: JSON.stringify(SESSION_EVENT), verified_via_stack_wide: true });
  expect(handleAgentSessionEventMock).not.toHaveBeenCalled();
});
