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

import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { makeLinearCommand } from '../../src/commands/linear';
import * as config from '../../src/config';

const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => ({
  ...jest.requireActual('@aws-sdk/client-cloudformation'),
  CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  ...jest.requireActual('@aws-sdk/client-secrets-manager'),
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
}));

const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ...jest.requireActual('@aws-sdk/lib-dynamodb'),
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
}));

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ACME = 'c0000000-0000-4000-8000-0000000ac0e1';
const ORG_GIVEN = 'c0000000-0000-4000-8000-0000000b10a2';

function linearAnswers(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('linear onboard-project command', () => {
  let loadConfigSpy: jest.SpiedFunction<typeof config.loadConfig>;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'LinearProjectMappingTableName', OutputValue: 'project-mapping-table' },
          { OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' },
        ],
      }],
    });
    ddbSend.mockReset().mockImplementation(async (command: unknown) => (
      command instanceof ScanCommand
        ? { Items: [{ workspace_slug: 'acme', linear_workspace_id: ORG_ACME, status: 'active' }] }
        : {}
    ));
    smSend.mockReset().mockImplementation(async (command: unknown) => {
      if (command instanceof GetSecretValueCommand) return { SecretString: JSON.stringify({ access_token: 'tok-acme' }) };
      throw new Error('unexpected Secrets Manager command');
    });
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () => linearAnswers({ organization: { id: ORG_ACME }, project: { id: PROJECT } }),
    );
    loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-east-1' } as ReturnType<typeof config.loadConfig>);
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    loadConfigSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const run = (...args: string[]) => makeLinearCommand().parseAsync(['node', 'test', 'onboard-project', ...args]);
  const puts = () => ddbSend.mock.calls
    .map(([command]) => command as unknown)
    .filter((command): command is PutCommand => command instanceof PutCommand)
    .map((command) => command.input);
  const printed = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  test('records the workspace that Linear says owns the project', async () => {
    await run(PROJECT, '--repo', 'acme/widgets');

    expect(puts()).toEqual([{
      TableName: 'project-mapping-table',
      Item: {
        linear_project_id: PROJECT,
        linear_workspace_id: ORG_ACME,
        repo: 'acme/widgets',
        label_filter: 'bgagent',
        status: 'active',
        onboarded_at: expect.any(String),
        updated_at: expect.any(String),
      },
    }]);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.linear.app/graphql', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer tok-acme' }),
    }));
    expect(printed()).toContain(`Owning workspace: acme (${ORG_ACME})`);
  });

  test('writes nothing when no onboarded workspace can see the project', async () => {
    fetchSpy.mockImplementation(async () => linearAnswers({ organization: { id: ORG_ACME }, project: null }));

    await expect(run(PROJECT, '--repo', 'acme/widgets')).rejects.toThrow('process.exit:1');

    expect(puts()).toEqual([]);
    expect(errors()).toContain(`Could not determine which workspace owns project ${PROJECT}.`);
    expect(errors()).toContain('Searched: acme');
  });

  test('--workspace-id records the given owner without asking Linear', async () => {
    await run(PROJECT, '--repo', 'acme/widgets', '--workspace-id', ORG_GIVEN, '--label', 'abca', '--team-id', 'team-1');

    expect(puts()).toEqual([{
      TableName: 'project-mapping-table',
      Item: expect.objectContaining({
        linear_project_id: PROJECT,
        linear_workspace_id: ORG_GIVEN,
        repo: 'acme/widgets',
        label_filter: 'abca',
        team_id: 'team-1',
      }),
    }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed()).toContain(`Owning workspace: ${ORG_GIVEN} (from --workspace-id, not verified with Linear)`);
  });

  test('a second run keeps the first onboarded_at and moves updated_at', async () => {
    let row: Record<string, unknown> | undefined;
    ddbSend.mockImplementation(async (command: unknown) => {
      if (command instanceof PutCommand) {
        row = command.input.Item;
        return {};
      }
      return command instanceof ScanCommand
        ? { Items: [{ workspace_slug: 'acme', linear_workspace_id: ORG_ACME, status: 'active' }] }
        : { Item: row };
    });
    jest.useFakeTimers({
      now: new Date('2026-01-02T03:04:05.000Z'),
      doNotFake: [
        'nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'hrtime', 'performance',
      ],
    });
    try {
      await run(PROJECT, '--repo', 'acme/widgets');
      expect(row).toMatchObject({
        onboarded_at: '2026-01-02T03:04:05.000Z',
        updated_at: '2026-01-02T03:04:05.000Z',
      });

      jest.setSystemTime(new Date('2026-02-03T04:05:06.000Z'));
      await run(PROJECT, '--repo', 'acme/gadgets', '--label', 'abca');
    } finally {
      jest.useRealTimers();
    }

    expect(row).toEqual({
      linear_project_id: PROJECT,
      linear_workspace_id: ORG_ACME,
      repo: 'acme/gadgets',
      label_filter: 'abca',
      status: 'active',
      onboarded_at: '2026-01-02T03:04:05.000Z',
      updated_at: '2026-02-03T04:05:06.000Z',
    });
    const reads = ddbSend.mock.calls
      .map(([command]) => command as unknown)
      .filter((command): command is GetCommand => command instanceof GetCommand)
      .map((command) => command.input);
    const read = { TableName: 'project-mapping-table', Key: { linear_project_id: PROJECT }, ConsistentRead: true };
    expect(reads).toEqual([read, read]);
  });

  test('stops with the AWS error, before writing, when the mapping row cannot be read', async () => {
    ddbSend.mockRejectedValueOnce(Object.assign(
      new Error('User is not authorized to perform: dynamodb:GetItem'),
      { name: 'AccessDeniedException' },
    ));

    await expect(run(PROJECT, '--repo', 'acme/widgets', '--workspace-id', ORG_GIVEN))
      .rejects.toThrow('not authorized to perform: dynamodb:GetItem');

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  test.each([
    [
      'a --workspace-id that is not a UUID',
      [PROJECT, '--repo', 'acme/widgets', '--workspace-id', 'not-a-uuid'],
      'Invalid --workspace-id value: not-a-uuid. Expected a UUID.',
    ],
    [
      'the truncated project id of a Linear URL',
      ['a680cae8704c', '--repo', 'acme/widgets'],
      'Invalid Linear project UUID: a680cae8704c',
    ],
    [
      'a --repo that is not owner/repo',
      [PROJECT, '--repo', 'widgets'],
      'Invalid --repo value: widgets. Expected owner/repo.',
    ],
  ])('exits before any write on %s', async (_what, args, message) => {
    await expect(run(...args)).rejects.toThrow('process.exit:1');

    expect(errors()).toContain(message);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('exits before any write when the stack has no project mapping table', async () => {
    cfnSend.mockResolvedValue({ Stacks: [{ Outputs: [] }] });

    await expect(run(PROJECT, '--repo', 'acme/widgets')).rejects.toThrow('process.exit:1');

    expect(errors()).toContain('Could not find LinearProjectMappingTableName in stack outputs. Deploy the stack first.');
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
