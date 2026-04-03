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

const mockAdmissionControl = jest.fn();

jest.mock('../../../src/handlers/shared/orchestrator', () => ({
  admissionControl: (...args: unknown[]) => mockAdmissionControl(...args),
}));

import { handler } from '../../../src/handlers/sfn-steps/admission-control';
import type { BlueprintConfig } from '../../../src/handlers/shared/repo-config';
import type { TaskRecord } from '../../../src/handlers/shared/types';

const TASK: TaskRecord = {
  task_id: 'task-1',
  user_id: 'user-1',
  status: 'SUBMITTED',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'SUBMITTED#2025-03-15T10:00:00Z',
  created_at: '2025-03-15T10:00:00Z',
  updated_at: '2025-03-15T10:00:00Z',
};

const BLUEPRINT: BlueprintConfig = {
  compute_type: 'fargate',
  runtime_arn: 'arn:aws:bedrock:us-east-1:123456789012:runtime/test',
};

beforeEach(() => jest.resetAllMocks());

test('returns admitted=true when under concurrency limit', async () => {
  mockAdmissionControl.mockResolvedValue(true);

  const result = await handler({ task: TASK, blueprintConfig: BLUEPRINT });

  expect(mockAdmissionControl).toHaveBeenCalledWith(TASK);
  expect(result).toEqual({ admitted: true, concurrencyAcquired: true, task: TASK, blueprintConfig: BLUEPRINT });
});

test('returns admitted=false when concurrency limit reached', async () => {
  mockAdmissionControl.mockResolvedValue(false);

  const result = await handler({ task: TASK, blueprintConfig: BLUEPRINT });

  expect(mockAdmissionControl).toHaveBeenCalledWith(TASK);
  expect(result).toEqual({ admitted: false, concurrencyAcquired: false, task: TASK, blueprintConfig: BLUEPRINT });
});
