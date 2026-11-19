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

/**
 * Series colors for charts, validated with the dataviz palette checks (lightness band,
 * chroma, colorblind-safe adjacent pairs, normal-vision floor) against Cloudscape's
 * container surfaces: white in light mode, #161d26 in dark mode. Light-mode slots 3-5
 * sit under 3:1 on white, so every chart ships with a table of the same numbers.
 *
 * Slots are used in this fixed order and never cycled; past five, data folds into "Other".
 */
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'] as const;
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
// "Other" is a neutral, not a hue (it fails the chroma floor by design). It is stepped
// away in lightness from slot 5, which it stacks next to, so the pair stays apart
// under protan/deutan simulation (light 17.2, dark 10.6 OKLab Delta E).
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
