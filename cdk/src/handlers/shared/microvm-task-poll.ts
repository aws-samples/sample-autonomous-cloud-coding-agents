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

const RETIREMENT_EVENT_TIMEOUT_MS = 3000;
import { formatMicrovmTerminalFailure } from './error-classifier';
import { logger } from './logger';
import { retireCheckpointedMicrovm, type RetirementResult } from './microvm-continuation-retirement';
import { microvmErrorIdentity } from './microvm-control';
import { MICROVM_SUPERVISOR_CYCLE_MS, superviseMicrovm, type MicrovmSupervisorInput } from './microvm-supervisor';
import type { PollState } from './orchestrator';
import { TaskStatus } from '../../constructs/task-status';

function retirementState(state: PollState, result: RetirementResult): PollState | undefined {
  if (result === 'not-due') return undefined;
  return {
    attempts: state.attempts + 1,
    lastStatus: TaskStatus.AWAITING_APPROVAL,
    microvmSupervisor: state.microvmSupervisor,
    microvmParked: result === 'parked',
    microvmRetiring: result === 'stopping',
    microvmOwnershipLost: result === 'ownership-lost',
  };
}

async function retirementCycle(
  input: Omit<MicrovmSupervisorInput, 'previous'>, state: PollState, force = false,
): Promise<PollState | undefined> {
  try {
    const retirement = await retireCheckpointedMicrovm({
      ...input, sessionDeadlineMs: state.microvmSupervisor?.sessionDeadlineMs ?? Infinity, force,
    });
    return retirementState(state, retirement);
  } catch (error) {
    // Fencing/termination may have committed before a lost reply. Keep the
    // reservation held and retry the persisted transition; never resume tools
    // or mark the task complete based on an uncertain control outcome.
    const identity = microvmErrorIdentity(error);
    logger.warn('MicroVM continuation retirement needs reconciliation', {
      task_id: input.taskId, microvm_id: input.handle.microvmId, ...identity,
    });
    if (state.microvmRetirementError !== identity.error_type) {
      try {
        await input.emitEvent?.('continuation_retirement_delayed', {
          microvm_id: input.handle.microvmId,
          error_id: identity.error_type,
          detail: 'The saved task is waiting for worker shutdown or storage confirmation. Its capacity reservation remains held.',
        }, { abortSignal: AbortSignal.timeout(RETIREMENT_EVENT_TIMEOUT_MS) });
      } catch (eventError) {
        logger.warn('Could not publish continuation reconciliation feedback', {
          task_id: input.taskId, ...microvmErrorIdentity(eventError),
        });
      }
    }
    return {
      attempts: state.attempts + 1,
      lastStatus: state.lastStatus,
      microvmSupervisor: state.microvmSupervisor,
      microvmRetiring: true,
      microvmRetirementError: identity.error_type,
    };
  }
}

/** Shared by initial and replacement durable executions. Never follow another handle. */
export async function pollMicrovmTask(input: Omit<MicrovmSupervisorInput, 'previous'>, state: PollState): Promise<PollState> {
  const timeout = AbortSignal.timeout(MICROVM_SUPERVISOR_CYCLE_MS);
  input = { ...input, abortSignal: input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout };
  const retiring = await retirementCycle(input, state);
  if (retiring) return retiring;
  const supervised = await superviseMicrovm({ ...input, previous: state.microvmSupervisor });
  if (supervised.kind === 'substrate-terminal' || supervised.kind === 'failure') {
    // A complete pending checkpoint can outlive a dead worker. No tool ran
    // beyond that barrier, and the original human request/decision is retained.
    const recovered = await retirementCycle(input, { ...state, microvmSupervisor: supervised.state }, true);
    if (recovered) return recovered;
  }
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
