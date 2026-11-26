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

import { ConflictException, ValidationException } from '@aws-sdk/client-agent-registry-control';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { handler } from '../../src/handlers/registry-publish';
import { RegistryPublishIncompleteError } from '../../src/handlers/shared/registry/types';

const mockPublish = jest.fn();
jest.mock('../../src/handlers/shared/registry/factory', () => {
  const actual = jest.requireActual('../../src/handlers/shared/registry/factory');
  return { ...actual, makeRegistryClient: () => ({ publish: mockPublish }) };
});
jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

const validBody = {
  kind: 'mcp_server',
  namespace: 'acme',
  name: 'pdf-tools',
  asset_version: '1.0.0',
  discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
  runtime: { transport: 'http', url: 'https://x' },
};

const publishedRecord = {
  kind: 'mcp_server',
  namespace: 'acme',
  name: 'pdf-tools',
  version: '1.0.0',
  status: 'PENDING_APPROVAL',
  storageMode: 'native',
  discovery: {},
  runtime: {},
};

function publish(body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  return handler({
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { 'sub': 'user-1', 'cognito:groups': 'RegistryPublisher' } } },
  } as unknown as APIGatewayProxyEvent);
}

beforeEach(() => mockPublish.mockReset());

describe('registry-publish handler: the coordinates must be strings', () => {
  test.each([
    ['namespace is an array', { namespace: ['acme'] }],
    ['name is a number', { name: 5 }],
    ['name is an array', { name: ['pdf-tools'] }],
    ['asset_version is an array', { asset_version: ['1.0.0'] }],
  ])('400 when %s, and nothing is published', async (_label, override) => {
    mockPublish.mockResolvedValue(publishedRecord);
    const res = await publish({ ...validBody, ...override });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('registry-publish handler: what a refused publish tells the publisher', () => {
  test('409 says so when the slot is held by a corrupt record that has to be deleted', async () => {
    mockPublish.mockRejectedValue(new ConflictException({
      message: 'record mcp_server/acme/pdf-tools@1.0.0 already exists but its descriptor is malformed (MALFORMED_DESCRIPTOR); delete it before republishing',
      $metadata: {},
    }));
    const res = await publish(validBody);
    expect(res.statusCode).toBe(409);
    const { error } = JSON.parse(res.body);
    expect(error.code).toBe('REGISTRY_VERSION_EXISTS');
    expect(error.message).toContain('descriptor is malformed (MALFORMED_DESCRIPTOR); delete it before republishing');
  });

  test('400 with the reason when AWS rejects the record as invalid', async () => {
    mockPublish.mockRejectedValue(new ValidationException({
      message: "Schema validation failed: content is not in compliance with schema version '2025-12-11' for descriptor type 'mcp'.",
      reason: 'FieldValidationFailed',
      $metadata: {},
    }));
    const res = await publish(validBody);
    expect(res.statusCode).toBe(400);
    const { error } = JSON.parse(res.body);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain("not in compliance with schema version '2025-12-11'");
  });

  test('502 with the record id and what to do with it when the publish stops after the record is created', async () => {
    mockPublish.mockRejectedValue(new RegistryPublishIncompleteError(
      'rec-1',
      'record mcp_server/acme/pdf-tools@1.0.0 was created (id rec-1) but could not be driven to a resolvable state; approve or delete it before retrying',
      new Error('record rec-1 did not leave CREATING within 10 polls'),
    ));
    const res = await publish(validBody);
    expect(res.statusCode).toBe(502);
    const { error } = JSON.parse(res.body);
    expect(error.code).toBe('REGISTRY_PUBLISH_INCOMPLETE');
    expect(error.message).toContain('approve or delete it before retrying');
    expect(error.message).toContain('record id: rec-1');
  });
});

describe('registry-publish handler: an mcp_server the agent could not load is refused', () => {
  test.each([
    ['a header value is a number', { transport: 'http', url: 'https://x', headers: { 'X-Shard': 3 } }, /headers.*string values/],
    ['a header value is null', { transport: 'http', url: 'https://x', headers: { 'X-Shard': null } }, /headers.*string values/],
    ['one of two header values is a number', { transport: 'http', url: 'https://x', headers: { 'Authorization': 'Bearer t', 'X-Shard': 3 } }, /headers.*string values/],
    ['a header value is a number on a stdio server', { transport: 'stdio', command: 'npx', headers: { 'X-Shard': 3 } }, /headers.*string values/],
    ['args is a string on an http server', { transport: 'http', url: 'https://x', args: 'x' }, /args.*array of strings/],
    ['args is a string', { transport: 'stdio', command: 'npx', args: '-y pkg' }, /args.*array of strings/],
    ['args holds a number', { transport: 'stdio', command: 'npx', args: [1, 'pkg'] }, /args.*array of strings/],
    ['args is null', { transport: 'stdio', command: 'npx', args: null }, /args.*array of strings/],
  ])('400 when %s, and nothing is published', async (_label, runtime, message) => {
    mockPublish.mockResolvedValue(publishedRecord);
    const res = await publish({ ...validBody, runtime });
    expect(res.statusCode).toBe(400);
    const { error } = JSON.parse(res.body);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toMatch(message);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test.each([
    ['string headers', { transport: 'http', url: 'https://x', headers: { 'X-Shard': '3' } }],
    ['no headers', { transport: 'sse', url: 'https://x' }],
    ['an empty headers object', { transport: 'http', url: 'https://x', headers: {} }],
    ['a list of strings as args', { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }],
    ['an empty list of args', { transport: 'stdio', command: 'npx', args: [] }],
  ])('201 with %s', async (_label, runtime) => {
    mockPublish.mockResolvedValue(publishedRecord);
    const res = await publish({ ...validBody, runtime });
    expect(res.statusCode).toBe(201);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
