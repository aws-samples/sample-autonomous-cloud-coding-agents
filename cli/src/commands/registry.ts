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

import * as fs from 'fs';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { CliError } from '../errors';
import type { RegistryPublishRequest } from '../types';

const KIND_WIDTH = 20;
const NS_WIDTH = 16;
const NAME_WIDTH = 24;
const VERSION_WIDTH = 12;

/** Read + parse a JSON file argument, failing with a friendly CliError. */
function readJsonFile(label: string, filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new CliError(`Cannot read ${label} file: ${filePath}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CliError(`${label} file is not valid JSON: ${filePath}`);
  }
}

export function makeRegistryCommand(): Command {
  const registry = new Command('registry').description('Agent asset registry (#246)');

  registry.addCommand(
    new Command('publish')
      .description('Publish an asset record (requires the RegistryPublisher group)')
      .requiredOption('--kind <kind>', 'Asset kind (mcp_server | cedar_policy_module | skill)')
      .requiredOption('--namespace <namespace>', 'Owner namespace')
      .requiredOption('--name <name>', 'Asset name')
      // NOT --version: commander reserves that for the program version flag.
      .requiredOption('--asset-version <semver>', 'Exact semver, e.g. 1.4.1')
      .requiredOption('--discovery <file>', 'Path to a JSON file with the discovery descriptor')
      .requiredOption('--runtime <file>', 'Path to a JSON file with the ABCA runtime payload')
      .option('--custom', 'Store as a verbatim CUSTOM record instead of a native descriptor', false)
      .option('--auto-approve', 'Drive the record to APPROVED (requires RegistryApprover)', false)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        const req: RegistryPublishRequest = {
          kind: opts.kind,
          namespace: opts.namespace,
          name: opts.name,
          asset_version: opts.assetVersion,
          discovery: readJsonFile('discovery', opts.discovery),
          runtime: readJsonFile('runtime', opts.runtime),
          custom: opts.custom,
          auto_approve: opts.autoApprove,
        };
        const record = await new ApiClient().registryPublish(req);
        if (opts.output === 'json') {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(
          `Published ${record.kind}/${record.namespace}/${record.name}@${record.version} `
          + `(status: ${record.status}, storage: ${record.storage_mode})`,
        );
      }),
  );

  registry.addCommand(
    new Command('resolve')
      .description('Resolve a registry:// ref to a single asset')
      .argument('<ref>', 'registry://kind/namespace/name@constraint')
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (ref: string, opts) => {
        const asset = await new ApiClient().registryResolve(ref);
        if (opts.output === 'json') {
          console.log(JSON.stringify(asset, null, 2));
          return;
        }
        console.log(`${asset.kind}/${asset.namespace}/${asset.name}@${asset.version}`);
        if (asset.warnings.length > 0) {
          console.log(`  warnings: ${asset.warnings.join(', ')}`);
        }
        console.log(`  runtime: ${JSON.stringify(asset.runtime)}`);
      }),
  );

  registry.addCommand(
    new Command('list')
      .description('List assets (optionally filtered by kind/namespace)')
      .option('--kind <kind>', 'Filter by kind')
      .option('--namespace <namespace>', 'Filter by namespace')
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        const assets = await new ApiClient().registryList({ kind: opts.kind, namespace: opts.namespace });
        if (opts.output === 'json') {
          console.log(JSON.stringify({ assets }, null, 2));
          return;
        }
        if (assets.length === 0) {
          console.log('No assets found.');
          return;
        }
        console.log(
          `${'KIND'.padEnd(KIND_WIDTH)} ${'NAMESPACE'.padEnd(NS_WIDTH)} `
          + `${'NAME'.padEnd(NAME_WIDTH)} ${'LATEST'.padEnd(VERSION_WIDTH)} STATUS`,
        );
        for (const a of assets) {
          console.log(
            `${a.kind.padEnd(KIND_WIDTH)} ${a.namespace.padEnd(NS_WIDTH)} `
            + `${a.name.padEnd(NAME_WIDTH)} ${(a.latest_version ?? '-').padEnd(VERSION_WIDTH)} ${a.status}`,
          );
        }
      }),
  );

  registry.addCommand(
    new Command('show')
      .description('Show every version of one asset')
      .argument('<kind>', 'Asset kind')
      .argument('<namespace>', 'Owner namespace')
      .argument('<name>', 'Asset name')
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (kind: string, namespace: string, name: string, opts) => {
        const result = await new ApiClient().registryShow(kind, namespace, name);
        if (opts.output === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`${result.kind}/${result.namespace}/${result.name}`);
        console.log(`${'VERSION'.padEnd(VERSION_WIDTH)} ${'STATUS'.padEnd(NS_WIDTH)} CREATED`);
        for (const v of result.versions) {
          console.log(
            `${v.version.padEnd(VERSION_WIDTH)} ${v.status.padEnd(NS_WIDTH)} ${v.created_at ?? '-'}`,
          );
        }
      }),
  );

  return registry;
}
