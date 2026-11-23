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

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Explain, type Explanation } from '../../../src/core/components/Explain';
import { bubbleText } from '../../helpers/explanations';

const WAITED = {
  what: 'The share of your tasks that could not start right away.',
  why: 'Waiting adds to every time on this page.',
  how: 'Tasks that waited in the queue, divided by tasks that waited or started.',
};
const HELD = {
  what: 'The share of tasks that paused to ask before a sensitive action.',
  why: 'Too high makes people the bottleneck.',
  how: 'Tasks that made an approval request, divided by the tasks that ran.',
};

/** A metric as a tile draws it: all of it is the hover target, and the "i" stands beside its label. */
function renderMetric() {
  const view = render(
    <Explain title="Waited in line" explanation={WAITED} data-testid="metric">
      {(icon) => <>Waited in line {icon} 8%</>}
    </Explain>,
  );
  return { ...view, metric: screen.getByTestId('metric'), icon: screen.getByRole('button', { name: 'About waited in line' }) };
}

const bubble = () => screen.queryByRole('tooltip');

/** What a screen reader says after the name: each question and its answer, and nothing else. */
const described = ({ what, why, how }: Explanation) => `What it is: ${what} Why it matters: ${why} How it's computed: ${how}`;

function pass(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** The pointer comes to rest on `target` and stays until its bubble is open. */
function rest(target: HTMLElement): void {
  fireEvent.pointerMove(target);
  pass(250);
}

/** For the next 400 ms, in steps of 10: the bubble is on screen all the time, or never. */
function staysFor400ms(shown: boolean): void {
  for (let ms = 0; ms < 400; ms += 10) {
    pass(10);
    expect(bubble() !== null).toBe(shown);
  }
}

describe('Explain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('under a pointer', () => {
    it('opens when the pointer has rested on the target, and not before', () => {
      const { metric } = renderMetric();
      fireEvent.pointerMove(metric);
      pass(249);
      expect(bubble()).not.toBeInTheDocument();
      pass(1);
      expect(bubble()?.textContent).toBe(bubbleText('Waited in line', WAITED));
    });

    it('waits for the pointer to rest: every move starts the wait again', () => {
      const { metric } = renderMetric();
      fireEvent.pointerMove(metric);
      pass(200);
      fireEvent.pointerMove(metric);
      pass(200);
      expect(bubble()).not.toBeInTheDocument();
      pass(50);
      expect(bubble()).toBeInTheDocument();
    });

    it('opens nothing for a target that comes under a pointer at rest: the page scrolled, or a bubble closed over it', () => {
      const { metric } = renderMetric();
      fireEvent.pointerEnter(metric);
      pass(1000);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('never shows the bubble of a pointer on its way across the page, not even for a moment', () => {
      const { metric } = renderMetric();
      fireEvent.pointerMove(metric);
      pass(200);
      fireEvent.pointerLeave(metric);
      staysFor400ms(false);
    });

    it('opens for a pointer that comes back and rests, after one that only passed', () => {
      const { metric } = renderMetric();
      fireEvent.pointerMove(metric);
      pass(100);
      fireEvent.pointerLeave(metric);
      pass(500);
      rest(metric);
      expect(bubble()).toBeInTheDocument();
    });

    it('closes shortly after the pointer has left', () => {
      const { metric } = renderMetric();
      rest(metric);
      fireEvent.pointerLeave(metric);
      pass(119);
      expect(bubble()).toBeInTheDocument();
      pass(1);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('stays open without a break while the pointer crosses onto the bubble, until it leaves the bubble too', () => {
      const { metric } = renderMetric();
      rest(metric);
      fireEvent.pointerLeave(metric);
      pass(100);
      fireEvent.pointerMove(screen.getByRole('tooltip'));
      staysFor400ms(true);

      fireEvent.pointerLeave(screen.getByRole('tooltip'));
      pass(120);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('does not open under a finger, which has the "i"', () => {
      const { metric } = renderMetric();
      fireEvent.pointerMove(metric, { pointerType: 'touch' });
      pass(1000);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('is not closed by a finger that touches the target and lifts while the mouse rests on it', () => {
      const { metric } = renderMetric();
      rest(metric);
      // A finger does not hover, on its way out either: on a touch screen, a scroll that starts on the tile.
      fireEvent.pointerMove(metric, { pointerType: 'touch' });
      fireEvent.pointerLeave(metric, { pointerType: 'touch' });
      pass(1000);
      expect(bubble()).toBeInTheDocument();
    });
  });

  describe('with the focus', () => {
    it('opens at once when the "i" takes the focus, and closes when the focus leaves', () => {
      const { icon } = renderMetric();
      fireEvent.focus(icon);
      expect(bubble()?.textContent).toBe(bubbleText('Waited in line', WAITED));

      fireEvent.blur(icon);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('opens at once on focus while the pointer is on its way out, and stays', () => {
      const { metric, icon } = renderMetric();
      rest(metric);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.pointerLeave(metric);
      pass(60);
      fireEvent.focus(icon);
      pass(1000);
      expect(bubble()).toBeInTheDocument();
    });

    it('keeps the bubble of a focused "i" while the pointer comes and goes', () => {
      const { metric, icon } = renderMetric();
      fireEvent.focus(icon);
      fireEvent.pointerMove(metric);
      fireEvent.pointerLeave(metric);
      pass(1000);
      expect(bubble()).toBeInTheDocument();

      fireEvent.blur(icon);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('opens nothing for a pointer that only passes while the "i" has the focus and its bubble was closed', () => {
      const { metric, icon } = renderMetric();
      fireEvent.focus(icon);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.pointerMove(metric);
      pass(100);
      fireEvent.pointerLeave(metric);
      staysFor400ms(false);
    });

    it('closes on Escape', () => {
      const { icon } = renderMetric();
      fireEvent.focus(icon);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(bubble()).not.toBeInTheDocument();
    });

    it('closes on blur once the pointer has been on the target and has left', () => {
      const { metric, icon } = renderMetric();
      rest(metric);
      fireEvent.pointerLeave(metric);
      pass(120);
      fireEvent.focus(icon);
      fireEvent.blur(icon);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('closes on blur after a bubble was closed under the pointer, which sends no leave', () => {
      const { metric, icon } = renderMetric();
      rest(metric);
      fireEvent.pointerLeave(metric);
      fireEvent.pointerMove(screen.getByRole('tooltip'));
      // Escape removes the bubble from under the pointer: the browser reports no leave for it.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(bubble()).not.toBeInTheDocument();

      fireEvent.focus(icon);
      expect(bubble()).toBeInTheDocument();
      fireEvent.blur(icon);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('stays open when a press on its text takes the focus from the "i"', () => {
      const { icon } = renderMetric();
      fireEvent.focus(icon);
      fireEvent.pointerMove(screen.getByRole('tooltip'));
      fireEvent.blur(icon);
      expect(bubble()).toBeInTheDocument();

      fireEvent.pointerLeave(screen.getByRole('tooltip'));
      pass(120);
      expect(bubble()).not.toBeInTheDocument();
    });
  });

  describe('on a press of the "i"', () => {
    it('opens on a tap and closes on the next', () => {
      const { metric, icon } = renderMetric();
      fireEvent.pointerMove(metric, { pointerType: 'touch' });
      // The first tap gives the "i" the focus, which opens the bubble before the click arrives.
      fireEvent.pointerDown(icon, { pointerType: 'touch' });
      fireEvent.focus(icon);
      fireEvent.click(icon);
      expect(bubble()).toBeInTheDocument();

      fireEvent.pointerDown(icon, { pointerType: 'touch' });
      fireEvent.click(icon);
      expect(bubble()).not.toBeInTheDocument();

      fireEvent.pointerDown(icon, { pointerType: 'touch' });
      fireEvent.click(icon);
      expect(bubble()).toBeInTheDocument();
    });

    it('closes on the second tap where a tap does not give the "i" the focus, as on an iPhone', () => {
      const { icon } = renderMetric();
      fireEvent.pointerDown(icon, { pointerType: 'touch' });
      fireEvent.click(icon);
      expect(bubble()).toBeInTheDocument();

      // Neither the focus nor a pointer holds this bubble: nothing else would close it there.
      fireEvent.pointerDown(icon, { pointerType: 'touch' });
      fireEvent.click(icon);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('closes and opens again when the focused "i" is pressed from the keyboard', () => {
      const { icon } = renderMetric();
      fireEvent.focus(icon);
      fireEvent.click(icon);
      expect(bubble()).not.toBeInTheDocument();
      fireEvent.click(icon);
      expect(bubble()).toBeInTheDocument();
    });

    it('toggles from the keyboard after a press of the pointer that ended in no click', () => {
      const { icon } = renderMetric();
      fireEvent.focus(icon);
      // Pressed on the "i" and released elsewhere: no click follows.
      fireEvent.pointerDown(icon);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(bubble()).not.toBeInTheDocument();

      fireEvent.keyDown(icon, { key: 'Enter' });
      fireEvent.click(icon);
      expect(bubble()).toBeInTheDocument();
    });

    it('closes on a click that no press came before, after a click of the pointer has opened it', () => {
      const { icon } = renderMetric();
      fireEvent.pointerDown(icon);
      fireEvent.focus(icon);
      fireEvent.click(icon);
      expect(bubble()).toBeInTheDocument();
      // What the press recorded is used once: this click (a key, an assistive technology) toggles what is on screen.
      fireEvent.click(icon);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('keeps a bubble the pointer opened, and closes it on the next click', () => {
      const { metric, icon } = renderMetric();
      rest(metric);
      fireEvent.pointerDown(icon);
      fireEvent.focus(icon);
      fireEvent.click(icon);
      expect(bubble()).toBeInTheDocument();
      // The click gave the "i" the focus, which holds the bubble when the pointer leaves.
      fireEvent.pointerLeave(metric);
      pass(1000);
      expect(bubble()).toBeInTheDocument();

      fireEvent.pointerMove(metric);
      fireEvent.pointerDown(icon);
      fireEvent.click(icon);
      expect(bubble()).not.toBeInTheDocument();
    });

    it('does not open again for a pointer that moves on the target after a click has closed the bubble', () => {
      const { metric, icon } = renderMetric();
      // The pointer is still on its way to the "i" when it presses: the wait for it to rest is running.
      fireEvent.pointerMove(metric);
      fireEvent.pointerDown(icon);
      fireEvent.focus(icon);
      fireEvent.click(icon);
      fireEvent.pointerDown(icon);
      // jsdom knows no :hover: for the moment the bubble closes, the target says that the pointer is on it.
      const onTarget = vi.spyOn(metric, 'matches').mockReturnValue(true);
      fireEvent.click(icon);
      onTarget.mockRestore();
      expect(bubble()).not.toBeInTheDocument();

      fireEvent.pointerMove(metric);
      pass(1000);
      expect(bubble()).not.toBeInTheDocument();
    });
  });

  describe('for a screen reader', () => {
    it('names the "i" in one piece of text, and gives it no title', () => {
      const { icon } = renderMetric();
      const name = document.getElementById(icon.getAttribute('aria-labelledby') ?? '');
      expect(name).not.toBeVisible();
      // Chrome joins the pieces of a hidden name with spaces: "About w aited in line".
      expect(Array.from(name?.childNodes ?? [], (node) => node.nodeValue)).toEqual(['About waited in line']);
      // A title would be a second bubble on hover, which is why the name is not the button's own label.
      expect(icon).not.toHaveAttribute('title');
      // In a form, a button that is not told otherwise submits it.
      expect(icon).toHaveAttribute('type', 'button');
    });

    it('describes the "i" by each question and its answer, in one piece of text, whether or not the bubble is open', () => {
      const { icon } = renderMetric();
      const description = document.getElementById(icon.getAttribute('aria-describedby') ?? '');
      // It is for a listener only: on the page it would stand in every tile, above its label.
      expect(description).not.toBeVisible();
      // A listener hears where each answer starts. Not the title, which is the name already.
      expect(Array.from(description?.childNodes ?? [], (node) => node.nodeValue)).toEqual([
        'What it is: The share of your tasks that could not start right away.'
        + ' Why it matters: Waiting adds to every time on this page.'
        + " How it's computed: Tasks that waited in the queue, divided by tasks that waited or started.",
      ]);
      expect(bubble()).not.toBeInTheDocument();

      fireEvent.focus(icon);
      expect(bubble()).toBeInTheDocument();
      expect(icon).toHaveAccessibleDescription(described(WAITED));
    });

    it('gives the focus to a target that has no "i", and describes it the same way', () => {
      render(
        <Explain title="Failed or stopped" summary="9 of 52 finished tasks, 17%" explanation={HELD} role="img" aria-label="Failed or stopped" tabIndex={0} />,
      );
      const part = screen.getByRole('img', { name: 'Failed or stopped' });
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      // The number of a graph part is in its name and in the bubble, under the title: not in the description.
      expect(part).toHaveAccessibleDescription(described(HELD));

      fireEvent.focus(part);
      expect(bubble()?.textContent).toBe(bubbleText('Failed or stopped', HELD, '9 of 52 finished tasks, 17%'));

      fireEvent.blur(part);
      expect(bubble()).not.toBeInTheDocument();
    });
  });

  it('shows one bubble at a time', () => {
    render(
      <>
        <Explain title="Waited in line" explanation={WAITED} data-testid="waited">{(icon) => icon}</Explain>
        <Explain title="Held for approval" explanation={HELD}>{(icon) => icon}</Explain>
      </>,
    );
    rest(screen.getByTestId('waited'));
    expect(screen.getAllByRole('tooltip').map((open) => open.textContent)).toEqual([bubbleText('Waited in line', WAITED)]);

    fireEvent.focus(screen.getByRole('button', { name: 'About held for approval' }));
    expect(screen.getAllByRole('tooltip').map((open) => open.textContent)).toEqual([bubbleText('Held for approval', HELD)]);
  });

  it('does not bring back a bubble that closed for another when the pointer moves on its target', () => {
    render(
      <>
        <Explain title="Waited in line" explanation={WAITED} data-testid="waited">{(icon) => icon}</Explain>
        <Explain title="Held for approval" explanation={HELD}>{(icon) => icon}</Explain>
      </>,
    );
    const waited = screen.getByTestId('waited');
    rest(waited);
    // jsdom knows no :hover: for the moment its bubble closes, the first target says that the pointer is on it.
    const onTarget = vi.spyOn(waited, 'matches').mockReturnValue(true);
    fireEvent.focus(screen.getByRole('button', { name: 'About held for approval' }));
    onTarget.mockRestore();

    fireEvent.pointerMove(waited);
    pass(1000);
    expect(screen.getAllByRole('tooltip').map((open) => open.textContent)).toEqual([bubbleText('Held for approval', HELD)]);
  });

  it('is never for the pointer alone: its props ask for an "i" or for a tab stop', () => {
    type Props = Parameters<typeof Explain>[0];
    interface Common { title: string; explanation: Explanation }
    expectTypeOf<Common & { children: string }>().not.toExtend<Props>();
    expectTypeOf<Common & { children: string; tabIndex: 0 }>().toExtend<Props>();
    expectTypeOf<Common & { children: (icon: ReactNode) => ReactNode }>().toExtend<Props>();
  });

  it('shows the new text when the target is rendered again while its bubble is open', () => {
    const { icon, rerender } = renderMetric();
    fireEvent.focus(icon);
    rerender(
      <Explain title="Waited in line" explanation={HELD} data-testid="metric">
        {(again) => <>Waited in line {again} 9%</>}
      </Explain>,
    );
    expect(screen.getAllByRole('tooltip').map((open) => open.textContent)).toEqual([bubbleText('Waited in line', HELD)]);
  });

  it('is a span where a block cannot stand, as beside the title of a graph', () => {
    render(<Explain as="span" title="Spend per day" explanation={WAITED} data-testid="graph">{(icon) => icon}</Explain>);
    expect(screen.getByTestId('graph').tagName).toBe('SPAN');
    fireEvent.focus(screen.getByRole('button', { name: 'About spend per day' }));
    expect(bubble()?.textContent).toBe(bubbleText('Spend per day', WAITED));
  });

  it('leaves no timer behind when it goes away', () => {
    const { metric, unmount } = renderMetric();
    fireEvent.pointerMove(metric);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
