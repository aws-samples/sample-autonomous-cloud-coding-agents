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
 * Unit tests for the registry provisioning custom-resource handlers (#246):
 * onEvent (Create/Update/Delete) and isComplete (Create/Update/Delete). The
 * handler drives an async AgentCore registry lifecycle, so these lock in the
 * non-obvious branches the source comments flag as prior bugs: idempotent
 * create tokens, the Update branch actually issuing UpdateRegistry, and the
 * delete drain + Conflict/NotFound retry semantics.
 */

// Command classes are tagged so the mock `send` can dispatch on constructor.
// The two exception classes must be real (throwable) classes because the
// handler branches on `instanceof`.
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
  CreateRegistryCommand: jest.fn((input: unknown) => ({ _type: 'CreateRegistry', input })),
  GetRegistryCommand: jest.fn((input: unknown) => ({ _type: 'GetRegistry', input })),
  UpdateRegistryCommand: jest.fn((input: unknown) => ({ _type: 'UpdateRegistry', input })),
  DeleteRegistryCommand: jest.fn((input: unknown) => ({ _type: 'DeleteRegistry', input })),
  ListRegistryRecordsCommand: jest.fn((input: unknown) => ({ _type: 'ListRegistryRecords', input })),
  DeleteRegistryRecordCommand: jest.fn((input: unknown) => ({ _type: 'DeleteRegistryRecord', input })),
  ConflictException,
  ResourceNotFoundException,
}));

import { isComplete, onEvent } from '../../../src/handlers/registry-provisioning/index';

interface TaggedCommand {
  _type: string;
  input: Record<string, unknown>;
}

beforeEach(() => {
  mockSend.mockReset();
});

/** Route mockSend by command type using the provided handlers. */
function routeSend(handlers: Record<string, (input: Record<string, unknown>) => unknown>): void {
  mockSend.mockImplementation((cmd: TaggedCommand) => {
    const h = handlers[cmd._type];
    if (!h) throw new Error(`unexpected command ${cmd._type}`);
    return Promise.resolve(h(cmd.input));
  });
}

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:1:registry/reg-123';

describe('onEvent Create', () => {
  test('creates the registry and returns the id as PhysicalResourceId', async () => {
    routeSend({ CreateRegistry: () => ({ registryArn: ARN }) });
    const res = await onEvent({
      RequestType: 'Create',
      RequestId: 'req-1',
      ResourceProperties: { RegistryName: 'abca', Description: 'd' },
    });
    expect(res.PhysicalResourceId).toBe('reg-123');
    expect(res.Data).toMatchObject({ RegistryId: 'reg-123', RegistryArn: ARN });
    const createInput = mockSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(createInput.name).toBe('abca');
    expect(typeof createInput.clientToken).toBe('string');
  });

  test('clientToken is deterministic per RequestId (idempotent retry) and varies across RequestIds', async () => {
    routeSend({ CreateRegistry: () => ({ registryArn: ARN }) });
    const props = { RegistryName: 'abca' };
    await onEvent({ RequestType: 'Create', RequestId: 'req-1', ResourceProperties: props });
    await onEvent({ RequestType: 'Create', RequestId: 'req-1', ResourceProperties: props });
    await onEvent({ RequestType: 'Create', RequestId: 'req-2', ResourceProperties: props });
    const token = (n: number) => (mockSend.mock.calls[n][0].input as Record<string, unknown>).clientToken;
    expect(token(0)).toBe(token(1)); // same RequestId → same token → substrate no-op on retry
    expect(token(0)).not.toBe(token(2)); // different RequestId → different token
  });
});

