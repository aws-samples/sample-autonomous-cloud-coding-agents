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
import { formatJson } from '../format';
import type { RegistryAssetKind, RegistryDescriptor } from '../types';

/** Known asset kinds for CLI-side validation before hitting the API. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<RegistryAssetKind>([
  'mcp_server',
  'cedar_policy_module',
  'skill',
  'plugin',
  'subagent',
  'prompt_fragment',
  'capability',
]);

/**
 * Build the ``bgagent registry`` command group (#246): publish, resolve, list,
 * show. See docs/design/REGISTRY.md §4.
 */
export function makeRegistryCommand(): Command {
  const registry = new Command('registry')
    .description('Manage agent asset registry entries (MCP servers, Cedar modules, skills)');

  registry.addCommand(
    new Command('publish')
      .description('Publish a new asset version')
      .requiredOption('--kind <kind>', 'Asset kind (e.g. mcp_server)')
      .requiredOption('--namespace <namespace>', 'Asset namespace (e.g. acme)')
      .requiredOption('--name <name>', 'Asset name (e.g. pdf-tools)')
      // NOT ``--version``: that collides with commander's global version flag
      // (program.version()), which prints the CLI version and exits before the
      // action runs. Use ``--asset-version`` for the semver being published.
      .requiredOption('--asset-version <version>', 'Exact semver version (e.g. 1.4.1)')
      .requiredOption('--descriptor <file>', 'Path to a JSON descriptor file')
      .option('--artifact <file>', 'Path to the artifact file (required for loadable kinds)')
      .option('--auto-approve', 'Publish directly as approved (requires RegistryApprover)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        if (!KNOWN_KINDS.has(opts.kind)) {
          throw new CliError(`Unknown asset kind '${opts.kind}'.`);
        }
        // The server is the authority on descriptor shape (it validates every
        // required per-kind field at publish); the CLI forwards it verbatim.
        const descriptor = readJsonFile(opts.descriptor, 'descriptor') as unknown as RegistryDescriptor;
        const artifactB64 = opts.artifact
          ? fs.readFileSync(opts.artifact).toString('base64')
          : undefined;

        const client = new ApiClient();
        const result = await client.publishRegistryAsset(
          {
            kind: opts.kind,
            namespace: opts.namespace,
            name: opts.name,
            version: opts.assetVersion,
            descriptor,
            ...(artifactB64 !== undefined && { artifact_b64: artifactB64 }),
          },
          opts.autoApprove,
        );

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(
            `Published ${result.kind}/${result.namespace}/${result.name}@${result.version} ` +
            `(status: ${result.status})`,
          );
        }
      }),
  );

  registry.addCommand(
    new Command('resolve')
      .description('Resolve a registry ref to a pinned version')
      .argument('<ref>', 'registry://kind/namespace/name@constraint')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (ref: string, opts) => {
        const client = new ApiClient();
        const result = await client.resolveRegistryRef(ref);
        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          const warn = result.warnings.length > 0 ? ` [${result.warnings.join(', ')}]` : '';
          console.log(
            `${result.kind}/${result.namespace}/${result.name} → ${result.version}${warn}`,
          );
          if (result.artifact_url) {
            console.log(`artifact: ${result.artifact_url}`);
          }
        }
      }),
  );

  registry.addCommand(
    new Command('list')
      .description('List assets of a kind')
      .requiredOption('--kind <kind>', 'Asset kind to list')
      .option('--namespace <namespace>', 'Filter by namespace')
      .option('--status <status>', 'Filter by status (e.g. removed)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        if (!KNOWN_KINDS.has(opts.kind)) {
          throw new CliError(`Unknown asset kind '${opts.kind}'.`);
        }
        const client = new ApiClient();
        const result = await client.listRegistryAssets(opts.kind, {
          namespace: opts.namespace,
          status: opts.status,
        });
        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else if (result.assets.length === 0) {
          console.log('(no assets)');
        } else {
          for (const a of result.assets) {
            console.log(`${a.kind}/${a.namespace}/${a.name}\t${a.latest_version}\t${a.status}`);
          }
        }
      }),
  );

  registry.addCommand(
    new Command('show')
      .description('Show all versions of a single asset')
      .argument('<id>', 'kind/namespace/name (e.g. mcp_server/acme/pdf-tools)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (id: string, opts) => {
        const ID_SEGMENTS = 3; // kind/namespace/name
        const parts = id.split('/');
        if (parts.length !== ID_SEGMENTS) {
          throw new CliError(`Invalid asset id '${id}'. Expected 'kind/namespace/name'.`);
        }
        const [kind, namespace, name] = parts;
        const client = new ApiClient();
        const result = await client.showRegistryAsset(kind, namespace, name);
        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(`${result.kind}/${result.namespace}/${result.name}`);
          for (const v of result.versions) {
            console.log(`  ${v.version}\t${v.status}\t${v.created_at}`);
          }
        }
      }),
  );

  return registry;
}

/** Read + parse a JSON file, raising a CliError with a clear message on failure. */
function readJsonFile(path: string, label: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf-8');
  } catch {
    throw new CliError(`Could not read ${label} file: ${path}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CliError(`${label} file is not valid JSON: ${path}`);
  }
}
