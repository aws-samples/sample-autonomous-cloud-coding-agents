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

import * as readline from 'readline';
import { Command } from 'commander';
import { login } from '../auth';
import { debug } from '../debug';

export function makeLoginCommand(): Command {
  return new Command('login')
    .description('Authenticate with Cognito')
    .requiredOption('--username <email>', 'Cognito username (email)')
    .option('--password <password>', 'Password (will prompt if omitted)')
    .action(async (opts) => {
      debug(`Logging in as: ${opts.username}`);
      const password = opts.password || await promptPassword();
      await login(opts.username, password);
      console.log('Login successful. Credentials saved.');
    });
}

function promptPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    process.stderr.write('Password: ');

    if (process.stdin.isTTY) {
      // TTY mode: read character-by-character with echo disabled
      process.stdin.setRawMode(true);
      process.stdin.resume();

      let password = '';

      const onData = (chunk: Buffer) => {
        const str = chunk.toString();
        for (const char of str) {
          if (char === '\n' || char === '\r') {
            cleanup();
            process.stderr.write('\n');
            resolve(password);
            return;
          } else if (char === '\u0003') {
            cleanup();
            process.stderr.write('\n');
            reject(new Error('Cancelled.'));
            return;
          } else if (char === '\u007f' || char === '\b') {
            password = password.slice(0, -1);
          } else {
            password += char;
          }
        }
      };

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
      };

      process.stdin.on('data', onData);
    } else {
      // Non-TTY (piped input): read a single line
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
      rl.once('close', () => {
        reject(new Error('No password provided.'));
      });
    }
  });
}
