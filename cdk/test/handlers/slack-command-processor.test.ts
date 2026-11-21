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

/** JSON bodies of the calls made to one Slack Web API method, in call order. */
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
    // Legacy shape: no source field — slash ack lambda forwards raw SlackCommandPayload
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
    // Posted the default "Use @Shoof" hint back to the response_url
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
    // 1. User mapping lookup: not found
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    // 2. swapReaction → getBotToken → installation lookup (for :x: swap)
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
    // channel-default lookup returns a row without a repo → no default; then
    // swapReaction → getBotToken installation lookup.
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit not-a-repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo falls back to channel default and uses full text as description', async () => {
    // 1. user mapping → linked
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // 2. channel-default lookup → active mapping to org/defaultrepo
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repo: 'org/defaultrepo' } });
    // 3. checkChannelAccess installation lookup (+ bot token secret)
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
    // The whole message is the description — the first token is NOT dropped.
    expect(reqBody.task_description).toBe('fix the spacing on the header');
  });

  test('mention submit with no repo fails open when the channel lookup throws', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // channel-default lookup throws → fail open → no default → guidance reply
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
    // Installation lookup for bot token (checkChannelAccess) + bot token secret
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    // fetch: conversations.info response (public channel with bot as member)
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
    // Must pin the coding workflow — an absent workflow_ref falls through the
    // resolution ladder to default/agent-v1, which never opens a PR. Mirrors
    // the Jira processor.
    expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
    expect(ctx.channelSource).toBe('slack');
    expect(ctx.userId).toBe('cognito-1');
    // mention_thread_ts flows to channel_metadata
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
    // conversations.info answers that the bot lacks the scope to read this
    // conversation (a group direct message, for example). The events handler
    // has put :eyes: on the mention, and no task will be created.
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
    // conversations.info returns a non-hard failure — task creation should proceed.
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
    // mention_message_ts is the mention itself, mention_thread_ts the first
    // message of the thread, which somebody else may have written.
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
      ddbSend.mockResolvedValueOnce({ Item: undefined }); // user mapping: not linked
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
    // Linked user, public channel, and then the task write fails (DynamoDB
    // throttling escapes createTaskCore). No task exists: the mention must not
    // keep the reaction that means "received".
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
    // An error that escapes the handler makes Lambda retry the asynchronous
    // invocation, which would run the whole submission a second time.
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } }) // user mapping
      .mockResolvedValueOnce({ Item: { status: 'active' } }) // installation, for the channel check
      .mockResolvedValueOnce({ Item: { status: 'active' } }) // installation, for the error reply
      .mockRejectedValueOnce(new Error('ddb throttle')); // installation, for the reaction swap
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
    ddbSend.mockResolvedValueOnce({}); // Put pending mapping
    await handler(slashCommand({ text: 'link' }));
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.slack_identity).toMatch(/^pending#/);
    expect(putCall![0].input.Item.status).toBe('pending');
    // slack-link refuses a pending row whose ttl is not a number of seconds in the future.
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

  // ─── Which word of the message is the repository ─────────────────────────────

  describe('repo and description of a mention', () => {
    /** Every Get is answered from its table: a linked user, an installed workspace, these onboarded repos and this channel default. */
    function givenTables(onboarded: string[], channelDefault?: string): void {
      ddbSend.mockImplementation((cmd: { input: { TableName: string; Key: Record<string, string> } }) => {
        const { TableName, Key } = cmd.input;
        if (TableName === 'SlackMap') return Promise.resolve({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
        if (TableName === 'SlackChannelMap') return Promise.resolve({ Item: channelDefault ? { status: 'active', repo: channelDefault } : undefined });
        if (TableName === 'Repos') return Promise.resolve({ Item: onboarded.includes(Key.repo) ? { repo: Key.repo, status: 'active' } : undefined });
        return Promise.resolve({ Item: { status: 'active' } }); // SlackInstall
      });
    }

    /** createTaskCore's answer to a repo that is not onboarded. */
    function givenNotOnboardedAnswer(): void {
      createTaskCoreMock.mockResolvedValue({
        statusCode: 422,
        body: JSON.stringify({ error: { code: 'REPO_NOT_ONBOARDED', message: 'Repository is not onboarded.' } }),
      });
    }

    function repoLookups(): string[] {
      return ddbSend.mock.calls.filter(([cmd]) => cmd.input.TableName === 'Repos').map(([cmd]) => cmd.input.Key.repo);
    }

    /** What createTaskCore was asked to create. */
    function submitted(): unknown[] {
      return createTaskCoreMock.mock.calls.map(([body]) => ({
        repo: body.repo,
        issue_number: body.issue_number,
        task_description: body.task_description,
      }));
    }

    beforeEach(() => {
      process.env.REPO_TABLE_NAME = 'Repos';
      // conversations.info of a public channel the bot is in; any other Slack call just succeeds.
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
      // One read per distinct name.
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

    test.each([
      'fix the CI/CD pipeline',
      'add a yes/no prompt',
      'bump node to 22 and/or 24',
      'support 24/7 mode',
      'src/handlers/foo.ts throws on empty input',
      // The price of the rule: a repo that is not onboarded reads like any
      // other slash word when nothing marks it as a repo (the tests below
      // say what does).
      'update the README in other/web',
    ])('a slash word that is no onboarded repo leaves the channel default in charge of the whole message: %s', async (message) => {
      givenTables(['acme/api'], 'acme/api');

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([{ repo: 'acme/api', issue_number: undefined, task_description: message }]);
    });

    test.each([
      // Written with an issue number: it is a repo, whoever owns it.
      ['with an issue number', 'fix other/web#7 the way acme/api does it', { repo: 'other/web', issue_number: 7, task_description: 'fix the way acme/api does it' }],
      // Under the owner of the onboarded repo: its sibling, or a typo of it.
      ['of the same owner', 'update acme/web like acme/api', { repo: 'acme/web', issue_number: undefined, task_description: 'update like acme/api' }],
      // Given as a GitHub link: it is a repo, whoever owns it.
      ['given as a link', 'fix <https://github.com/other/web> the way acme/api does it', { repo: 'other/web', issue_number: undefined, task_description: 'fix the way acme/api does it' }],
    ])('a repo %s that is not onboarded is not passed over for an onboarded repo behind it', async (_what, message, expected) => {
      givenTables(['acme/api']);
      givenNotOnboardedAnswer();

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([expected]);
    });

    test.each([
      // Written with an issue number: nobody means the channel default by that.
      ['a repo with an issue number', 'fix the bug in other/web#42', { repo: 'other/web', issue_number: 42, task_description: 'fix the bug in' }],
      // Under the owner of the channel default (owners compare without case): a sibling repo, or a typo.
      ["a repo of the default's owner", 'update the README in Acme/web', { repo: 'Acme/web', issue_number: undefined, task_description: 'update the README in' }],
    ])('%s that is not onboarded is not replaced by the channel default', async (_what, message, expected) => {
      givenTables(['acme/api'], 'acme/api');
      givenNotOnboardedAnswer();

      await handler(mention({ text: `submit ${message}` }));

      // createTaskCore answers that this repo is not onboarded, and the user reads it.
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

    // ─── A pasted link ───────────────────────────────────────────────────────

    const LINKED_ISSUE = { repo: 'aws-samples/sample-interview-assistant-serverless', issue_number: 24, task_description: 'fix' };

    test.each([
      // One issue, written three ways.
      ['an issue link as Slack delivers it', 'fix <https://github.com/aws-samples/sample-interview-assistant-serverless/issues/24>', LINKED_ISSUE],
      ['an issue link as typed', 'fix https://github.com/aws-samples/sample-interview-assistant-serverless/issues/24', LINKED_ISSUE],
      ['the short form', 'fix aws-samples/sample-interview-assistant-serverless#24', LINKED_ISSUE],
      ['an issue link as typed, with text after it', 'fix https://github.com/other/web/issues/7 before the release', { repo: 'other/web', issue_number: 7, task_description: 'fix before the release' }],
      ['a pull request link', 'review <https://github.com/other/web/pull/7> again', { repo: 'other/web', issue_number: 7, task_description: 'review again' }],
      // What GitHub puts behind the number: a tab of the pull request, a comment of the issue.
      ['a link into a pull request', 'fix <https://github.com/other/web/pull/7/files#diff-0> too', { repo: 'other/web', issue_number: 7, task_description: 'fix too' }],
      ['a repo link', 'update the README in <https://github.com/other/web>', { repo: 'other/web', issue_number: undefined, task_description: 'update the README in' }],
      // Slack makes a link of an address typed without "https://" and keeps the typed text as its label.
      ['a repo link with a label', 'update the README in <http://github.com/other/web|github.com/other/web>', { repo: 'other/web', issue_number: undefined, task_description: 'update the README in' }],
      ['a repo link with www, a closing slash and a query', '<https://www.github.com/other/web/?tab=readme-ov-file> needs a license', { repo: 'other/web', issue_number: undefined, task_description: 'needs a license' }],
      ['a repo link with a fragment', 'follow <https://github.com/other/web#readme> to the letter', { repo: 'other/web', issue_number: undefined, task_description: 'follow to the letter' }],
      // What the Code button of GitHub copies. Only the suffix ".git" is no part of the name.
      ['a clone address', 'update the README in <https://github.com/other/web.git>', { repo: 'other/web', issue_number: undefined, task_description: 'update the README in' }],
      ['a link to a repo whose name ends in git', 'update the README in <https://github.com/other/web-git>', { repo: 'other/web-git', issue_number: undefined, task_description: 'update the README in' }],
      // Scheme and host names compare without case.
      ['a link written in capitals', 'fix <HTTPS://GITHUB.COM/other/web/issues/7>', { repo: 'other/web', issue_number: 7, task_description: 'fix' }],
      // The label is dropped with the link, also when the user wrote it.
      ['an issue link with a label', 'fix <https://github.com/other/web/issues/7|the login timeout> before Friday', { repo: 'other/web', issue_number: 7, task_description: 'fix before Friday' }],
    ])('%s names its repo, onboarded or not, and its issue number', async (_what, message, expected) => {
      // The channel default is another repo, and the linked repo is not onboarded:
      // createTaskCore is asked for the linked repo and answers for it.
      givenTables(['acme/api'], 'acme/api');
      givenNotOnboardedAnswer();

      await handler(mention({ text: `submit ${message}` }));

      expect(submitted()).toEqual([expected]);
      // No part of a link is looked up as a word.
      expect(repoLookups()).toEqual([]);
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
      // Another site. One part of the address stands under the owner of the channel default.
      'fix what <https://example.com/teams/acme/board> describes',
      'fix what https://example.com/teams/acme/board describes',
      // GitHub, but a file: not a repo, an issue or a pull request.
      'fix the typo in <https://github.com/acme/acme/blob/main/README.md>',
      // Not github.com: a gist has an address of the same shape on another host.
      'apply <https://gist.github.com/acme/notes> to the config',
      // Another site whose address carries a GitHub address.
      'fix what <https://example.com/go?to=https://github.com/other/web/issues/3> says',
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

    // ─── The description keeps the user's lines ──────────────────────────────

    const DIFF = '```\n- timeout: 30\n+   timeout: 60\n```';

    test.each([
      ['after the repo', `acme/api apply this change:\n${DIFF}`, `apply this change:\n${DIFF}`],
      ['around a repo in the middle', `in acme/api apply this change:\n${DIFF}`, `in apply this change:\n${DIFF}`],
      ['before a repo at the end', `apply this change:\n${DIFF}\nin acme/api`, `apply this change:\n${DIFF}\nin`],
      ['before a repo that starts a line', `apply this change:\n${DIFF}\nacme/api: that is the repo`, `apply this change:\n${DIFF}\n: that is the repo`],
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

  // ─── Slack file attachment extraction ────────────────────────────────────────

  describe('file attachments', () => {
    beforeEach(() => {
      // Standard setup: linked user, public channel
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
    });

    test('downloads Slack files and passes as inline attachments', async () => {
      // fetch for file download
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

    // ─── Size limits: those of an inline attachment ────────────────────────────
    //
    // The files are handed to createTaskCore inline, and validateAttachments
    // takes 500 KB per file and 3 MB per task that way. The user has to be told
    // these numbers, before anything is downloaded.

    /** A PNG of exactly `size` bytes: the signature validateAttachments checks, then padding. */
    function png(size: number): Buffer {
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8)]);
    }

    /**
     * Submit a mention with one PNG per entry of `sizes`. Slack's CDN serves
     * file i with sizes[i] bytes; the event declares it with declared[i].
     */
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
      // The events handler forwards size 0 when Slack sends none.
      await submitPngs([600 * 1024], [0]);

      expect(downloads()).toHaveLength(1);
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ text: expect.stringContaining('`shot0.png` (too large, 600 KB > 500 KB limit)') }),
      ]);
    });

    test('refuses files over the 3 MB inline total, without downloading the one that exceeds it', async () => {
      // Seven screenshots of 480 KB pass the per-file limit and make 3,360 KB.
      await submitPngs(Array<number>(7).fill(480 * 1024));

      expect(downloads()).toHaveLength(6);
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(slackCalls('chat.postMessage')).toEqual([
        expect.objectContaining({ text: expect.stringContaining('`shot6.png` (more than 3 MB of attachments in total)') }),
      ]);
    });

    // The processor reads the two limits from validation.ts. These cases sit on
    // both sides of each limit and fail when the processor and
    // validateAttachments stop agreeing.
    test.each([
      ['a file of exactly 500 KB', [500 * 1024], true],
      ['a file of 500 KB and one byte', [500 * 1024 + 1], false],
      ['files of exactly 3 MB together', [...Array<number>(6).fill(500 * 1024), 3 * 1024 * 1024 - 6 * 500 * 1024], true],
      ['files of 3 MB and one byte together', [...Array<number>(6).fill(500 * 1024), 3 * 1024 * 1024 - 6 * 500 * 1024 + 1], false],
    ])('%s: handed over exactly when validateAttachments takes it', async (_what, sizes, accepted) => {
      await submitPngs(sizes);

      // The same files as the processor would hand them over.
      const inline = sizes.map((size, i) => ({
        type: 'image',
        content_type: 'image/png',
        filename: `shot${i}.png`,
        data: png(size).toString('base64'),
      }));
      expect(validateAttachments(inline).valid).toBe(accepted);
      // Byte counts, not the attachments: a megabyte of base64 in a failure message helps nobody.
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
