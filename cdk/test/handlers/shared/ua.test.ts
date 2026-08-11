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

import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  abcaUserAgent,
  makeClient,
  makeDocClient,
  sanitizeUaValue,
} from '../../../src/handlers/shared/ua';

describe('AWS SDK solution attribution', () => {
  const previousComponent = process.env.ABCA_COMPONENT;

  afterEach(() => {
    if (previousComponent === undefined) delete process.env.ABCA_COMPONENT;
    else process.env.ABCA_COMPONENT = previousComponent;
  });

  test('sanitizes and emits the configured component label', () => {
    process.env.ABCA_COMPONENT = 'jira#webhook';
    expect(sanitizeUaValue('jira#webhook')).toBe('jira-webhook');
    expect(abcaUserAgent()).toEqual({
      customUserAgent: [['md/uksb-wt64nei4u6', 'jira-webhook']],
    });
  });

  test('preserves caller options and custom user-agent pairs', async () => {
    const client = makeClient(S3Client, {
      region: 'us-east-1',
      customUserAgent: [['caller/1.0', 'test']],
    });
    expect(await client.config.region()).toBe('us-east-1');
    expect(client.config.customUserAgent).toEqual([
      ['caller/1.0', 'test'],
      ...abcaUserAgent().customUserAgent,
    ]);
  });

  test('constructs an attributed DynamoDB document client', () => {
    expect(makeDocClient({ region: 'us-east-1' })).toBeInstanceOf(DynamoDBDocumentClient);
  });
});
