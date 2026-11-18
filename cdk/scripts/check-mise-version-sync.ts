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

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

interface Workflow {
  jobs: Record<string, { steps?: { uses?: string; with?: { version?: string } }[] }>;
}

const dockerfile = '.devcontainer/Dockerfile';
const fromImage = /^[ \t]*FROM[ \t]+(?:--platform=\S+[ \t]+)?(\S+)/gim;
const images = Array.from(readFileSync(dockerfile, 'utf8').matchAll(fromImage), match => match[1]);
const miseImages = images.filter(image => /^(?:docker\.io\/)?jdxcode\/mise(?:[:@]|$)/.test(image));
const version = miseImages[0]?.match(/:(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}$/)?.[1];
if (miseImages.length !== 1 || !version) {
  console.error(`${dockerfile}: expected one jdxcode/mise image pinned by release and sha256 digest`);
  process.exit(1);
}
const workflows = '.github/workflows';
let miseSteps = 0;
for (const file of readdirSync(workflows).filter(name => /\.ya?ml$/.test(name)).sort()) {
  const path = join(workflows, file);
  let workflow: Workflow;
  try {
    workflow = load(readFileSync(path, 'utf8')) as Workflow;
  } catch (error) {
    throw new Error(`Cannot read ${path}`, { cause: error });
  }
  for (const [job, { steps = [] }] of Object.entries(workflow.jobs)) {
    for (const step of steps) {
      if (!step.uses?.toLowerCase().startsWith('jdx/mise-action@')) continue;
      miseSteps++;
      if (step.with?.version !== version) {
        console.error(`${path} (${job}): jdx/mise-action with.version is ${step.with?.version ?? 'missing'}, expected ${version} from ${dockerfile}`);
        process.exitCode = 1;
      }
    }
  }
}
if (miseSteps === 0) {
  console.error(`Found no jdx/mise-action steps under ${workflows} to compare with ${dockerfile}`);
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log(`mise ${version} matches ${dockerfile} and all ${miseSteps} workflow steps`);
}
