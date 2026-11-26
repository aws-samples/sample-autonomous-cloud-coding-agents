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

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApi } from '../../app/providers/api/ApiProvider';
import type { ScoreboardRange } from '../../core/api/types';

const REFRESH_MS = 5 * 60_000;

/**
 * Your scoreboard for a range, read on mount and on window focus, and refreshed while
 * the page is open. While another range loads, the numbers on screen stay (`isPlaceholderData`).
 */
export function useScoreboard(range: ScoreboardRange) {
  const api = useApi();
  return useQuery({
    queryKey: ['tasks', 'scoreboard', range],
    queryFn: () => api.getScoreboard(range),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  });
}
