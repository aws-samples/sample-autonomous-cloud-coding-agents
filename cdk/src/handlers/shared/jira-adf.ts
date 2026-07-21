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

/**
 * Jira ADF (Atlassian Document Format) → best-effort markdown conversion.
 *
 * Extracted from the webhook processor so both the processor (issue
 * description) and the context-enrichment helper (issue comments, #577) can
 * render ADF bodies without a circular import. Intentionally minimal — extract
 * paragraphs, headings, and list items as plain text. Anything else (panels,
 * tables, embeds) is collapsed to its textual content.
 *
 * The full ADF spec has dozens of node types; rolling a complete converter
 * here would dwarf the rest of the integration and add a new dependency
 * surface. The agent gets a coherent text rendering; richer rendering (tables,
 * mentions) can land in a follow-up.
 *
 * Tests: cdk/test/handlers/jira-webhook-processor.test.ts (via the processor)
 * and cdk/test/handlers/shared/jira-attachments.test.ts (comment rendering).
 */

/** Deepest markdown heading level (`######`) ADF heading nodes are clamped to. */
export const MAX_MARKDOWN_HEADING_LEVEL = 6;

export interface AdfNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: {
    readonly level?: number;
    /** `media` node: `"external"` carries a direct `url`; `"file"`/`"link"`
     *  carry an attachment `id` that needs a Jira API call to resolve. */
    readonly type?: string;
    readonly url?: string;
    readonly alt?: string;
  };
  readonly content?: AdfNode[];
}

/**
 * Convert a Jira ADF document (or a raw string) into best-effort markdown.
 * Non-object, empty, or null inputs return an empty string.
 */
export function extractDescriptionMarkdown(description: unknown): string {
  if (!description) return '';
  if (typeof description === 'string') return description;
  if (typeof description !== 'object') return '';

  const lines: string[] = [];
  walkAdf(description as AdfNode, lines, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walkAdf(node: AdfNode | undefined, out: string[], depth: number): void {
  if (!node) return;
  switch (node.type) {
    case 'doc':
      (node.content ?? []).forEach((c) => walkAdf(c, out, depth));
      return;
    case 'paragraph': {
      const text = (node.content ?? []).map(textOf).join('');
      if (text) {
        out.push(text);
        out.push('');
      }
      return;
    }
    case 'heading': {
      const level = node.attrs?.level ?? 1;
      const prefix = '#'.repeat(Math.max(1, Math.min(MAX_MARKDOWN_HEADING_LEVEL, level)));
      const text = (node.content ?? []).map(textOf).join('');
      if (text) {
        out.push(`${prefix} ${text}`);
        out.push('');
      }
      return;
    }
    case 'bulletList':
    case 'orderedList': {
      (node.content ?? []).forEach((item, idx) => {
        const itemText = (item.content ?? [])
          .flatMap((sub) => collectInlineLines(sub))
          .join(' ')
          .trim();
        if (!itemText) return;
        const bullet = node.type === 'orderedList' ? `${idx + 1}.` : '-';
        out.push(`${' '.repeat(depth * 2)}${bullet} ${itemText}`);
      });
      out.push('');
      return;
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map(textOf).join('');
      out.push('```');
      out.push(text);
      out.push('```');
      out.push('');
      return;
    }
    case 'mediaSingle':
    case 'mediaGroup':
      // Container nodes — descend to the `media` children below.
      (node.content ?? []).forEach((c) => walkAdf(c, out, depth));
      return;
    case 'media': {
      // Jira embeds images as `media` nodes (not markdown image text). Only
      // `external` media carry a directly-usable URL; `file`/`link` media
      // reference an attachment `id` resolved separately (#577 fetches those
      // authenticated via the Jira REST attachment API), so we skip them here.
      const url = node.attrs?.url;
      if (node.attrs?.type === 'external' && typeof url === 'string' && url.startsWith('https://')) {
        const alt = node.attrs?.alt ?? '';
        out.push(`![${alt}](${url})`);
        out.push('');
      }
      return;
    }
    case 'text':
      if (node.text) out.push(node.text);
      return;
    default:
      // Unknown node — descend into its content if any so embedded text
      // (e.g. inside a panel or quote) isn't lost.
      (node.content ?? []).forEach((c) => walkAdf(c, out, depth));
  }
}

function textOf(node: AdfNode): string {
  if (node.type === 'text' && node.text) return node.text;
  if (node.content) return node.content.map(textOf).join('');
  return '';
}

function collectInlineLines(node: AdfNode): string[] {
  if (node.type === 'paragraph') {
    return [(node.content ?? []).map(textOf).join('')];
  }
  if (node.type === 'text' && node.text) {
    return [node.text];
  }
  return [];
}
