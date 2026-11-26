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

import {
  BedrockAgentCoreControlClient,
  ConflictException,
  CreateWorkloadIdentityCommand,
  DeleteWorkloadIdentityCommand,
  GetWorkloadIdentityCommand,
  ResourceNotFoundException,
  UpdateWorkloadIdentityCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { logger } from '../shared/logger';
import { makeClient } from '../shared/ua';

interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: {
    readonly WorkloadName: string;
    readonly AllowedReturnUrls?: string;
  };
}
interface OnEventResponse {
  readonly PhysicalResourceId?: string;
  readonly Data?: Record<string, string>;
}

const client = makeClient(BedrockAgentCoreControlClient);

function parseReturnUrls(raw?: string): string[] {
  const refuse = (reason: string): never => {
    throw new Error(
      `AllowedReturnUrls ${reason} — refusing to provision a workload identity with no `
      + 'consent-callback allowlist, which would fail every consent',
    );
  };
  if (raw === undefined) return refuse('is missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return refuse(`is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === 'string')) {
    return refuse('is not a JSON array of strings');
  }
  return parsed;
}

/**
 * AgentCore reports a duplicate name as a `ValidationException`
 * ("WorkloadIdentity with name '<name>' already exists."), not a
 * `ConflictException`.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (err instanceof ConflictException) return true;
  const name = (err as { name?: string } | undefined)?.name;
  const message = (err as { message?: string } | undefined)?.message ?? '';
  return name === 'ValidationException' && /already exists/i.test(message);
}

async function upsertWorkloadIdentity(name: string, returnUrls: string[]): Promise<void> {
  try {
    await client.send(
      new CreateWorkloadIdentityCommand({
        name,
        allowedResourceOauth2ReturnUrls: returnUrls,
      }),
    );
    logger.info('Created workload identity', { name, returnUrlCount: returnUrls.length });
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      await client.send(
        new UpdateWorkloadIdentityCommand({
          name,
          allowedResourceOauth2ReturnUrls: returnUrls,
        }),
      );
      logger.info('Workload identity existed; updated return-URL allowlist', {
        name,
        returnUrlCount: returnUrls.length,
      });
      return;
    }
    throw err;
  }
}

// AgentCore creates and deletes a workload identity synchronously (observed),
// so there is no `isComplete` poller.
export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  const name = event.ResourceProperties.WorkloadName;
  logger.info('Linear identity provisioning event', { requestType: event.RequestType, name });

  switch (event.RequestType) {
    case 'Create':
    case 'Update': {
      const returnUrls = parseReturnUrls(event.ResourceProperties.AllowedReturnUrls);
      await upsertWorkloadIdentity(name, returnUrls);
      // CloudFormation treats an Update that returns another PhysicalResourceId as a replacement.
      return { PhysicalResourceId: name, Data: { WorkloadName: name } };
    }
    case 'Delete': {
      try {
        await client.send(new DeleteWorkloadIdentityCommand({ name }));
        logger.info('Deleted workload identity', { name });
      } catch (err) {
        if (err instanceof ResourceNotFoundException) {
          logger.info('Workload identity already absent on delete', { name });
        } else {
          throw err;
        }
      }
      return { PhysicalResourceId: event.PhysicalResourceId ?? name };
    }
  }
}

export async function workloadIdentityExists(name: string): Promise<boolean> {
  try {
    await client.send(new GetWorkloadIdentityCommand({ name }));
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
}
