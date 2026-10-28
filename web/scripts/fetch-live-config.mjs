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

// Fetches the deployed console's /config.json so `vite` can run against your real API
// and Cognito sign-in: `mise //web:dev:live`. Values in that file are public
// identifiers (API URL, user pool and app client ids, login domain), never secrets.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stackName = `${process.env.STACK_NAME ?? 'backgroundagent-dev'}-console`;
const target = join(dirname(fileURLToPath(import.meta.url)), '..', '.config.local.json');

function fail(message) {
  console.error(`dev:live: ${message}`);
  process.exit(1);
}

let consoleUrl;
try {
  consoleUrl = execFileSync('aws', [
    'cloudformation', 'describe-stacks', '--stack-name', stackName,
    '--query', "Stacks[0].Outputs[?OutputKey=='ConsoleUrl'].OutputValue | [0]", '--output', 'text',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch (error) {
  fail(`could not read stack ${stackName}. Set AWS_PROFILE and AWS_REGION (and STACK_NAME if not the default).\n${error.stderr ?? error}`);
}
if (!consoleUrl || consoleUrl === 'None') fail(`stack ${stackName} has no ConsoleUrl output. Deploy with -c operatorConsole=true first.`);

const res = await fetch(new URL('config.json', consoleUrl), { cache: 'no-store' }).catch((error) => fail(`could not reach ${consoleUrl}: ${error.message}`));
if (!res.ok) fail(`${consoleUrl}config.json returned HTTP ${res.status}`);
const config = await res.json();
if (config?.auth?.mode !== 'cognito' || typeof config.apiBaseUrl !== 'string') fail('unexpected config.json shape');

writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
console.log(`dev:live: using ${config.apiBaseUrl} (from ${stackName})`);
console.log('dev:live: sign-in redirects need http://localhost:5173 on the app client (installer: --local-dev).');
console.log('dev:live: open http://localhost:5173/');
