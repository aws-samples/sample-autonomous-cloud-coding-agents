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

// Substrate-neutral domain types for the agent asset registry (#246). These are
// the types the `RegistryClient` port speaks — nothing here references AgentCore
// or the AWS SDK. The AgentCore-specific mapping lives in agentcore-client.ts.
//
// API *wire* types shared with the CLI live in ../types.ts (types-sync contract);
// these port-internal types are deliberately kept out of that sync.

/** Canonical record status. Mirrors AgentCore's `RegistryRecordStatus` tokens so
 *  the resolver's status filter is spelled identically on both sides. Only
 *  `APPROVED` resolves; `DEPRECATED` resolves with a warning. */
export type RegistryStatus =
  | 'CREATING'
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'DEPRECATED'
  | 'UPDATING'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED';

/** How a record's runtime payload is stored on the substrate. */
export type StorageMode = 'native' | 'custom';

/** The reverse-DNS key under which ABCA runtime config rides inside a native
 *  MCP `server.json` `_meta` block (spike-verified to survive validation). */
export const RUNTIME_META_KEY = 'dev.abca.runtime';

/** Companion `_meta` key carrying the authenticated publisher (Cognito sub) so
 *  the record's origin is reconstructable — CloudTrail only sees the shared
 *  Lambda role. Written once at publish; immutable with the rest of the record. */
export const PUBLISHER_META_KEY = 'dev.abca.publisher';

/** Frontmatter key carrying the publisher inside a native AGENT_SKILLS SKILL.md
 *  (skills can't hold a `_meta` block). */
export const PUBLISHER_FM_KEY = 'x-abca-publisher';

// --- Per-kind runtime payloads -------------------------------------------------
// The loadable body each kind carries, independent of discovery metadata.

/** mcp_server: the `.mcp.json` connection config the agent merges in. */
export interface McpRuntimePayload {
  readonly transport: 'http' | 'sse' | 'stdio';
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  /** Tools surface under this prefix (e.g. `mcp__example__`). */
  readonly tool_prefix?: string;
}

/** cedar_policy_module: Cedar policy source text. */
export interface CedarRuntimePayload {
  readonly cedar_text: string;
}

/** skill: the prompt fragment appended to the system prompt (+ advisory hints). */
export interface SkillRuntimePayload {
  readonly prompt_fragment: string;
  readonly tool_hints?: readonly string[];
}

export type RuntimePayload =
  | McpRuntimePayload
  | CedarRuntimePayload
  | SkillRuntimePayload;

/** A full registry record as the port sees it — discovery + runtime + status. */
export interface RegistryRecord {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: RegistryStatus;
  readonly storageMode: StorageMode;
  /** Discovery descriptor (server.json / SKILL.md / arbitrary) — validated body. */
  readonly discovery: Readonly<Record<string, unknown>>;
  /** ABCA runtime payload (from `_meta` or the CUSTOM body). */
  readonly runtime: RuntimePayload;
  readonly publisher?: string;
  readonly createdAt?: string;
}

/** What the resolver hands back for one ref: enough to load the asset without the
 *  caller knowing where the bytes live. */
export interface ResolvedAsset {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly runtime: RuntimePayload;
  /** Non-fatal advisories, e.g. `["DEPRECATED"]`. */
  readonly warnings: readonly string[];
}

/** The bundle threaded into the agent invocation payload after resolving all of a
 *  Blueprint's `registry://` refs. */
export interface ResolvedAssetBundle {
  readonly assets: readonly ResolvedAsset[];
}

export type ResolutionFailureReason =
  | 'NO_MATCHING_VERSION'
  | 'REMOVED'
  | 'INVALID_CONSTRAINT'
  | 'INVALID_REGISTRY_REF';

export class RegistryResolutionError extends Error {
  constructor(
    readonly reason: ResolutionFailureReason,
    readonly ref: string,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryResolutionError';
  }
}

/**
 * Raised when `publish` succeeds at CreateRegistryRecord but a later step
 * (submit/approve/re-read) fails, leaving a partial record on the substrate.
 * Carries the `recordId` so the operator can find and approve or delete the
 * orphan — a bare 500 hid that a record was stranded, and because immutability
 * rejects re-publishing the same version, a retry would otherwise 409 forever
 * with no resolvable record (#246 review).
 */
export class RegistryPublishIncompleteError extends Error {
  constructor(
    readonly recordId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RegistryPublishIncompleteError';
  }
}

// --- Port input types ----------------------------------------------------------

export interface PublishInput {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly discovery: Readonly<Record<string, unknown>>;
  readonly runtime: RuntimePayload;
  /** Authenticated publisher (Cognito sub) — stamped immutably on the record for
   *  audit. Optional only so non-HTTP callers/tests can omit it. */
  readonly publisher?: string;
  /** Force CUSTOM storage (verbatim) instead of a native descriptor. */
  readonly custom?: boolean;
  /** Dev convenience: drive create → submit → approve so the record resolves. */
  readonly autoApprove?: boolean;
}

export interface ListFilter {
  readonly kind?: string;
  readonly namespace?: string;
}
