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
 * create tokens, the Update branch actually issuing UpdateRegistry,
 * asynchronous delete completion, and the deletion of a registry's records
 * before the registry.
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

class ValidationException extends Error {
  constructor() {
    super('1 validation error detected: Value at \'registryId\' failed to satisfy constraint');
    this.name = 'ValidationException';
  }
}

jest.mock('@aws-sdk/client-agent-registry-control', () => ({
  AgentRegistryControlClient: jest.fn(() => ({ send: mockSend })),
  ConflictException,
  CreateRegistryCommand: jest.fn((input: unknown) => ({ _type: 'CreateRegistry', input })),
  DeleteRegistryCommand: jest.fn((input: unknown) => ({ _type: 'DeleteRegistry', input })),
  DeleteRegistryRecordCommand: jest.fn((input: unknown) => ({ _type: 'DeleteRegistryRecord', input })),
  GetRegistryCommand: jest.fn((input: unknown) => ({ _type: 'GetRegistry', input })),
  InternalServerException,
  ListRegistryRecordsCommand: jest.fn((input: unknown) => ({ _type: 'ListRegistryRecords', input })),
  ResourceNotFoundException,
  ThrottlingException,
  UpdateRegistryCommand: jest.fn((input: unknown) => ({ _type: 'UpdateRegistry', input })),
  ValidationException,
}));

import { isComplete, onEvent } from '../../../src/handlers/registry-provisioning/index';

interface TaggedCommand {
  _type: string;
  input: Record<string, unknown>;
}

beforeEach(() => {
  mockSend.mockReset();
});

