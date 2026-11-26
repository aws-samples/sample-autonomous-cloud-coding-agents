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
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
} from '@aws-sdk/client-lambda-microvms';
import { CAPABILITY_CATALOG } from './deployment-capabilities';
import { CliError } from './errors';
import { makeClient } from './ua';

interface LambdaMicrovmProbeClient {
  send(command: ListManagedMicrovmImagesCommand): Promise<unknown>;
}

export type LambdaMicrovmProbeClientFactory = (region: string) => LambdaMicrovmProbeClient;

export const LAMBDA_MICROVM_REMEDY =
  `Launch regions: ${CAPABILITY_CATALOG.compute['lambda-microvm'].regions?.join(', ')}. `
  + 'Use --compute-type agentcore or --compute-type ecs in other regions.';

export async function probeLambdaMicrovmAvailability(
  region: string,
  clientFactory: LambdaMicrovmProbeClientFactory =
    (clientRegion) => makeClient(LambdaMicrovmsClient, { region: clientRegion }),
): Promise<void> {
  const client = clientFactory(region);
  await client.send(new ListManagedMicrovmImagesCommand({}));
}

/** Probe and convert any SDK/endpoint failure into an operator-actionable error. */
export async function requireLambdaMicrovmAvailability(
  region: string,
  clientFactory?: LambdaMicrovmProbeClientFactory,
): Promise<void> {
  try {
    await probeLambdaMicrovmAvailability(region, clientFactory);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Lambda MicroVMs availability probe failed in ${region}: ${message}. ${LAMBDA_MICROVM_REMEDY}`,
    );
  }
}
