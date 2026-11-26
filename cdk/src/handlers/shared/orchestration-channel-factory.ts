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

import { logger } from './logger';
import { type Channel } from './orchestration-channel';
import { makeJiraChannel } from './orchestration-channel-jira';
import { makeLinearChannel } from './orchestration-channel-linear';
import { makeSlackChannel } from './orchestration-channel-slack';

/**
 * Per-surface credentials-registry table names, keyed by channel source. An
 * absent (or empty) entry means that surface isn't wired for this caller, so no
 * adapter is built for it.
 */
export type ChannelRegistryTables = Readonly<Record<string, string | undefined>>;

/** How to build one surface's adapter from its credentials-registry table name. */
export type ChannelFactory = (registryTableName: string) => Channel;

const LEGACY_DEFAULT_CHANNEL_SOURCE = 'linear';

const registry = new Map<string, ChannelFactory>([
  ['linear', makeLinearChannel],
  ['jira', makeJiraChannel],
  ['slack', makeSlackChannel],
]);

/**
 * Register (or replace) the adapter for a channel source. Returns a function
 * that restores the previous registration.
 */
export function registerChannelFactory(source: string, factory: ChannelFactory): () => void {
  const previous = registry.get(source);
  registry.set(source, factory);
  return () => {
    if (previous) registry.set(source, previous);
    else registry.delete(source);
  };
}

export function registeredChannelSources(): readonly string[] {
  return [...registry.keys()].sort();
}

/**
 * Build the adapter for ``source`` — the orchestration row's ``channel_source``.
 *
 * Returns undefined when the surface has no registered adapter (e.g. a trigger
 * channel with no issue-tracking surface at all, like an API or chat submission)
 * or when its credentials registry isn't configured for this caller.
 */
export function channelForSource(
  source: string | undefined,
  tables: ChannelRegistryTables,
): Channel | undefined {
  const key = source ?? LEGACY_DEFAULT_CHANNEL_SOURCE;
  const factory = registry.get(key);
  if (!factory) return undefined;
  const registryTableName = tables[key];
  if (!registryTableName) {
    logger.warn('No credentials registry configured for this channel — skipping its feedback', {
      channel_source: key,
    });
    return undefined;
  }
  return factory(registryTableName);
}
