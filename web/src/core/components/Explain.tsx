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

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tooltip from '@cloudscape-design/components/tooltip';
import { useEffect, useId, useRef, useState, type HTMLAttributes, type PointerEvent, type ReactNode } from 'react';
import { aboutLabel } from '../util/format';

/** What a metric, or a part of a graph, says about itself. */
export interface Explanation {
  /** One sentence a newcomer understands: what is counted. */
  readonly what: string;
  /** The decision it informs: which way is good, what it trades against, where to look next. */
  readonly why: string;
  /** The formula in words with its population, then what the number does not see. */
  readonly how: string;
}

const QUESTIONS: readonly (readonly [keyof Explanation, string])[] = [
  ['what', 'What it is'],
  ['why', 'Why it matters'],
  ['how', "How it's computed"],
];

const OPEN_AFTER_MS = 250;
const CLOSE_AFTER_MS = 120;
const OPENED = 'abca-explain-opened';

/**
 * The hover target of an explanation and its bubble: what it is, why it matters, how it
 * is computed. The bubble opens when the pointer rests anywhere on the target; the "i"
 * button is the way in for a keyboard and for a finger (focus or a tap opens; Escape,
 * blur or a second tap closes). The bubble stands outside the target, above it where
 * there is room.
 */
export function Explain({ title, explanation, summary, as: Target = 'div', children, ...attributes }: {
  /** The bubble's title: the label of what it explains. */
  title: string;
  explanation: Explanation;
  /** A line under the title: for a part of a graph, its number. */
  summary?: string;
  /** The element of the target: a `span` where a block cannot stand, as beside a heading. */
  as?: 'div' | 'span';
} & (
  /** What is explained, given the "i" button to put beside its label; */
  | { children: (icon: ReactNode) => ReactNode }
  /** or, with no "i", a target that takes the focus itself: never an explanation for the pointer alone. */
  | { children?: ReactNode; tabIndex: 0 }
) & Pick<HTMLAttributes<HTMLElement>, 'role' | 'aria-label' | 'style'>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const target = useRef<HTMLDivElement & HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef(false);
  const resting = useRef(false);
  const focused = useRef(false);
  const openAtPress = useRef<boolean | null>(null);

  const show = (next: boolean, afterMs = 0) => {
    clearTimeout(timer.current);
    resting.current = false;
    if (afterMs === 0) setOpen(next);
    else {
      timer.current = setTimeout(() => {
        resting.current = false;
        setOpen(next);
      }, afterMs);
    }
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return undefined;
    document.dispatchEvent(new Event(OPENED));
    const closeForAnother = () => setOpen(false);
    document.addEventListener(OPENED, closeForAnother);
    const element = target.current;
    return () => {
      document.removeEventListener(OPENED, closeForAnother);
      // A bubble that closes under the pointer sends no leave.
      hovered.current &&= Boolean(element?.matches(':hover'));
    };
  }, [open]);

  const hover = (over: boolean, event: PointerEvent) => {
    if (event.pointerType === 'touch' || (over === hovered.current && !(over && resting.current))) return;
    hovered.current = over;
    if (over) {
      show(true, OPEN_AFTER_MS);
      resting.current = true;
    } else if (focused.current) {
      clearTimeout(timer.current);
    } else {
      show(false, CLOSE_AFTER_MS);
    }
  };
  const focus = {
    onFocus: () => {
      focused.current = true;
      show(true);
    },
    onBlur: () => {
      focused.current = false;
      if (!hovered.current) show(false);
    },
  };
  const description = `${id}-description`;

  const icon = typeof children === 'function' && (
    <>
      {/*
        The name is not the button's `ariaLabel`: Cloudscape repeats that as a `title`, a second bubble on hover.
        It is one piece of text: Chrome joins the pieces of a hidden name with spaces.
      */}
      <span id={`${id}-name`} hidden>{aboutLabel(title)}</span>
      {/* The handlers are on a wrapper: given a focus handler, Cloudscape's button goes on to call one of its own that is not there. */}
      <span
        {...focus}
        onPointerDown={() => {
          openAtPress.current = open && (focused.current || !hovered.current);
        }}
        onKeyDown={() => {
          openAtPress.current = null;
        }}
      >
        <Button
          variant="inline-icon"
          iconName="status-info"
          formAction="none"
          ariaDescribedby={description}
          nativeButtonAttributes={{ 'aria-labelledby': `${id}-name` }}
          onClick={() => {
            show(!(openAtPress.current ?? open));
            openAtPress.current = null;
          }}
        />
      </span>
    </>
  );

  return (
    <Target
      ref={target}
      {...attributes}
      {...(icon ? {} : { ...focus, 'aria-describedby': description })}
      onPointerMove={(event) => hover(true, event)}
      onPointerLeave={(event) => hover(false, event)}
    >
      <span id={description} hidden>{QUESTIONS.map(([question, label]) => `${label}: ${explanation[question]}`).join(' ')}</span>
      {typeof children === 'function' ? children(icon) : children}
      {open && (
        <Tooltip
          getTrack={() => target.current}
          onEscape={() => show(false)}
          content={(
            <SpaceBetween size="xs">
              <Box fontWeight="bold">{title}</Box>
              {summary && <Box color="text-body-secondary">{summary}</Box>}
              {QUESTIONS.map(([question, label]) => (
                <div key={question}>
                  <Box fontSize="body-s" fontWeight="bold" color="text-body-secondary">{label}</Box>
                  <Box fontSize="body-s">{explanation[question]}</Box>
                </div>
              ))}
            </SpaceBetween>
          )}
        />
      )}
    </Target>
  );
}