describe('onEvent Update', () => {
  test('sends UpdateRegistry with only the changed name', async () => {
    routeSend({ UpdateRegistry: () => ({}) });
    await onEvent({
      RequestType: 'Update',
      PhysicalResourceId: 'reg-123',
      ResourceProperties: { RegistryName: 'new-name', Description: 'same' },
      OldResourceProperties: { RegistryName: 'old-name', Description: 'same' },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input.name).toBe('new-name');
    expect(input.description).toBeUndefined(); // description unchanged → not sent
  });

  test('clears the description via the optionalValue wrapper when it is removed', async () => {
    routeSend({ UpdateRegistry: () => ({}) });
    await onEvent({
      RequestType: 'Update',
      PhysicalResourceId: 'reg-123',
      ResourceProperties: { RegistryName: 'abca' },
      OldResourceProperties: { RegistryName: 'abca', Description: 'was here' },
    });
    const input = mockSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input.description).toEqual({ optionalValue: undefined });
  });

  test('sends no SDK command when nothing changed', async () => {
    routeSend({});
    await onEvent({
      RequestType: 'Update',
      PhysicalResourceId: 'reg-123',
      ResourceProperties: { RegistryName: 'abca', Description: 'd' },
      OldResourceProperties: { RegistryName: 'abca', Description: 'd' },
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('onEvent Delete', () => {
  test('drains records then deletes the registry', async () => {
    routeSend({
      ListRegistryRecords: () => ({ registryRecords: [{ recordId: 'r1' }, { recordId: 'r2' }] }),
      DeleteRegistryRecord: () => ({}),
      DeleteRegistry: () => ({}),
    });
    await onEvent({ RequestType: 'Delete', PhysicalResourceId: 'reg-123', ResourceProperties: { RegistryName: 'abca' } });
    const types = mockSend.mock.calls.map((c) => (c[0] as TaggedCommand)._type);
    expect(types).toEqual(['ListRegistryRecords', 'DeleteRegistryRecord', 'DeleteRegistryRecord', 'DeleteRegistry']);
  });

  test('swallows a ConflictException on DeleteRegistry (isComplete will retry)', async () => {
    routeSend({
      ListRegistryRecords: () => ({ registryRecords: [] }),
      DeleteRegistry: () => {
        throw new ConflictException();
      },
    });
    await expect(
      onEvent({ RequestType: 'Delete', PhysicalResourceId: 'reg-123', ResourceProperties: { RegistryName: 'abca' } }),
    ).resolves.toMatchObject({ PhysicalResourceId: 'reg-123' });
  });

  test('rethrows an unexpected error from DeleteRegistry', async () => {
    routeSend({
      ListRegistryRecords: () => ({ registryRecords: [] }),
      DeleteRegistry: () => {
        throw new Error('AccessDenied');
      },
    });
    await expect(
      onEvent({ RequestType: 'Delete', PhysicalResourceId: 'reg-123', ResourceProperties: { RegistryName: 'abca' } }),
    ).rejects.toThrow('AccessDenied');
  });
});

describe('isComplete Create/Update', () => {
  test('returns IsComplete once the registry is READY', async () => {
    routeSend({ GetRegistry: () => ({ status: 'READY', registryArn: ARN }) });
    const res = await isComplete({
      RequestType: 'Create',
      PhysicalResourceId: 'reg-123',
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res).toMatchObject({ IsComplete: true, Data: { RegistryId: 'reg-123', RegistryArn: ARN } });
  });

  test('keeps polling while still CREATING', async () => {
    routeSend({ GetRegistry: () => ({ status: 'CREATING' }) });
    const res = await isComplete({
      RequestType: 'Create',
      PhysicalResourceId: 'reg-123',
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(false);
  });

  test('throws (fails the deploy) on a FAILED status with the substrate reason', async () => {
    routeSend({ GetRegistry: () => ({ status: 'CREATE_FAILED', statusReason: 'quota exceeded' }) });
    await expect(
      isComplete({ RequestType: 'Create', PhysicalResourceId: 'reg-123', ResourceProperties: { RegistryName: 'abca' } }),
    ).rejects.toThrow(/CREATE_FAILED.*quota exceeded/);
  });
});

describe('isComplete Delete', () => {
  test('is complete once GetRegistry 404s (registry gone)', async () => {
    routeSend({
      GetRegistry: () => {
        throw new ResourceNotFoundException();
      },
    });
    const res = await isComplete({
      RequestType: 'Delete',
      PhysicalResourceId: 'reg-123',
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(true);
  });

  test('not complete while the registry still exists — drains + retries delete', async () => {
    routeSend({
      GetRegistry: () => ({ status: 'READY' }),
      ListRegistryRecords: () => ({ registryRecords: [] }),
      DeleteRegistry: () => ({}),
    });
    const res = await isComplete({
      RequestType: 'Delete',
      PhysicalResourceId: 'reg-123',
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(false);
    const types = mockSend.mock.calls.map((c) => (c[0] as TaggedCommand)._type);
    expect(types).toContain('DeleteRegistry');
  });
});
