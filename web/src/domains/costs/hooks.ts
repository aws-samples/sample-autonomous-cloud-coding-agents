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

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useApi } from '../../app/providers/api/ApiProvider';

/** Enough history for a month of costs without unbounded paging. */
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const REFRESH_MS = 60_000;

/** Your tasks, up to MAX_PAGES pages, loaded automatically for the cost rollups. */
export function useCostTasks() {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ['tasks', 'list', 'costs'],
    queryFn: ({ pageParam }) => api.listTasks({ limit: PAGE_SIZE, nextToken: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last, pages) =>
      pages.length < MAX_PAGES && last.pagination.has_more && last.pagination.next_token ? last.pagination.next_token : undefined,
    refetchInterval: REFRESH_MS,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const lastPage = query.data?.pages.at(-1);
  return {
    query,
    tasks: query.data?.pages.flatMap((p) => p.data) ?? [],
    /** True when older tasks exist beyond what was loaded. */
    truncated: (query.data?.pages.length ?? 0) >= MAX_PAGES && (lastPage?.pagination.has_more ?? false),
  };
}

export function useMyBudget() {
  const api = useApi();
  return useQuery({ queryKey: ['budget', 'me'], queryFn: () => api.getMyBudget(), refetchInterval: REFRESH_MS });
}
