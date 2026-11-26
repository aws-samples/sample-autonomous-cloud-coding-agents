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

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

// Under Jest pdfjs cannot import() its ES module worker, so the screening runs in a child process.

const CDK_ROOT = path.resolve(__dirname, '..', '..', '..');

const DRIVER = `
  import { screenTextFile } from './src/handlers/shared/attachment-screening';
  const screened = [];
  const bedrockClient = {
    send: async (command) => {
      screened.push(command.input.content[0].text.text);
      return { action: 'NONE' };
    },
  };
  const config = { bedrockClient, guardrailId: 'g', guardrailVersion: '1' };
  screenTextFile(Buffer.from(process.env.PDF_BASE64, 'base64'), 'application/pdf', 'real.pdf', config).then(
    (result) => console.log(JSON.stringify({ status: result.screening.status, screened })),
    (err) => console.log(JSON.stringify({ rejected: err.message, cause: String(err.cause ?? '') })),
  );
`;

const BUNDLE = buildSync({
  stdin: { contents: DRIVER, resolveDir: CDK_ROOT },
  bundle: true,
  write: false,
  platform: 'node',
  target: `node${process.versions.node}`,
  format: 'cjs',
  logLevel: 'silent',
  external: ['@aws-sdk/*', 'pdf-parse'],
}).outputFiles[0].text;

function pdfWithPages(pageTexts: string[]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pageTexts.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function screenInChild(pdf: Buffer): unknown {
  const stdout = execFileSync(process.execPath, ['-'], {
    // pdf-parse and the AWS SDK resolve from here: Node resolves a script read from stdin from the working directory.
    cwd: CDK_ROOT,
    input: BUNDLE,
    // Not an argument: the error of a failed execFileSync starts with the child's command line.
    env: { ...process.env, PDF_BASE64: pdf.toString('base64') },
    encoding: 'utf-8',
    // With no stdio given, execFileSync writes the child's stderr to the parent's; piped, the error of a failed child carries it.
    stdio: 'pipe',
    // Jest cannot interrupt a synchronous call, so its test timeout does not end a child that never exits.
    timeout: 30_000,
  });
  // pdfjs prints its notices on stdout: the outcome is the last line.
  return JSON.parse(stdout.trimEnd().split('\n').at(-1) ?? '');
}

test('the text of every page of a real PDF reaches the guardrail', () => {
  const outcome = screenInChild(pdfWithPages(['Design spec: add CONTRIBUTORS', 'Second page: list the maintainers']));
  expect(outcome).toEqual({
    status: 'passed',
    screened: [expect.stringMatching(/Design spec: add CONTRIBUTORS[\s\S]*Second page: list the maintainers/)],
  });
});

test('a real PDF with more pages than can be screened is refused', () => {
  const outcome = screenInChild(pdfWithPages(Array.from({ length: 51 }, (_, i) => `Page ${i + 1}`)));
  expect(outcome).toEqual({
    rejected: expect.stringContaining('has 51 pages, over the 50-page limit'),
    cause: '',
  });
});
