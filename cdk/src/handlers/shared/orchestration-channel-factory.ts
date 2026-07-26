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
 * Registry of surface adapters, and the lookup that picks one at runtime.
 *
 * Event-driven paths (the reconciler, the stranded-orchestration sweep) act on an
 * orchestration they LOAD rather than one they were triggered from, so they can't
 * know the surface at build time — it's a property of the stored row. This maps
 * that stored value to an adapter, so the engine picks a surface from data instead
 * of hardcoding one.
 *
 * A REGISTRY rather than a switch, deliberately: a closed ``switch`` (or a closed
 * ``ChannelKind`` union) means adding a tracker requires editing this file, so
 * every consumer would have to merge a core change to support one more surface —
 * the thing the extensibility tenet exists to prevent. Instead each adapter
 * declares how to build itself, and a surface can be registered from outside this
 * module entirely.
 *
 * A surface whose credentials registry isn't configured for the caller, or which
 * has no registered adapter, yields ``undefined``: the caller skips feedback for
 * that orchestration rather than guessing at another surface's adapter (which
 * would address the wrong tenant, or fail every call). Entry points that are
 * surface-specific by definition — a Linear webhook processor only ever handles
 * Linear — should keep building their adapter directly; this exists for the paths
 * that genuinely can't know.
 */

import { logger } from './logger';
import { type Channel } from './orchestration-channel';
import { makeJiraChannel } from './orchestration-channel-jira';
import { makeLinearChannel } from './orchestration-channel-linear';

/**
 * Per-surface credentials-registry table names, keyed by channel source. An
 * absent (or empty) entry means that surface isn't wired for this caller, so no
 * adapter is built for it.
 *
 * An open map rather than named fields, for the same reason the registry itself
 * is open: a new surface adds a key, not a core type change.
 */
export type ChannelRegistryTables = Readonly<Record<string, string | undefined>>;

/**
 * How to build one surface's adapter from its credentials-registry table name.
 * Returning a {@link Channel} is the whole contract — everything else about the
 * surface (auth, comment format, reaction vocabulary, dependency model) stays
 * inside the adapter.
 */
export type ChannelFactory = (registryTableName: string) => Channel;

/**
 * The surface a stored row with NO recorded channel is treated as. Rows seeded
 * before ``channel_source`` existed carry none, and Linear was the only surface
 * that could have seeded them — so defaulting keeps their feedback working
 * rather than silencing it. Not a statement that Linear is privileged.
 */
export const LEGACY_DEFAULT_CHANNEL_SOURCE = 'linear';

/**
 * Registered adapters, keyed by the ``channel_source`` value that selects them.
 * Mutable so a surface can register from its own module; seeded here with the
 * adapters that ship in-tree.
 */
const registry = new Map<string, ChannelFactory>([
  ['linear', makeLinearChannel],
  ['jira', makeJiraChannel],
]);

/**
 * Register (or replace) the adapter for a channel source. Lets a surface live
 * entirely in its own module — including one added downstream — without editing
 * the lookup below. Returns a function that restores the previous registration,
 * so a test can register a fake surface without leaking into other tests.
 */
export function registerChannelFactory(source: string, factory: ChannelFactory): () => void {
  const previous = registry.get(source);
  registry.set(source, factory);
  return () => {
    if (previous) registry.set(source, previous);
    else registry.delete(source);
  };
}

/** Channel sources that currently have a registered adapter (for diagnostics). */
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
    // Distinguishable from "no such surface": the surface IS supported, this
    // caller just can't reach its credentials — which is why its feedback goes
    // silent, and worth a breadcrumb rather than an indistinguishable skip.
    logger.warn('No credentials registry configured for this channel — skipping its feedback', {
      channel_source: key,
    });
    return undefined;
  }
  return factory(registryTableName);
}
