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
 * Pick the {@link Channel} for a surface at runtime.
 *
 * Event-driven paths (the reconciler, the stranded-orchestration sweep) act on an
 * orchestration they LOAD rather than one they were triggered from, so they can't
 * know the surface at build time — it's a property of the stored row. This maps
 * that stored value to an adapter, so the engine picks a surface from data instead
 * of hardcoding one.
 *
 * A surface whose credentials registry isn't configured for the caller, or which
 * has no adapter, yields ``undefined``: the caller skips feedback for that
 * orchestration rather than guessing at another surface's adapter (which would
 * address the wrong tenant, or fail every call). Entry points that are
 * surface-specific by definition — a Linear webhook processor only ever handles
 * Linear — should keep building their adapter directly; this exists for the paths
 * that genuinely can't know.
 */

import { type Channel } from './orchestration-channel';
import { makeJiraChannel } from './orchestration-channel-jira';
import { makeLinearChannel } from './orchestration-channel-linear';

/** The credentials-registry table name per surface. An absent entry means that
 *  surface isn't wired for this caller, so no adapter is built for it. */
export interface ChannelRegistryTables {
  /** Table keyed by the Linear workspace (organization) id. */
  readonly linear?: string | undefined;
  /** Table keyed by the Atlassian tenant id (``cloudId``). */
  readonly jira?: string | undefined;
}

/**
 * Build the adapter for ``source`` — the orchestration row's ``channel_source``.
 *
 * ``undefined``/absent defaults to Linear: orchestrations seeded before the field
 * existed carry no source, and Linear was the only surface that could have seeded
 * them, so that's the honest reading rather than a skip that would silence their
 * feedback. An unrecognised source (a trigger channel with no issue-tracking
 * surface, e.g. an API or chat submission) returns ``undefined``.
 */
export function channelForSource(
  source: string | undefined,
  tables: ChannelRegistryTables,
): Channel | undefined {
  switch (source ?? 'linear') {
    case 'linear':
      return tables.linear ? makeLinearChannel(tables.linear) : undefined;
    case 'jira':
      return tables.jira ? makeJiraChannel(tables.jira) : undefined;
    default:
      return undefined;
  }
}
