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

import { formatMicrovmTerminalFailure } from '../error-classifier';
import { MICROVM_SUPERVISOR_CYCLE_MS, superviseMicrovm, type MicrovmSupervisorInput } from './supervisor';
import type { PollState } from '../orchestrator';

/** One bounded supervisor cycle mapped onto the orchestrator's poll state. */
export async function pollMicrovmTask(input: Omit<MicrovmSupervisorInput, 'previous'>, state: PollState): Promise<PollState> {
  const timeout = AbortSignal.timeout(MICROVM_SUPERVISOR_CYCLE_MS);
  input = { ...input, abortSignal: input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout };
  const supervised = await superviseMicrovm({ ...input, previous: state.microvmSupervisor });
  const failure = supervised.kind === 'failure' ? supervised.reason
    : supervised.kind === 'substrate-terminal' ? 'substrate-terminal' : undefined;
  return {
    attempts: state.attempts + 1,
    lastStatus: supervised.snapshot?.status ?? state.lastStatus,
    sessionUnhealthy: supervised.heartbeatUnhealthy,
    microvmSupervisor: supervised.state,
    microvmFailureReason: failure,
    microvmFailureMessage: supervised.kind === 'substrate-terminal' ? formatMicrovmTerminalFailure(
      `substrate state ${supervised.substrate!.status}`, supervised.substrate!.reason,
    ) : undefined,
    microvmOwnershipLost: supervised.kind === 'ownership-lost',
  };
}
