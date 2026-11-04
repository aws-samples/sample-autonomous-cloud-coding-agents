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

import Button, { type ButtonProps } from '@cloudscape-design/components/button';
import { useNavigate } from 'react-router';

export interface NewTaskPrefill {
  readonly repo?: string | null;
  readonly issue?: number | null;
  readonly description?: string | null;
  readonly maxTurns?: number | null;
  readonly maxBudgetUsd?: number | null;
  readonly trace?: boolean;
}

/** `/tasks/new` with the form pre-filled, e.g. from a repository page or "Try again". */
function newTaskHref(prefill: NewTaskPrefill = {}): string {
  const query = new URLSearchParams();
  if (prefill.repo) query.set('repo', prefill.repo);
  if (prefill.issue) query.set('issue', String(prefill.issue));
  if (prefill.description) query.set('description', prefill.description);
  if (prefill.maxTurns) query.set('max_turns', String(prefill.maxTurns));
  if (prefill.maxBudgetUsd) query.set('max_budget_usd', String(prefill.maxBudgetUsd));
  if (prefill.trace) query.set('trace', '1');
  const qs = query.toString();
  return `/tasks/new${qs ? `?${qs}` : ''}`;
}

export function NewTaskButton({ prefill, variant = 'primary', label = 'New task' }: {
  prefill?: NewTaskPrefill;
  variant?: ButtonProps.Variant;
  label?: string;
}) {
  const navigate = useNavigate();
  const href = newTaskHref(prefill);
  return (
    <Button
      variant={variant}
      href={href}
      onFollow={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {label}
    </Button>
  );
}
