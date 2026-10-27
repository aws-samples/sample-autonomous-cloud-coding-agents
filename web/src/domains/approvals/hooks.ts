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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/providers/api/ApiProvider';

/** Approval requests time out in minutes, so the inbox refreshes faster than the task list. */
const PENDING_REFRESH_MS = 10_000;

const approvalKeys = {
  pending: ['approvals', 'pending'] as const,
};

export function usePendingApprovals() {
  const api = useApi();
  return useQuery({
    queryKey: approvalKeys.pending,
    queryFn: () => api.listPending(),
    refetchInterval: PENDING_REFRESH_MS,
  });
}

export type Decision = { readonly kind: 'approve' } | { readonly kind: 'deny'; readonly reason?: string };

export function useDecide(taskId: string, requestId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: Decision) => (decision.kind === 'approve'
      ? api.approve(taskId, requestId)
      : api.deny(taskId, requestId, decision.reason)),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: approvalKeys.pending });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
