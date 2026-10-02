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

// SPDX-License-Identifier: MIT-0

import type { GetMicrovmImageVersionOutput } from '@aws-sdk/client-lambda-microvms';
import sharedConstants from '../../../../contracts/constants.json';

export const MICROVM_LIFECYCLE_PROTOCOL = String(sharedConstants.microvm_lifecycle.protocol_version);
export const MICROVM_IMAGE_PROTOCOL_ENV = sharedConstants.microvm_lifecycle.image_protocol_env;
// Optional discovery/enrichment must not hold up an already registered worker.
export const MICROVM_IMAGE_CAPABILITY_REQUEST_TIMEOUT_MS = 3_000;
const MAX_IMAGE_IDENTITY_LENGTH = 2048;

/** Coordinator-owned evidence for the image version that actually launched a VM. */
export interface MicrovmImageMetadata {
  readonly imageArn?: string;
  readonly imageVersion?: string;
  readonly lifecycleProtocol?: string;
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IMAGE_IDENTITY_LENGTH
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Legacy or malformed identity never acquires capability from deployment settings. */
export function readMicrovmImageMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const metadata = value as MicrovmImageMetadata;
  if (!nonblank(metadata.imageArn) || !nonblank(metadata.imageVersion)) return {};
  return {
    imageArn: metadata.imageArn,
    imageVersion: metadata.imageVersion,
    ...(metadata.lifecycleProtocol === MICROVM_LIFECYCLE_PROTOCOL
      && { lifecycleProtocol: MICROVM_LIFECYCLE_PROTOCOL }),
  };
}

export function supportsMicrovmLifecycle(value: unknown): boolean {
  return readMicrovmImageMetadata(value).lifecycleProtocol === MICROVM_LIFECYCLE_PROTOCOL;
}

/** Check the exact immutable version returned by Run, never a latest-version alias. */
export function verifyMicrovmImageLifecycle(
  identity: Required<Pick<MicrovmImageMetadata, 'imageArn' | 'imageVersion'>>,
  version: Pick<GetMicrovmImageVersionOutput, 'imageArn' | 'imageVersion' | 'hooks' | 'environmentVariables'>,
): boolean {
  const hooks = version.hooks;
  const runtime = hooks?.microvmHooks;
  const timeout = sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds;
  return version.imageArn === identity.imageArn
    && version.imageVersion === identity.imageVersion
    && version.environmentVariables?.[MICROVM_IMAGE_PROTOCOL_ENV] === MICROVM_LIFECYCLE_PROTOCOL
    && hooks?.port === sharedConstants.microvm_lifecycle.hook_port
    && hooks.microvmImageHooks?.ready === 'ENABLED'
    && hooks.microvmImageHooks?.validate === 'ENABLED'
    && runtime?.run === 'ENABLED'
    && runtime.terminate === 'ENABLED'
    && runtime.suspend === 'ENABLED'
    && runtime.resume === 'ENABLED'
    && Number.isInteger(runtime.suspendTimeoutInSeconds)
    && runtime.suspendTimeoutInSeconds! >= timeout
    && Number.isInteger(runtime.resumeTimeoutInSeconds)
    && runtime.resumeTimeoutInSeconds! >= timeout;
}
