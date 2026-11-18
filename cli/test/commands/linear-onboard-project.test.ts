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

// `bgagent linear onboard-project`, run as a command. It writes the project mapping, and the
// value that matters in that row is the owning workspace: the webhook path checks the project
// of a delivery against it, and lets a mapping without one through with a warning only.
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { makeLinearCommand } from '../../src/commands/linear';
import * as config from '../../src/config';

// CloudFormation — the mapping table and the workspace registry are read from stack outputs.
const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => ({
  ...jest.requireActual('@aws-sdk/client-cloudformation'),
  CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
}));

// Secrets Manager — holds the token of the workspace that is asked about the project.
const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  ...jest.requireActual('@aws-sdk/client-secrets-manager'),
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
}));

// DynamoDB — the registry is scanned for workspaces, the mapping is written with a Put.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ...jest.requireActual('@aws-sdk/lib-dynamodb'),
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
}));

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Hex letters in the last group on purpose: twelve digits there read as an AWS account id
// to the secret scan.
const ORG_ACME = 'c0000000-0000-4000-8000-0000000ac0e1';
const ORG_GIVEN = 'c0000000-0000-4000-8000-0000000b10a2';

/** What Linear answers to the owner query: HTTP 200 with `data`. */
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
    // One onboarded workspace, on Secrets Manager (its row names no vault provider).
    ddbSend.mockReset().mockImplementation(async (command: unknown) => (
      command instanceof ScanCommand
        ? { Items: [{ workspace_slug: 'acme', linear_workspace_id: ORG_ACME, status: 'active' }] }
        : {}
    ));
    smSend.mockReset().mockImplementation(async (command: unknown) => {
      if (command instanceof GetSecretValueCommand) return { SecretString: JSON.stringify({ access_token: 'tok-acme' }) };
      throw new Error('unexpected Secrets Manager command');
    });
    // Linear, asked with that workspace's token: the project is one of its own.
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () => linearAnswers({ organization: { id: ORG_ACME }, project: { id: PROJECT } }),
    );
    loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-east-1' } as ReturnType<typeof config.loadConfig>);
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Make process.exit throw, so that the command stops there as it does in the CLI.
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
    // Asked with the token of the workspace it then names as the owner.
    expect(fetchSpy).toHaveBeenCalledWith('https://api.linear.app/graphql', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer tok-acme' }),
    }));
    expect(printed()).toContain(`Owning workspace: acme (${ORG_ACME})`);
  });

  test('writes nothing when no onboarded workspace can see the project', async () => {
    // `project: null` with a 200 is how Linear says "not one of this workspace's projects".
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
