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

import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';

import { handler } from '../../src/handlers/create-task';
import { DEFAULT_WORKFLOW_ID } from '../../src/handlers/shared/workflows';

const GUIDES = ['docs/guides/USER_GUIDE.md', 'docs/guides/QUICK_START.mdx'];

const CREATES_TASK = /curl\b.*POST\b.*\/tasks"/g;

interface Example {
  readonly guide: string;
  readonly line: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const read = (guide: string): string => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', guide), 'utf8');

const EXAMPLES: Example[] = GUIDES.flatMap((guide) => {
  const text = read(guide);
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((fence) => {
    const curl = fence[1].match(CREATES_TASK);
    const body = /'(\{[\s\S]*?\})'/.exec(fence[1]);
    if (!curl || !body) return [];
    return [{
      guide,
      line: text.slice(0, fence.index + fence[0].indexOf(curl[0])).split('\n').length,
      headers: Object.fromEntries([...fence[1].matchAll(/-H "([^:"]+): ([^"]*)"/g)].map(([, name, value]) => [name, value])),
      body: body[1],
    }];
  });
});

describe('the requests of the guides that create a task', () => {
  beforeEach(() => {
    mockSend.mockResolvedValue({});
  });

  test.each(GUIDES)('each one of %s is read with its body', (guide) => {
    expect(EXAMPLES.filter((example) => example.guide === guide)).toHaveLength(read(guide).match(CREATES_TASK)!.length);
  });

  test.each(EXAMPLES)('$guide:$line the API accepts the request and leaves no repository to the fallback workflow', async ({ headers, body }) => {
    const result = await handler({
      body,
      headers,
      requestContext: { authorizer: { claims: { sub: 'user-123' } } },
    } as unknown as APIGatewayProxyEvent);
    const { data, error } = JSON.parse(result.body);

    expect(error).toBeUndefined();
    expect(result.statusCode).toBe(201);
    if (JSON.parse(body).repo !== undefined) {
      expect(data.resolved_workflow.id).not.toBe(DEFAULT_WORKFLOW_ID);
    }
  });
});