/** Route mockSend by command type using the provided handlers. The registry holds no record unless a test routes ListRegistryRecords. */
function routeSend(handlers: Record<string, (input: Record<string, unknown>) => unknown>): void {
  const routes: typeof handlers = { ListRegistryRecords: () => ({ registryRecords: [] }), ...handlers };
  mockSend.mockImplementation((cmd: TaggedCommand) => {
    const h = routes[cmd._type];
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
    expect(types).toEqual(['ListRegistryRecords', 'DeleteRegistry']);
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

  // A cancelled create (a sibling resource failed first, so CreateRegistry never
  // returned) still gets a Delete during rollback, carrying a CFN placeholder rather
  // than a registry id. Calling DeleteRegistry with it earns a ValidationException,
  // which is neither absent nor retryable — the resource sticks in DELETE_FAILED and
  // the stack then needs `--retain-resources` to remove at all.
  //
  // Each row asserts the returned PhysicalResourceId explicitly. The framework rejects
  // a Delete response whose id differs from the request's, so echoing verbatim —
  // including `undefined` — is the contract, and a synthesized value would itself wedge
  // the delete.
  // Fixtures taken from the framework's own constants where possible. Note it filters
  // CREATE_FAILED upstream — `safeHandler` answers SUCCESS for a Delete carrying
  // `AWSCDK::CustomResourceProviderFramework::CREATE_FAILED` without invoking this
  // handler at all — so the reachable marker is MISSING_PHYSICAL_ID, which a prior
  // response with no id can leave as the stored physical id.
  test.each([
    ['the MISSING_PHYSICAL_ID marker', 'AWSCDK::CustomResourceProviderFramework::MISSING_PHYSICAL_ID'],
    ['a hyphenated non-id', 'AgentReg-1234'],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('treats a Delete for a never-created registry (%s) as a no-op', async (_label, physicalId) => {
    routeSend({});
    await expect(
      onEvent({
        RequestType: 'Delete',
        PhysicalResourceId: physicalId,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toEqual({ PhysicalResourceId: physicalId });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('passes the bare id to DeleteRegistry when given a full registry ARN', async () => {
    routeSend({ DeleteRegistry: () => ({ status: 'DELETING' }) });
    const res = await onEvent({
      RequestType: 'Delete',
      PhysicalResourceId: ARN,
      ResourceProperties: { RegistryName: 'abca' },
    });
    // Normalised for the API, in the record list and in the delete...
    expect(mockSend.mock.calls.map((c) => (c[0] as TaggedCommand).input.registryId)).toEqual([REGISTRY_ID, REGISTRY_ID]);
    // ...but echoed verbatim back to CloudFormation, which requires an exact match.
    expect(res.PhysicalResourceId).toBe(ARN);
  });

  test('passes a bare id through to DeleteRegistry unchanged', async () => {
    routeSend({ DeleteRegistry: () => ({ status: 'DELETING' }) });
    await onEvent({
      RequestType: 'Delete',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(mockSend.mock.calls.map((c) => (c[0] as TaggedCommand).input.registryId)).toEqual([REGISTRY_ID, REGISTRY_ID]);
  });

  // Pins both ends of the length bound. Without these, {12,64} could drift to {1,64}
  // (placeholders start being deleted against) or back to {12,16} (real ids start being
  // skipped and orphaned) with the rest of the suite still green.
  test.each([
    ['11 chars — below the minimum', 'AbCdEfGh123', false],
    ['12 chars — at the minimum', 'AbCdEfGh1234', true],
    ['16 chars — the service maximum', 'AbCdEfGh12345678', true],
    ['64 chars — our widened bound', 'a'.repeat(64), true],
    ['65 chars — past our bound', 'a'.repeat(65), false],
    ['hyphenated, 13 chars', 'AgentReg-1234', false],
    ['contains colons (framework marker shape)', 'AWSCDK::Foo::BAR', false],
  ])('%s: deletes = %s', async (_label, physicalId, shouldCallApi) => {
    routeSend({ DeleteRegistry: () => ({ status: 'DELETING' }) });
    await onEvent({
      RequestType: 'Delete',
      PhysicalResourceId: physicalId,
      ResourceProperties: { RegistryName: 'abca' },
    });
    // The record list and the delete, or nothing.
    expect(mockSend).toHaveBeenCalledTimes(shouldCallApi ? 2 : 0);
  });

  // The guard fails open on shape drift; this fails open on a request the service
  // rejects. Delete-only — Create and Update must still fail closed on a bad request.
  test('treats a service-rejected id as absent rather than wedging the delete', async () => {
    routeSend({
      DeleteRegistry: () => {
        throw new ValidationException();
      },
    });
    await expect(
      onEvent({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toEqual({ PhysicalResourceId: REGISTRY_ID });
  });
});

// N-1/N-2 from review round 2: both were mutation-proven gaps — deleting the isComplete
// normalisation, or any of the three warns, left the suite green. The warns are not
// cosmetic: they are what makes a skipped delete (a possible billable orphan) visible, so
// nothing should be able to downgrade them to info or drop them with CI still passing.
describe('isComplete Delete — normalisation and orphan visibility', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loggerModule = require('../../../src/handlers/shared/logger') as {
    logger: {
      info: (m: string, d?: Record<string, unknown>) => void;
      warn: (m: string, d?: Record<string, unknown>) => void;
    };
  };

  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => { /* silence */ });
    infoSpy = jest.spyOn(loggerModule.logger, 'info').mockImplementation(() => { /* silence */ });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test('passes the bare id to GetRegistry when given a full registry ARN', async () => {
    routeSend({ GetRegistry: () => ({ status: 'DELETING' }) });
    await isComplete({
      RequestType: 'Delete',
      PhysicalResourceId: ARN,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect((mockSend.mock.calls[0][0] as TaggedCommand).input.registryId).toBe(REGISTRY_ID);
  });

  test('warns (not infos) when skipping the delete, naming the registry', async () => {
    routeSend({});
    await expect(
      isComplete({
        RequestType: 'Delete',
        PhysicalResourceId: 'AWSCDK::CustomResourceProviderFramework::MISSING_PHYSICAL_ID',
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toEqual({ IsComplete: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ registryName: 'abca' });
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('treats a service-rejected id as complete rather than wedging the poll', async () => {
    routeSend({
      GetRegistry: () => {
        throw new ValidationException();
      },
    });
    await expect(
      isComplete({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toEqual({ IsComplete: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('onEvent Delete — orphan visibility', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loggerModule = require('../../../src/handlers/shared/logger') as {
    logger: {
      info: (m: string, d?: Record<string, unknown>) => void;
      warn: (m: string, d?: Record<string, unknown>) => void;
    };
  };

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => { /* silence */ });
    jest.spyOn(loggerModule.logger, 'info').mockImplementation(() => { /* silence */ });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('warns with the registry name when skipping the delete', async () => {
    routeSend({});
    await onEvent({
      RequestType: 'Delete',
      PhysicalResourceId: 'AWSCDK::CustomResourceProviderFramework::MISSING_PHYSICAL_ID',
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ registryName: 'abca' });
  });

  test('warns when the service rejects the id on the delete call', async () => {
    routeSend({
      DeleteRegistry: () => {
        throw new ValidationException();
      },
    });
    await onEvent({
      RequestType: 'Delete',
      PhysicalResourceId: REGISTRY_ID,
      ResourceProperties: { RegistryName: 'abca' },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
  // Companion to the onEvent no-op guard: the Provider polls isComplete after
  // onEvent, so a never-created registry must terminate here too rather than
  // reaching GetRegistry with a placeholder id.
  test('reports a never-created registry as already deleted without calling GetRegistry', async () => {
    routeSend({});
    await expect(
      isComplete({
        RequestType: 'Delete',
        PhysicalResourceId: 'AWSCDK::CustomResourceProviderFramework::MISSING_PHYSICAL_ID',
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toEqual({ IsComplete: true });
    expect(mockSend).not.toHaveBeenCalled();
  });

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
    expect(types).toEqual(['GetRegistry', 'ListRegistryRecords', 'DeleteRegistry']);
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

  // GetRegistry has just reported a registry when the delete re-driven behind it finds
  // none, or the service rejects the id. The later answer counts: the wait ends.
  test.each([
    ['finds the registry gone', ResourceNotFoundException],
    ['is rejected for its id', ValidationException],
  ])('is complete when a re-driven delete %s', async (_label, ErrorType) => {
    routeSend({
      GetRegistry: () => ({ status: 'READY' }),
      DeleteRegistry: () => {
        throw new ErrorType();
      },
    });
    await expect(
      isComplete({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).resolves.toEqual({ IsComplete: true });
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

  // Neither absent (not found, a rejected id) nor retryable: the delete has to fail
  // where it can be seen. Reported complete, a registry that may still exist would be
  // left behind; polled again, the Provider would wait out its 15 minutes.
  test('rethrows a GetRegistry failure that is neither absent nor retryable', async () => {
    routeSend({
      GetRegistry: () => {
        throw new Error('AccessDenied');
      },
    });
    await expect(
      isComplete({
        RequestType: 'Delete',
        PhysicalResourceId: REGISTRY_ID,
        ResourceProperties: { RegistryName: 'abca' },
      }),
    ).rejects.toThrow('AccessDenied');
    // The failed read is the last call: no delete is re-driven behind it.
    const types = mockSend.mock.calls.map((c) => (c[0] as TaggedCommand)._type);
    expect(types).toEqual(['GetRegistry']);
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

// AWS refuses DeleteRegistry with a ConflictException while the registry holds a record.
// The handler used to retry that refusal as if it would pass, and deleted no record: a
// stack whose registry held a published asset could not be deleted, and after 15 minutes
// of polling the Provider reported "Operation timed out".
describe('Delete of a registry that holds records', () => {
  const DELETE = {
    RequestType: 'Delete' as const,
    PhysicalResourceId: REGISTRY_ID,
    ResourceProperties: { RegistryName: 'abca' },
  };

  /**
   * Routes for a registry that answers as AWS does: DeleteRegistry is refused while a
   * record exists, and an accepted DeleteRegistry removes the registry.
   * @param records - ids of the records the registry holds; a deleted record leaves the list.
   * @param beforeDelete - runs before a record is deleted; when it throws, the record stays.
   * @returns the routes for `routeSend`.
   */
  function registryHolding(records: string[], beforeDelete: (recordId: unknown) => void = () => undefined) {
    let deleted = false;
    return {
      GetRegistry: () => {
        if (deleted) throw new ResourceNotFoundException();
        return { status: 'READY' };
      },
      ListRegistryRecords: () => ({ registryRecords: records.map((recordId) => ({ recordId })) }),
      DeleteRegistryRecord: ({ recordId }: Record<string, unknown>) => {
        beforeDelete(recordId);
        records.splice(records.indexOf(recordId as string), 1);
        return {};
      },
      DeleteRegistry: () => {
        if (records.length > 0) throw new ConflictException();
        deleted = true;
        return { status: 'DELETING' };
      },
    };
  }

  /** The commands sent so far, each with the record or the page it names. */
  function sent(): string[] {
    return mockSend.mock.calls.map((c) => {
      const { _type, input } = c[0] as TaggedCommand;
      return [_type, input.recordId ?? input.nextToken].filter(Boolean).join(' ');
    });
  }

  /**
   * Poll isComplete as the Provider's waiter does. It polls every 10 seconds and gives up
   * after 15 minutes (constructs/registry.ts), so 90 polls are what a delete can use.
   * @returns the number of polls it took.
   */
  async function pollsUntilDeleted(): Promise<number> {
    for (let poll = 1; poll <= 90; poll++) {
      if ((await isComplete(DELETE)).IsComplete) return poll;
    }
    throw new Error('the registry is still there after 90 polls: the Provider reports "Operation timed out"');
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('deletes the records, then the registry', async () => {
    routeSend(registryHolding(['rec1', 'rec2']));

    await onEvent(DELETE);

    expect(await pollsUntilDeleted()).toBe(1);
    expect(sent()).toEqual([
      'ListRegistryRecords', 'DeleteRegistryRecord rec1', 'DeleteRegistryRecord rec2', 'DeleteRegistry', 'GetRegistry',
    ]);
  });

  test('follows the record list to its last page', async () => {
    routeSend({
      ListRegistryRecords: jest.fn()
        .mockReturnValueOnce({ registryRecords: [{ recordId: 'rec1' }, { recordId: 'rec2' }], nextToken: 'page2' })
        .mockReturnValue({ registryRecords: [{ recordId: 'rec3' }] }),
      DeleteRegistryRecord: () => ({}),
      DeleteRegistry: () => ({ status: 'DELETING' }),
    });

    await onEvent(DELETE);

    expect(sent()).toEqual([
      'ListRegistryRecords', 'DeleteRegistryRecord rec1', 'DeleteRegistryRecord rec2',
      'ListRegistryRecords page2', 'DeleteRegistryRecord rec3', 'DeleteRegistry',
    ]);
  });

  // A record that is still being created or updated refuses its deletion.
  test('leaves a record that refuses deletion for the next poll', async () => {
    let creating = true;
    routeSend(registryHolding(['rec1', 'rec2'], (recordId) => {
      if (recordId === 'rec1' && creating) {
        creating = false;
        throw new ConflictException();
      }
    }));

    await onEvent(DELETE);

    expect(sent()).toEqual(['ListRegistryRecords', 'DeleteRegistryRecord rec1', 'DeleteRegistryRecord rec2', 'DeleteRegistry']);
    expect(await pollsUntilDeleted()).toBe(2);
  });

  test('skips a record that is already gone', async () => {
    routeSend({
      ListRegistryRecords: () => ({ registryRecords: [{ recordId: 'rec1' }, { recordId: 'rec2' }] }),
      DeleteRegistryRecord: ({ recordId }) => {
        if (recordId === 'rec1') throw new ResourceNotFoundException();
        return {};
      },
      DeleteRegistry: () => ({ status: 'DELETING' }),
    });

    await onEvent(DELETE);

    expect(sent()).toEqual(['ListRegistryRecords', 'DeleteRegistryRecord rec1', 'DeleteRegistryRecord rec2', 'DeleteRegistry']);
  });

  test('fails the delete when a record cannot be deleted for another reason', async () => {
    routeSend({
      ListRegistryRecords: () => ({ registryRecords: [{ recordId: 'rec1' }] }),
      DeleteRegistryRecord: () => {
        throw new Error('AccessDenied');
      },
    });

    await expect(onEvent(DELETE)).rejects.toThrow('AccessDenied');
  });

  // The record list is the first call to carry the registry id, so it is the one that
  // meets a registry that is gone or an id the service rejects. Like the same answers to
  // DeleteRegistry, none of them may fail the delete.
  test.each([
    ['not found: the registry is already gone', ResourceNotFoundException],
    ['a validation error: the service rejects the id', ValidationException],
    ['throttling', ThrottlingException],
  ])('does not fail when the record list answers %s', async (_label, ErrorType) => {
    routeSend({
      ListRegistryRecords: () => {
        throw new ErrorType();
      },
    });

    await expect(onEvent(DELETE)).resolves.toEqual({ PhysicalResourceId: REGISTRY_ID });
    expect(sent()).toEqual(['ListRegistryRecords']);
  });

  // The handler's Lambda is stopped after 60 seconds, and that would fail the delete at
  // once. Here every record takes that long, so one invocation has time for one record.
  test('stops deleting records when its time is up, and the next poll goes on', async () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    routeSend(registryHolding(['rec1', 'rec2', 'rec3'], () => {
      now += 60_000;
    }));

    await onEvent(DELETE);

    expect(sent()).toEqual(['ListRegistryRecords', 'DeleteRegistryRecord rec1', 'DeleteRegistry']);
    expect(await pollsUntilDeleted()).toBe(3);
  });
});
