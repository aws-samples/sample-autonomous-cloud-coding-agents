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

/**
 * Unit tests for the Linear identity vault provisioning handler (#809). The
 * handler creates/updates/deletes the AgentCore workload identity that backs
 * the Linear OAuth token vault. These lock in the non-obvious branches:
 * conflict-on-create falls back to update (idempotent redeploy), the return-URL
 * allowlist is parsed from the JSON-encoded CFN property, and delete tolerates
 * an already-absent identity.
 */

// Command classes are tagged so the mock `send` can dispatch on constructor.
// Exception classes must be real (throwable) classes because the handler
// branches on `instanceof`.
const mockSend = jest.fn();

class ConflictException extends Error {
  constructor() {
    super('conflict');
    this.name = 'ConflictException';
  }
}
class ResourceNotFoundException extends Error {
  constructor() {
    super('not found');
    this.name = 'ResourceNotFoundException';
  }
}

jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn(() => ({ send: mockSend })),
  ConflictException,
  ResourceNotFoundException,
  CreateWorkloadIdentityCommand: jest.fn((input: unknown) => ({ _type: 'Create', input })),
  UpdateWorkloadIdentityCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  DeleteWorkloadIdentityCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  GetWorkloadIdentityCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

import { onEvent, workloadIdentityExists } from '../../../src/handlers/linear-identity-provisioning/index';

