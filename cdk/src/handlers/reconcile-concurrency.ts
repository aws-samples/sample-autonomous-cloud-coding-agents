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

import { randomUUID } from 'node:crypto';
import { GetCommand, ScanCommand, type ScanCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from '../constructs/task-status';
import { logger } from './shared/logger';
import { workerLeaseKey } from './shared/microvm-continuation-types';
import { releaseTaskSlot, type ReservationTask } from './shared/task-concurrency';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const COUNTER_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME!;

interface CounterSnapshot {
  readonly user_id: string;
  readonly active_count?: number;
  readonly reservation_version?: string;
}

interface Reservations {
  held: number;
  ambiguous: boolean;
  terminal: string[];
}

/**
 * Read counters BEFORE scanning reservations. Every reservation mutation also
 * changes its counter revision; a conditional repair then detects changes
 * anywhere during the scan, including an increment/decrement with no net change.
 * Strong base-table reads avoid the GSI lag that can hide a newly held slot.
 */
export async function handler(): Promise<void> {
  logger.info('Concurrency reconciler started');
  const counters = new Map<string, CounterSnapshot>();
  let lastKey: Record<string, any> | undefined;
  do {
    const page: ScanCommandOutput = await ddb.send(new ScanCommand({
      TableName: COUNTER_TABLE,
      ConsistentRead: true,
      ProjectionExpression: 'user_id, active_count, reservation_version',
      ExclusiveStartKey: lastKey,
    }));
    for (const row of page.Items ?? []) {
      if (typeof row.user_id === 'string') counters.set(row.user_id, row as CounterSnapshot);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  const reservations = new Map<string, Reservations>();
  do {
    const page: ScanCommandOutput = await ddb.send(new ScanCommand({
      TableName: TASK_TABLE,
      ConsistentRead: true,
      ProjectionExpression: 'task_id, user_id, #status, concurrency_slot, continuation, microvm_start, session_id, repo',
      ExpressionAttributeNames: { '#status': 'status' },
      ExclusiveStartKey: lastKey,
    }));
    for (const row of page.Items ?? []) {
      const task = row as ReservationTask;
      if (!task.task_id || !task.user_id) continue;
      const active = ACTIVE_STATUSES.some(status => status === task.status);
      if (!task.concurrency_slot && !active) continue;
      const owned = reservations.get(task.user_id) ?? { held: 0, ambiguous: false, terminal: [] };
      let parked = false;
      if (task.status === 'AWAITING_APPROVAL' && task.concurrency_slot?.state === 'released'
        && row.continuation?.state === 'PARKED') {
        const saved = await ddb.send(new GetCommand({
          TableName: TASK_TABLE, Key: workerLeaseKey(task.task_id), ConsistentRead: true,
        }));
        parked = saved.Item?.lease_state === 'PARKED'
          && saved.Item.lease_attempt_id === row.microvm_start?.clientToken
          && saved.Item.lease_user_id === task.user_id && saved.Item.lease_repo === (row.repo ?? '')
          && saved.Item.lease_microvm_id === row.session_id;
      }
      if (task.concurrency_slot?.state === 'held') {
        // Terminal tasks still own their seat until release commits. Repair
        // that total first, then release terminal reservations through the
        // same transaction used by the orchestrator and stranded-task cleaner.
        owned.held++;
        if (TERMINAL_STATUSES.some(status => status === task.status)) owned.terminal.push(task.task_id);
      } else if ((active && !parked) || (task.concurrency_slot && task.concurrency_slot.state !== 'released')) {
        // Older active tasks and not-yet-admitted SUBMITTED tasks cannot be
        // distinguished by status. Wait for them to settle; never guess a count.
        owned.ambiguous = true;
      }
      reservations.set(task.user_id, owned);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  let corrected = 0;
  let errors = 0;
  const users = new Set([...counters.keys(), ...reservations.keys()]);
  for (const userId of users) {
    const snapshot = counters.get(userId);
    const owned = reservations.get(userId) ?? { held: 0, ambiguous: false, terminal: [] };
    try {
      const stored = snapshot?.active_count ?? 0;
      if (!Number.isSafeInteger(stored)) throw new Error('Concurrency counter is not an integer');
      if (owned.ambiguous) {
        logger.warn('Skipping capacity repair while task reservation ownership is ambiguous', {
          user_id: userId, error_id: 'CONCURRENCY_RESERVATION_UNKNOWN',
        });
      } else if (stored !== owned.held) {
        const conditions: string[] = [];
        const values: Record<string, unknown> = {
          ':count': owned.held, ':now': new Date().toISOString(), ':version': randomUUID(),
        };
        if (!snapshot) {
          conditions.push('attribute_not_exists(user_id)');
        } else {
          conditions.push('attribute_exists(user_id)');
          if (snapshot.active_count === undefined) {conditions.push('attribute_not_exists(active_count)');} else {
            conditions.push('active_count = :stored');
            values[':stored'] = stored;
          }
          if (snapshot.reservation_version === undefined) {conditions.push('attribute_not_exists(reservation_version)');} else {
            conditions.push('reservation_version = :observed');
            values[':observed'] = snapshot.reservation_version;
          }
        }
        try {
          await ddb.send(new UpdateCommand({
            TableName: COUNTER_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET active_count = :count, updated_at = :now, reservation_version = :version',
            ConditionExpression: conditions.join(' AND '),
            ExpressionAttributeValues: values,
          }));
          corrected++;
          logger.info('Corrected capacity counter from saved reservations', {
            user_id: userId, stored_count: stored, reservation_count: owned.held,
          });
        } catch (error) {
          if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
          logger.info('Capacity changed during reconciliation; skipped stale repair', { user_id: userId });
        }
      }
      for (const taskId of owned.terminal) await releaseTaskSlot(taskId, userId);
    } catch (error) {
      errors++;
      logger.warn('Per-user capacity reconciliation failed, continuing', { user_id: userId, error: String(error) });
    }
  }
  if (errors === users.size && users.size > 0) {
    logger.error('All users failed reconciliation — possible systemic issue', { scanned: users.size, errors });
  }
  logger.info('Concurrency reconciler finished', { scanned: users.size, corrected, errors });
}
