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

import { useEffect, useState } from 'react';

const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'] as const;
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
const OTHER_LIGHT = '#5f5f66';
const OTHER_DARK = '#a8a8b0';

export function seriesColor(slot: number, dark: boolean): string {
  return (dark ? DARK : LIGHT)[slot] ?? (dark ? OTHER_DARK : OTHER_LIGHT);
}

export function otherColor(dark: boolean): string {
  return dark ? OTHER_DARK : OTHER_LIGHT;
}

/** Follows Cloudscape's dark mode, which `applyMode` toggles as a class on <body>. */
export function useDarkMode(): boolean {
  const read = () => document.body.classList.contains('awsui-dark-mode');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
