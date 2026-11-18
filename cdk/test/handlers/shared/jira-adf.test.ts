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

import { extractDescriptionMarkdown } from '../../../src/handlers/shared/jira-adf';

const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const listItem = (...content: unknown[]) => ({ type: 'listItem', content });
const bulletList = (...content: unknown[]) => ({ type: 'bulletList', content });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });

describe('extractDescriptionMarkdown: lists', () => {
  test('keeps what a list item holds besides its own text: nested items, a pasted link, a code block', () => {
    const description = doc(bulletList(
      listItem(paragraph(text('Backend')), bulletList(
        listItem(paragraph(text('add POST /trips'))),
        listItem(paragraph(text('validate the dates'))),
      )),
      // Jira stores a pasted link as an inlineCard: no text, the URL in attrs.
      listItem(paragraph(text('Spec: '), { type: 'inlineCard', attrs: { url: 'https://example.com/specs/trips' } })),
      listItem(
        paragraph(text('Call it like this:')),
        { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('curl -X POST /trips')] },
      ),
    ));

    expect(extractDescriptionMarkdown(description)).toBe([
      '- Backend',
      '  - add POST /trips',
      '  - validate the dates',
      '- Spec: https://example.com/specs/trips',
      '- Call it like this:',
      '```',
      'curl -X POST /trips',
      '```',
    ].join('\n'));
  });

  test('an item that holds only a nested list keeps that list', () => {
    const description = doc(bulletList(
      listItem(bulletList(listItem(paragraph(text('the only requirement'))))),
    ));

    // (The converter trims the document, so the indent of a first line goes.)
    expect(extractDescriptionMarkdown(description)).toBe('- the only requirement');
  });

  test('a flat list renders as before, with one blank line after it', () => {
    const description = doc(
      { type: 'orderedList', content: [listItem(paragraph(text('first'))), listItem(paragraph(text('second')))] },
      paragraph(text('After the list.')),
    );

    expect(extractDescriptionMarkdown(description)).toBe('1. first\n2. second\n\nAfter the list.');
  });
});
