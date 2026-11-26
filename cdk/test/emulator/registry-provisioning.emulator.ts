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

import { randomUUID } from 'node:crypto';
import { AgentRegistryControlClient, DeleteRegistryCommand, GetRegistryCommand } from '@aws-sdk/client-agent-registry-control';
import { isComplete, onEvent } from '../../src/handlers/registry-provisioning/index';
import { handler as publish } from '../../src/handlers/registry-publish';
import { makeClient } from '../../src/handlers/shared/ua';
import { apiEvent } from './harness';

const POLL_MS = 100;
const MAX_POLLS = 50;
const TEST_TIMEOUT_MS = 30_000;

const run = randomUUID().slice(0, 8);
const properties = { RegistryName: `emu_${run}_registry`, Description: 'registry-provisioning.emulator.ts' };

const registry = makeClient(AgentRegistryControlClient);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function complete(event: Parameters<typeof isComplete>[0]): Promise<void> {
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    if ((await isComplete(event)).IsComplete) return;
    await pause(POLL_MS);
  }
  throw new Error(`${event.RequestType} was not complete after ${MAX_POLLS} polls`);
}

async function publishAsset(asset: { kind: string; name: string; discovery: object; runtime: object }): Promise<void> {
  const event = apiEvent(`user-${randomUUID()}`, {
    httpMethod: 'POST',
    body: JSON.stringify({ ...asset, namespace: 'acme', asset_version: '1.0.0', auto_approve: true }),
  });
  event.requestContext.authorizer!.claims['cognito:groups'] = 'RegistryPublisher,RegistryApprover';
  const result = await publish(event);
  expect(JSON.parse(result.body)).toMatchObject({ data: { name: asset.name, status: 'APPROVED' } });
}

describe('agent registry custom resource against the AWS Emulator', () => {
  afterAll(() => registry.destroy());

  test('Delete removes a registry that holds published assets', async () => {
    const created = await onEvent({ RequestType: 'Create', RequestId: randomUUID(), ResourceProperties: properties });
    const registryId = created.PhysicalResourceId!;
    await complete({ RequestType: 'Create', PhysicalResourceId: registryId, ResourceProperties: properties });

    process.env.AGENT_REGISTRY_ID = registryId;
    await publishAsset({
      kind: 'mcp_server',
      name: 'pdf-tools',
      discovery: { name: 'io.example/pdf-tools', description: 'PDF tools', version: '1.0.0' },
      runtime: { transport: 'http', url: 'https://example.com/mcp' },
    });
    await publishAsset({
      kind: 'cedar_policy_module',
      name: 'guard',
      discovery: {},
      runtime: { cedar_text: 'permit(principal, action, resource);' },
    });

    await expect(registry.send(new DeleteRegistryCommand({ registryId }))).rejects.toMatchObject({ name: 'ConflictException' });

    const deletion = { RequestType: 'Delete' as const, PhysicalResourceId: registryId, ResourceProperties: properties };
    await onEvent(deletion);
    await complete(deletion);

    await expect(registry.send(new GetRegistryCommand({ registryId }))).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
  }, TEST_TIMEOUT_MS);
});
