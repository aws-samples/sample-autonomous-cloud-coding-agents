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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME = 'SlackChannelMap';

import { validateAttachments } from '../../src/handlers/shared/validation';
import { handler, type MentionEvent, type SlashCommandEvent } from '../../src/handlers/slack-command-processor';

function mention(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    source: 'mention',
    text: 'submit org/repo fix the bug',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    mention_thread_ts: '1000.0001',
    ...overrides,
  };
}

function slashCommand(overrides: Partial<SlashCommandEvent> = {}): SlashCommandEvent {
  return {
    source: 'slash',
    text: 'help',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    command: '/bgagent',
    user_name: 'u',
    team_domain: 'acme',
    channel_name: 'general',
    trigger_id: 'T.1',
    response_url: 'https://hooks.slack.com/cmd/X',
    ...overrides,
  };
}

function slackCalls(method: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === `https://slack.com/api/${method}`)
    .map(([, opts]) => JSON.parse((opts as { body: string }).body));
}

function isSlackHooksRequestUrl(url: unknown): boolean {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

describe('slack-command-processor handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    createTaskCoreMock.mockReset();
    smSend.mockResolvedValue({ SecretString: 'xoxb-bot' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  test('slash command without source flag defaults to slash and falls through to default branch', async () => {
    const legacy = {
      command: '/bgagent',
      text: 'unknown_sub',
      user_id: 'U1',
      team_id: 'T1',
      channel_id: 'C1',
      user_name: '',
      team_domain: '',
      channel_name: '',
      trigger_id: '',
      response_url: 'https://hooks.slack.com/cmd/X',
    };
    await handler(legacy);
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('Use `@Shoof`'),
    );
    expect(posted).toBeTruthy();
  });

  test('slash submit tells user to use @mention', async () => {
    await handler(slashCommand({ text: 'submit org/repo fix' }));
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('Use `@Shoof` to submit tasks'),
    );
    expect(posted).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit requires linked account (prompts /bgagent link)', async () => {
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('not linked'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo and no channel default replies with guidance', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit not-a-repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo falls back to channel default and uses full text as description', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repo: 'org/defaultrepo' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/defaultrepo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit fix the spacing on the header' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/defaultrepo');
    expect(reqBody.issue_number).toBeUndefined();
    expect(reqBody.task_description).toBe('fix the spacing on the header');
  });

  test('mention submit with no repo fails open when the channel lookup throws', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockRejectedValueOnce(new Error('ddb blip'));
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit fix the bug' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
  });

  test('mention submit creates task via createTaskCore', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'TASK123', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo#42 add validation' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/repo');
    expect(reqBody.issue_number).toBe(42);
    expect(reqBody.task_description).toBe('add validation');
    expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
    expect(ctx.channelSource).toBe('slack');
    expect(ctx.userId).toBe('cognito-1');
    expect(ctx.channelMetadata.slack_thread_ts).toBe('1000.0001');
  });

  test('mention submit in private channel bot is not in — replies with invite hint', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('private channel'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a refusal because the bot cannot post in the channel swaps :eyes: for :x: too', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'missing_scope' }),
    });

    await handler(mention({ text: 'submit org/repo fix' }));

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(slackCalls('chat.postMessage')).toEqual([
      expect.objectContaining({ text: expect.stringContaining('private channel') }),
    ]);
    expect(slackCalls('reactions.remove')).toEqual([{ channel: 'C1', timestamp: '1000.0001', name: 'eyes' }]);
    expect(slackCalls('reactions.add')).toEqual([{ channel: 'C1', timestamp: '1000.0001', name: 'x' }]);
  });

  test('mention submit fails open on transient Slack errors (ratelimited, internal_error)', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  describe('a mention written as a reply inside a thread', () => {
    const threadReply = { text: 'submit org/repo fix', mention_thread_ts: '100.0001', mention_message_ts: '200.0002' };

    test('stores its own ts next to the thread ts, for the reactions of the task', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/repo', status: 'SUBMITTED' } }),
      });

      await handler(mention(threadReply));

      const [, ctx] = createTaskCoreMock.mock.calls[0];
      expect(ctx.channelMetadata).toEqual({
        slack_team_id: 'T1',
        slack_channel_id: 'C1',
        slack_user_id: 'U1',
        slack_thread_ts: '100.0001',
        slack_message_ts: '200.0002',
      });
    });

    test('gets the :x: itself when the request fails, with the answer in its thread', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });

      await handler(mention(threadReply));

      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ thread_ts: '100.0001', text: expect.stringContaining('not linked') }),
      ]);
      expect(slackCalls('reactions.remove')).toEqual([{ channel: 'C1', timestamp: '200.0002', name: 'eyes' }]);
      expect(slackCalls('reactions.add')).toEqual([{ channel: 'C1', timestamp: '200.0002', name: 'x' }]);
    });
  });

  test('an unexpected error swaps :eyes: for :x: on the mention', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockRejectedValueOnce(new Error('throttled'));

    await handler(mention({ text: 'submit org/repo fix' }));

    expect(slackCalls('chat.postMessage')).toEqual([
      expect.objectContaining({ text: expect.stringContaining('Something went wrong') }),
    ]);
    expect(slackCalls('reactions.remove')).toEqual([{ channel: 'C1', timestamp: '1000.0001', name: 'eyes' }]);
    expect(slackCalls('reactions.add')).toEqual([{ channel: 'C1', timestamp: '1000.0001', name: 'x' }]);
  });

  test('a reaction swap that fails after an unexpected error does not fail the invocation', async () => {
    // Lambda retries an asynchronous invocation whose handler throws.
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } })
      .mockResolvedValueOnce({ Item: { status: 'active' } })
      .mockResolvedValueOnce({ Item: { status: 'active' } })
      .mockRejectedValueOnce(new Error('ddb throttle'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockRejectedValueOnce(new Error('throttled'));

    await expect(handler(mention({ text: 'submit org/repo fix' }))).resolves.toBeUndefined();

    expect(slackCalls('chat.postMessage')).toHaveLength(1);
    expect(ddbSend).toHaveBeenCalledTimes(4);
  });

  test('link subcommand persists pending mapping with a link code', async () => {
    ddbSend.mockResolvedValueOnce({});
    await handler(slashCommand({ text: 'link' }));
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.slack_identity).toMatch(/^pending#/);
    expect(putCall![0].input.Item.status).toBe('pending');
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(putCall![0].input.Item.ttl).toBeGreaterThan(nowSeconds);
    expect(putCall![0].input.Item.ttl).toBeLessThanOrEqual(nowSeconds + 600);
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('bgagent slack link'),
    );
    expect(posted).toBeTruthy();
  });

  test('help subcommand replies with usage text', async () => {
    await handler(slashCommand({ text: 'help' }));
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('Using Shoof'),
    );
    expect(posted).toBeTruthy();
  });

  describe('repo and description of a mention', () => {
    function givenTables(onboarded: string[], channelDefault?: string): void {
      ddbSend.mockImplementation((cmd: { input: { TableName: string; Key: Record<string, string> } }) => {
        const { TableName, Key } = cmd.input;
        if (TableName === 'SlackMap') return Promise.resolve({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
        if (TableName === 'SlackChannelMap') return Promise.resolve({ Item: channelDefault ? { status: 'active', repo: channelDefault } : undefined });
        if (TableName === 'Repos') return Promise.resolve({ Item: onboarded.includes(Key.repo) ? { repo: Key.repo, status: 'active' } : undefined });
        return Promise.resolve({ Item: { status: 'active' } });
      });
    }

    function givenNotOnboardedAnswer(): void {
      createTaskCoreMock.mockResolvedValue({
        statusCode: 422,
        body: JSON.stringify({ error: { code: 'REPO_NOT_ONBOARDED', message: 'Repository is not onboarded.' } }),
      });
    }

    function repoLookups(): string[] {
      return ddbSend.mock.calls.filter(([cmd]) => cmd.input.TableName === 'Repos').map(([cmd]) => cmd.input.Key.repo);
    }

    function submitted(): unknown[] {
      return createTaskCoreMock.mock.calls.map(([body]) => ({
        repo: body.repo,
        issue_number: body.issue_number,
        task_description: body.task_description,
      }));
    }

    beforeEach(() => {
      process.env.REPO_TABLE_NAME = 'Repos';
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
      createTaskCoreMock.mockResolvedValue({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
    });

    afterEach(() => {
      delete process.env.REPO_TABLE_NAME;
    });

    test('an onboarded repo is the repo wherever it stands, also behind other slash words', async () => {
      givenTables(['acme/api']);

      await handler(mention({ text: 'submit make the client/server handshake and the client/server docs agree in acme/api' }));

      expect(submitted()).toEqual([{
        repo: 'acme/api',
        issue_number: undefined,
        task_description: 'make the client/server handshake and the client/server docs agree in',
      }]);
      expect(repoLookups()).toEqual(['client/server', 'acme/api']);
    });

    test('a repo with an issue number is the repo wherever it stands, also behind other slash words', async () => {
      givenTables(['acme/api']);

      await handler(mention({ text: 'submit make the client/server handshake retry in acme/api#7' }));

      expect(submitted()).toEqual([{
        repo: 'acme/api',
        issue_number: 7,
        task_description: 'make the client/server handshake retry in',
      }]);
    });

    test('a repo is read from its first letter, also right behind a hyphen', async () => {
      givenTables(['acme/api']);

      await handler(mention({ text: 'submit bump the SDK in\n-acme/api' }));

      expect(submitted()).toEqual([{ repo: 'acme/api', issue_number: undefined, task_description: 'bump the SDK in\n-' }]);
    });

    test.each([
      ['dot-joined letters', `${'a.'.repeat(30_000)}/`],
      ['dots', '.'.repeat(60_000)],
      ['blanks between two words in front of the repo', `a${' \t'.repeat(30_000)}b acme/api`],
    ])('reads 60,000 characters of %s in under half a second', async (_what, message) => {
      givenTables(['acme/api'], 'acme/api');

      const started = Date.now();
      await handler(mention({ text: `submit ${message}` }));

      expect(Date.now() - started).toBeLessThan(500);
      expect(createTaskCoreMock.mock.calls.map(([body]) => body.repo)).toEqual(['acme/api']);
    });

    test.each([
      'fix the CI/CD pipeline',
      'add a yes/no prompt',
      'bump node to 22 and/or 24',
      'support 24/7 mode',
      'src/handlers/foo.ts throws on empty input',
      'update the README in other/web',
    ])('a slash word that is no onboarded repo leaves the channel default in charge of the whole message: %s', async (message) => {
      givenTables(['acme/api'], 'acme/api');

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([{ repo: 'acme/api', issue_number: undefined, task_description: message }]);
    });

    test.each([
      ['with an issue number', 'fix other/web#7 the way acme/api does it', { repo: 'other/web', issue_number: 7, task_description: 'fix the way acme/api does it' }],
      ['of the same owner', 'update acme/web like acme/api', { repo: 'acme/web', issue_number: undefined, task_description: 'update like acme/api' }],
      ['given as a link', 'fix <https://github.com/other/web> the way acme/api does it', { repo: 'other/web', issue_number: undefined, task_description: 'fix the way acme/api does it' }],
    ])('a repo %s that is not onboarded is not passed over for an onboarded repo behind it', async (_what, message, expected) => {
      givenTables(['acme/api']);
      givenNotOnboardedAnswer();

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([expected]);
    });

    test.each([
      ['a repo with an issue number', 'fix the bug in other/web#42', { repo: 'other/web', issue_number: 42, task_description: 'fix the bug in' }],
      ["a repo of the default's owner", 'update the README in Acme/web', { repo: 'Acme/web', issue_number: undefined, task_description: 'update the README in' }],
      ['a repo with an issue number under the name of a page of GitHub', 'fix the build in apps/web#42', { repo: 'apps/web', issue_number: 42, task_description: 'fix the build in' }],
      ['a repo with an issue number behind a slash word that ends in a full stop', 'compare lib/utils./other/web#5', { repo: 'other/web', issue_number: 5, task_description: 'compare lib/utils./' }],
    ])('%s that is not onboarded is not replaced by the channel default', async (_what, message, expected) => {
      givenTables(['acme/api'], 'acme/api');
      givenNotOnboardedAnswer();

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([expected]);
      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ text: ':x: Failed to create task: Repository is not onboarded.' }),
      ]);
    });

    test('without a channel default the first slash word is still named as the repo', async () => {
      givenTables(['acme/api']);
      givenNotOnboardedAnswer();

      await handler(mention({ text: 'submit fix the CI/CD pipeline' }));

      expect(submitted()).toEqual([{ repo: 'CI/CD', issue_number: undefined, task_description: 'fix the pipeline' }]);
    });

    const LINKED_ISSUE = { repo: 'aws-samples/sample-interview-assistant-serverless', issue_number: 24, task_description: 'fix' };

    test.each([
      ['an issue link as Slack delivers it', 'fix <https://github.com/aws-samples/sample-interview-assistant-serverless/issues/24>', LINKED_ISSUE],
      ['an issue link as typed', 'fix https://github.com/aws-samples/sample-interview-assistant-serverless/issues/24', LINKED_ISSUE],
      ['the short form', 'fix aws-samples/sample-interview-assistant-serverless#24', LINKED_ISSUE],
      ['an issue link as typed, with text after it', 'fix https://github.com/other/web/issues/7 before the release', { repo: 'other/web', issue_number: 7, task_description: 'fix before the release' }],
      ['a pull request link', 'review <https://github.com/other/web/pull/7> again', { repo: 'other/web', issue_number: 7, task_description: 'review again' }],
      ['a link into a pull request', 'fix <https://github.com/other/web/pull/7/files#diff-0> too', { repo: 'other/web', issue_number: 7, task_description: 'fix too' }],
      ['a repo link', 'update the README in <https://github.com/other/web>', { repo: 'other/web', issue_number: undefined, task_description: 'update the README in' }],
      // Slack makes a link of an address typed without "https://" and keeps the typed text as its label.
      ['a repo link with a label', 'update the README in <http://github.com/other/web|github.com/other/web>', { repo: 'other/web', issue_number: undefined, task_description: 'update the README in' }],
      ['a repo link with www, a closing slash and a query', '<https://www.github.com/other/web/?tab=readme-ov-file> needs a license', { repo: 'other/web', issue_number: undefined, task_description: 'needs a license' }],
      ['a repo link with a fragment', 'follow <https://github.com/other/web#readme> to the letter', { repo: 'other/web', issue_number: undefined, task_description: 'follow to the letter' }],
      ['a clone address', 'update the README in <https://github.com/other/web.git>', { repo: 'other/web', issue_number: undefined, task_description: 'update the README in' }],
      ['a link to a repo whose name ends in git', 'update the README in <https://github.com/other/web-git>', { repo: 'other/web-git', issue_number: undefined, task_description: 'update the README in' }],
      ['a link written in capitals', 'fix <HTTPS://GITHUB.COM/other/web/issues/7>', { repo: 'other/web', issue_number: 7, task_description: 'fix' }],
      ['an issue link with a label', 'fix <https://github.com/other/web/issues/7|the login timeout> before Friday', { repo: 'other/web', issue_number: 7, task_description: 'fix before Friday' }],
      ['a repo link as typed, with a comma behind it', 'see https://github.com/other/web, then fix', { repo: 'other/web', issue_number: undefined, task_description: 'see, then fix' }],
      ['a link to a repo named like a page of GitHub', 'fix <https://github.com/settings-sync/settings>', { repo: 'settings-sync/settings', issue_number: undefined, task_description: 'fix' }],
    ])('%s names its repo, onboarded or not, and its issue number', async (_what, message, expected) => {
      givenTables(['acme/api'], 'acme/api');
      givenNotOnboardedAnswer();

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([expected]);
      expect(repoLookups()).toEqual([]);
    });

    test.each(['.', ',', ';', ':', '!', '?', ')'])('a typed link ends before a "%s" behind it, which stays in the description', async (mark) => {
      givenTables(['acme/api'], 'acme/api');
      givenNotOnboardedAnswer();

      await handler(mention({ text: `submit fix https://github.com/other/web${mark}` }));

      expect(submitted()).toEqual([{ repo: 'other/web', issue_number: undefined, task_description: `fix${mark}` }]);
    });

    test('an onboarded repo named before a link is the repo, and the link stays in the description', async () => {
      givenTables(['acme/api']);

      await handler(mention({ text: 'submit in acme/api do what <https://github.com/other/web/pull/9> did' }));

      expect(submitted()).toEqual([{
        repo: 'acme/api',
        issue_number: undefined,
        task_description: 'in do what <https://github.com/other/web/pull/9> did',
      }]);
    });

    test.each([
      'fix what <https://example.com/teams/acme/board> describes',
      'fix what https://example.com/teams/acme/board describes',
      'fix the typo in <https://github.com/acme/acme/blob/main/README.md>',
      'apply <https://gist.github.com/acme/notes> to the config',
      'fix what <https://example.com/go?to=https://github.com/other/web/issues/3> says',
      'rotate the token, see <https://github.com/settings/tokens>',
      '<https://github.com/orgs/acme>',
      '<https://github.com/pulls/assigned>',
      'rotate the token, see <https://github.com/Settings/Tokens>',
      'fix <https://github.com/orgs/acme/issues/5>',
    ])('a link that names no repo leaves the channel default in charge of the whole message: %s', async (message) => {
      givenTables(['acme/api'], 'acme/api');

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([{ repo: 'acme/api', issue_number: undefined, task_description: message }]);
    });

    test('without a channel default a link that names no repo is not taken for one', async () => {
      givenTables(['acme/api']);

      await handler(mention({ text: 'submit fix what <https://example.com/reports/latest> says' }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ text: expect.stringContaining('Please include a repo') }),
      ]);
    });

    const DIFF = '```\n- timeout: 30\n+   timeout: 60\n```';

    test.each([
      ['after the repo', `acme/api apply this change:\n${DIFF}`, `apply this change:\n${DIFF}`],
      ['around a repo in the middle', `in acme/api apply this change:\n${DIFF}`, `in apply this change:\n${DIFF}`],
      ['before a repo at the end', `apply this change:\n${DIFF}\nin acme/api`, `apply this change:\n${DIFF}\nin`],
      ['before a repo that starts a line', `apply this change:\n${DIFF}\nacme/api: that is the repo`, `apply this change:\n${DIFF}\n: that is the repo`],
      ['before a repo behind a tab and a blank, which go with it', 'apply this change:  \n\t acme/api: that is the repo', 'apply this change:  \n: that is the repo'],
    ])('the description keeps line breaks and indentation %s', async (_where, message, description) => {
      givenTables(['acme/api']);

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([{ repo: 'acme/api', issue_number: undefined, task_description: description }]);
    });

    test('the description keeps line breaks and indentation on the channel default', async () => {
      givenTables(['acme/api'], 'acme/api');

      await handler(mention({ text: `submit apply this change:\n${DIFF}` }));

      expect(submitted()).toEqual([{ repo: 'acme/api', issue_number: undefined, task_description: `apply this change:\n${DIFF}` }]);
    });
  });

  describe('file attachments', () => {
    beforeEach(() => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
    });

    test('downloads Slack files and passes as inline attachments', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from('file content')),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });

      await handler(mention({
        text: 'submit org/repo fix the bug',
        files: [{
          id: 'F1',
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/screenshot.png',
        }],
      }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(1);
      expect(reqBody.attachments[0].type).toBe('image');
      expect(reqBody.attachments[0].content_type).toBe('image/png');
      expect(reqBody.attachments[0].filename).toBe('screenshot.png');
      expect(reqBody.attachments[0].data).toBe(Buffer.from('file content').toString('base64'));
    });

    test('rejects files with unsupported MIME types', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [{
          id: 'F1',
          name: 'virus.exe',
          mimetype: 'application/x-executable',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/virus.exe',
        }],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('unsupported type'),
      );
      expect(reply).toBeTruthy();
    });

    function png(size: number): Buffer {
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8)]);
    }

    async function submitPngs(sizes: number[], declared: number[] = sizes): Promise<void> {
      fetchMock.mockImplementation((url: string) => {
        const file = /^https:\/\/files\.slack\.com\/files\/F(\d+)\//.exec(url);
        return Promise.resolve(file
          ? { ok: true, arrayBuffer: () => Promise.resolve(png(sizes[Number(file[1])])) }
          : { ok: true, json: () => Promise.resolve({ ok: true }) });
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
      await handler(mention({
        text: 'submit org/repo fix',
        files: declared.map((size, i) => ({
          id: `F${i}`,
          name: `shot${i}.png`,
          mimetype: 'image/png',
          size,
          url_private_download: `https://files.slack.com/files/F${i}/shot${i}.png`,
        })),
      }));
    }

    function downloads(): unknown[] {
      return fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://files.slack.com/'));
    }

    test('refuses a file over the 500 KB inline limit before downloading it', async () => {
      await submitPngs([600 * 1024]);

      expect(downloads()).toHaveLength(0);
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ text: expect.stringContaining('`shot0.png` (too large, 600 KB > 500 KB limit)') }),
      ]);
    });

    test('refuses a file that turns out larger than Slack declared', async () => {
      await submitPngs([600 * 1024], [0]);

      expect(downloads()).toHaveLength(1);
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ text: expect.stringContaining('`shot0.png` (too large, 600 KB > 500 KB limit)') }),
      ]);
    });

    test('refuses files over the 3 MB inline total, without downloading the one that exceeds it', async () => {
      await submitPngs(Array<number>(7).fill(480 * 1024));

      expect(downloads()).toHaveLength(6);
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ text: expect.stringContaining('`shot6.png` (more than 3 MB of attachments in total)') }),
      ]);
    });

    test.each([
      ['a file of exactly 500 KB', [500 * 1024], true],
      ['a file of 500 KB and one byte', [500 * 1024 + 1], false],
      ['files of exactly 3 MB together', [...Array<number>(6).fill(500 * 1024), 3 * 1024 * 1024 - 6 * 500 * 1024], true],
      ['files of 3 MB and one byte together', [...Array<number>(6).fill(500 * 1024), 3 * 1024 * 1024 - 6 * 500 * 1024 + 1], false],
    ])('%s: handed over exactly when validateAttachments takes it', async (_what, sizes, accepted) => {
      await submitPngs(sizes);

      const inline = sizes.map((size, i) => ({
        type: 'image',
        content_type: 'image/png',
        filename: `shot${i}.png`,
        data: png(size).toString('base64'),
      }));
      expect(validateAttachments(inline).valid).toBe(accepted);
      const handedOver = createTaskCoreMock.mock.calls.map(
        ([reqBody]) => (reqBody.attachments as Array<{ data: string }>).map(att => Buffer.from(att.data, 'base64').length),
      );
      expect(handedOver).toEqual(accepted ? [sizes] : []);
    });

    test('reports all file errors atomically', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [
          { id: 'F1', name: 'big.png', mimetype: 'image/png', size: 11 * 1024 * 1024, url_private_download: 'https://files.slack.com/files/F1/big.png' },
          { id: 'F2', name: 'bad.exe', mimetype: 'application/x-executable', size: 100, url_private_download: 'https://files.slack.com/files/F2/bad.exe' },
        ],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('2 attachment errors'),
      );
      expect(reply).toBeTruthy();
    });

    test('proceeds without attachments when no files are present', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
      await handler(mention({ text: 'submit org/repo fix' }));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });
  });
});