interface TaggedCall {
  readonly _type: string;
  readonly input: Record<string, unknown>;
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('linear-identity-provisioning onEvent', () => {
  test('Create sends CreateWorkloadIdentity with the parsed return-URL allowlist and returns a stable id', async () => {
    mockSend.mockResolvedValue({});
    const urls = ['http://localhost:8080/oauth/callback', 'https://d1.cloudfront.net/linear/done'];
    const res = await onEvent({
      RequestType: 'Create',
      ResourceProperties: { WorkloadName: 'abca_linear_oauth', AllowedReturnUrls: JSON.stringify(urls) },
    });

    const call = mockSend.mock.calls[0][0] as TaggedCall;
    expect(call._type).toBe('Create');
    expect(call.input).toEqual({ name: 'abca_linear_oauth', allowedResourceOauth2ReturnUrls: urls });
    // Stable natural id so a no-op update is not treated as a replacement.
    expect(res.PhysicalResourceId).toBe('abca_linear_oauth');
    expect(res.Data).toEqual({ WorkloadName: 'abca_linear_oauth' });
  });

  test('Create falling into ConflictException updates the existing identity in place', async () => {
    mockSend
      .mockRejectedValueOnce(new ConflictException()) // Create
      .mockResolvedValueOnce({}); // Update
    await onEvent({
      RequestType: 'Create',
      ResourceProperties: { WorkloadName: 'abca_linear_oauth', AllowedReturnUrls: JSON.stringify(['http://localhost:8080/oauth/callback']) },
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    const second = mockSend.mock.calls[1][0] as TaggedCall;
    expect(second._type).toBe('Update');
    expect(second.input.name).toBe('abca_linear_oauth');
  });

  test('Create on the REAL duplicate error (ValidationException "already exists") updates in place', async () => {
    // Regression: AgentCore reports a duplicate workload-identity name as a
    // ValidationException, not a ConflictException (verified live). Without
    // handling it, the SECOND deploy fails — CloudFormation sends an Update, the
    // handler re-issues Create, and the unhandled error rolls the stack back.
    const dup = Object.assign(
      new Error("WorkloadIdentity with name 'abca_linear_oauth' already exists."),
      { name: 'ValidationException' },
    );
    mockSend.mockRejectedValueOnce(dup).mockResolvedValueOnce({});
    await onEvent({
      RequestType: 'Create',
      ResourceProperties: { WorkloadName: 'abca_linear_oauth', AllowedReturnUrls: JSON.stringify(['http://localhost:8080/oauth/callback']) },
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect((mockSend.mock.calls[1][0] as TaggedCall)._type).toBe('Update');
  });

  test('a GENUINE ValidationException still fails the resource (not treated as already-exists)', async () => {
    const bad = Object.assign(
      new Error('Invalid redirectUrl http://bad provided'),
      { name: 'ValidationException' },
    );
    mockSend.mockRejectedValueOnce(bad);
    await expect(
      onEvent({
        RequestType: 'Create',
        ResourceProperties: { WorkloadName: 'abca_linear_oauth', AllowedReturnUrls: '[]' },
      }),
    ).rejects.toThrow(/Invalid redirectUrl/);
  });

  test('Update reconciles the allowlist via UpdateWorkloadIdentity when the identity already exists', async () => {
    mockSend
      .mockRejectedValueOnce(new ConflictException())
      .mockResolvedValueOnce({});
    const newUrls = ['http://localhost:8080/oauth/callback', 'https://new.example.com/done'];
    await onEvent({
      RequestType: 'Update',
      PhysicalResourceId: 'abca_linear_oauth',
      ResourceProperties: { WorkloadName: 'abca_linear_oauth', AllowedReturnUrls: JSON.stringify(newUrls) },
    });
    const updateCall = mockSend.mock.calls[1][0] as TaggedCall;
    expect(updateCall.input.allowedResourceOauth2ReturnUrls).toEqual(newUrls);
  });

  describe('an unusable AllowedReturnUrls fails the resource instead of emptying the allowlist', () => {
    // It previously degraded to `[]`, which is the worst available outcome: the identity
    // is provisioned — or on an Update, REWRITTEN — with no permitted consent-callback
    // URL, so every consent afterwards fails the allowlist while the stack reports a
    // clean deploy. Nothing downstream can tell that apart from "the operator asked for
    // no URLs", so the failure has to surface here.
    test.each([
      ['malformed JSON', 'not-json{', /not valid JSON/],
      ['a JSON scalar', '"just-a-string"', /not a JSON array of strings/],
      ['an array of non-strings', '[1,2]', /not a JSON array of strings/],
      ['missing entirely', undefined, /is missing/],
    ])('%s is refused', async (_label, raw, expected) => {
      mockSend.mockResolvedValue({});
      await expect(
        onEvent({
          RequestType: 'Create',
          ResourceProperties: {
            WorkloadName: 'abca_linear_oauth',
            ...(raw !== undefined && { AllowedReturnUrls: raw }),
          },
        }),
      ).rejects.toThrow(expected);
      // And nothing was sent: refusing after the call would already have clobbered a
      // live allowlist on the Update path.
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('an EXPLICITLY empty array is still honoured — that is a caller choice, not a parse failure', async () => {
      mockSend.mockResolvedValue({});
      await onEvent({
        RequestType: 'Create',
        ResourceProperties: { WorkloadName: 'abca_linear_oauth', AllowedReturnUrls: '[]' },
      });
      const call = mockSend.mock.calls[0][0] as TaggedCall;
      expect(call.input.allowedResourceOauth2ReturnUrls).toEqual([]);
    });
  });

  test('Delete tolerates an already-absent workload identity (idempotent)', async () => {
    mockSend.mockRejectedValue(new ResourceNotFoundException());
    const res = await onEvent({
      RequestType: 'Delete',
      PhysicalResourceId: 'abca_linear_oauth',
      ResourceProperties: { WorkloadName: 'abca_linear_oauth' },
    });
    expect(res.PhysicalResourceId).toBe('abca_linear_oauth');
  });

  test('Delete re-throws a non-NotFound error so CloudFormation retries', async () => {
    mockSend.mockRejectedValue(new Error('AccessDenied'));
    await expect(
      onEvent({
        RequestType: 'Delete',
        PhysicalResourceId: 'abca_linear_oauth',
        ResourceProperties: { WorkloadName: 'abca_linear_oauth' },
      }),
    ).rejects.toThrow('AccessDenied');
  });

  test('workloadIdentityExists returns false on ResourceNotFound, true otherwise', async () => {
    mockSend.mockRejectedValueOnce(new ResourceNotFoundException());
    expect(await workloadIdentityExists('abca_linear_oauth')).toBe(false);
    mockSend.mockResolvedValueOnce({ name: 'abca_linear_oauth' });
    expect(await workloadIdentityExists('abca_linear_oauth')).toBe(true);
  });
});
