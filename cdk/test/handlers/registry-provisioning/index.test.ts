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
 * handler drives an async Agent Registry lifecycle, so these lock in the
 * non-obvious branches the source comments flag as prior bugs: idempotent
 * create tokens, the Update branch actually issuing UpdateRegistry, and
 * asynchronous delete completion.
 */

// Command classes are tagged so the mock `send` can dispatch on constructor.
// The exception class must be a real (throwable) class because the
// handler branches on `instanceof`.
const mockSend = jest.fn();

class ResourceNotFoundException extends Error {
  constructor() {
    super('not found');
    this.name = 'ResourceNotFoundException';
  }
}

class ConflictException extends Error {
  constructor() {
    super('conflict');
    this.name = 'ConflictException';
  }
}

class ThrottlingException extends Error {
  constructor() {
    super('throttled');
    this.name = 'ThrottlingException';
  }
}

class InternalServerException extends Error {
  constructor() {
    super('internal');
    this.name = 'InternalServerException';
  }
}

jest.mock('@aws-sdk/client-agent-registry-control', () => ({
  AgentRegistryControlClient: jest.fn(() => ({ send: mockSend })),
  ConflictException,
  CreateRegistryCommand: jest.fn((input: unknown) => ({ _type: 'CreateRegistry', input })),
  DeleteRegistryCommand: jest.fn((input: unknown) => ({ _type: 'DeleteRegistry', input })),
  GetRegistryCommand: jest.fn((input: unknown) => ({ _type: 'GetRegistry', input })),
  InternalServerException,
  ResourceNotFoundException,
  ThrottlingException,
  UpdateRegistryCommand: jest.fn((input: unknown) => ({ _type: 'UpdateRegistry', input })),
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

const REGISTRY_ID = 'AbCdEfGh1234';
const ARN = `arn:aws:agent-registry:us-east-1:123456789012:registry/${REGISTRY_ID}`;

describe('onEvent Create', () => {
  test('creates the registry and returns the id as PhysicalResourceId', async () => {
    routeSend({ CreateRegistry: () => ({ registryArn: ARN }) });
    const res = await onEvent({
      RequestType: 'Create',
      RequestId: 'req-1',
      ResourceProperties: { RegistryName: 'abca', Description: 'd' },
    });
    expect(res.PhysicalResourceId).toBe(REGISTRY_ID);
    expect(res.Data).toMatchObject({ RegistryId: REGISTRY_ID, RegistryArn: ARN });
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
      PhysicalResourceId: REGISTRY_ID,
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
      PhysicalResourceId: REGISTRY_ID,
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
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca', Description: 'd' },
      OldResourceProperties: { RegistryName: 'abca', Description: 'd' },
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('onEvent Delete', () => {
  test('starts asynchronous registry deletion', async () => {
    routeSend({ DeleteRegistry: () => ({ status: 'DELETING' }) });
    await onEvent({
      RequestType: 'Delete',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    const types = mockSend.mock.calls.map((c) => (c[0] as TaggedCommand)._type);
    expect(types).toEqual(['DeleteRegistry']);
  });

  test('treats an already-absent registry as deleted', async () => {
    routeSend({
      DeleteRegistry: () => {
        throw new ResourceNotFoundException();
      },
    });
    await expect(
      onEvent({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toMatchObject({ PhysicalResourceId: REGISTRY_ID });
  });

  test.each([
    ['conflict', ConflictException],
    ['throttling', ThrottlingException],
    ['internal service error', InternalServerException],
  ])('defers a retryable %s to the waiter', async (_label, ErrorType) => {
    routeSend({
      DeleteRegistry: () => {
        throw new ErrorType();
      },
    });
    await expect(
      onEvent({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toMatchObject({ PhysicalResourceId: REGISTRY_ID });
  });

  test('rethrows an unexpected error from DeleteRegistry', async () => {
    routeSend({
      DeleteRegistry: () => {
        throw new Error('AccessDenied');
      },
    });
    await expect(
      onEvent({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).rejects.toThrow('AccessDenied');
  });
});

describe('isComplete Create/Update', () => {
  test('returns IsComplete once the registry is READY', async () => {
    routeSend({ GetRegistry: () => ({ status: 'READY', registryArn: ARN }) });
    const res = await isComplete({
      RequestType: 'Create',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res).toMatchObject({
      IsComplete: true,
      Data: { RegistryId: REGISTRY_ID, RegistryArn: ARN },
    });
  });

  test('keeps polling while still CREATING', async () => {
    routeSend({ GetRegistry: () => ({ status: 'CREATING' }) });
    const res = await isComplete({
      RequestType: 'Create',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(false);
  });

  test('throws (fails the deploy) on a FAILED status with the substrate reason', async () => {
    routeSend({ GetRegistry: () => ({ status: 'CREATE_FAILED', statusReason: 'quota exceeded' }) });
    await expect(
      isComplete({
        RequestType: 'Create',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
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
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(true);
  });

  test('not complete while the registry is still deleting', async () => {
    routeSend({ GetRegistry: () => ({ status: 'DELETING' }) });
    const res = await isComplete({
      RequestType: 'Delete',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(false);
    const types = mockSend.mock.calls.map((c) => (c[0] as TaggedCommand)._type);
    expect(types).toEqual(['GetRegistry']);
  });

  test('re-drives deletion when the registry is not yet deleting', async () => {
    routeSend({
      GetRegistry: () => ({ status: 'READY' }),
      DeleteRegistry: () => ({ status: 'DELETING' }),
    });
    const res = await isComplete({
      RequestType: 'Delete',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(false);
    const types = mockSend.mock.calls.map((c) => (c[0] as TaggedCommand)._type);
    expect(types).toEqual(['GetRegistry', 'DeleteRegistry']);
  });

  test('keeps polling when a re-driven delete gets a retryable conflict', async () => {
    routeSend({
      GetRegistry: () => ({ status: 'READY' }),
      DeleteRegistry: () => {
        throw new ConflictException();
      },
    });
    const res = await isComplete({
      RequestType: 'Delete',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(false);
  });

  test('keeps polling when GetRegistry is throttled', async () => {
    routeSend({
      GetRegistry: () => {
        throw new ThrottlingException();
      },
    });
    const res = await isComplete({
      RequestType: 'Delete',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(res.IsComplete).toBe(false);
  });

  test('throws when asynchronous deletion fails', async () => {
    routeSend({
      GetRegistry: () => ({ status: 'DELETE_FAILED', statusReason: 'records locked' }),
    });
    await expect(
      isComplete({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).rejects.toThrow(/DELETE_FAILED.*records locked/);
  });
});
