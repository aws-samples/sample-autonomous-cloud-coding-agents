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

/** Canonical record status, spelled as Agent Registry's `RegistryRecordStatus` tokens.
 *  Only `APPROVED` resolves; `DEPRECATED` resolves with a warning. */
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

export type StorageMode = 'native' | 'custom';

/** The reverse-DNS key under which ABCA runtime config rides inside a native
 *  MCP `server.json` `_meta` block. Measured: the block survives validation. */
export const RUNTIME_META_KEY = 'dev.abca.runtime';

/** `_meta` key carrying the authenticated publisher (Cognito sub). Written once
 *  at publish; immutable with the rest of the record. */
export const PUBLISHER_META_KEY = 'dev.abca.publisher';

/** Frontmatter key carrying the publisher inside a native SKILL record's SKILL.md:
 *  a skill cannot hold a `_meta` block. */
export const PUBLISHER_FM_KEY = 'x-abca-publisher';

/** mcp_server: the `.mcp.json` connection config the agent merges in. */
export interface McpRuntimePayload {
  readonly transport: 'http' | 'sse' | 'stdio';
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  /** Not applied. Publish accepts it and resolve echoes it, nothing else reads it:
   *  the agent writes the server under the key `<namespace>__<name>`, so the tools
   *  of `acme/pdf-tools` surface as `mcp__acme__pdf-tools__*` whatever this says. */
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

export interface RegistryRecord {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: RegistryStatus;
  readonly storageMode: StorageMode;
  /** Discovery descriptor (server.json / SKILL.md / arbitrary) — validated body. */
  readonly discovery: Readonly<Record<string, unknown>>;
  /** ABCA runtime payload (from the MCP `_meta` block, the SKILL.md frontmatter, or
   *  the CUSTOM body). */
  readonly runtime: RuntimePayload;
  readonly publisher?: string;
  readonly createdAt?: string;
}

/** A record as a browse surface (`show`) sees it: either fully parsed, or a
 *  marker that a record exists at these coordinates but its descriptor payload
 *  did not parse. */
export type RegistryBrowseEntry =
  | { readonly malformed: false; readonly record: RegistryRecord }
  | {
    readonly malformed: true;
    readonly kind: string;
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
    readonly status: RegistryStatus;
  };

export interface ResolvedAsset {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly runtime: RuntimePayload;
  /** Non-fatal advisories, e.g. `["DEPRECATED"]`. */
  readonly warnings: readonly string[];
}

export type ResolutionFailureReason =
  | 'NO_MATCHING_VERSION'
  | 'REMOVED'
  | 'MALFORMED'
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

/** Which stage of descriptor decoding failed. Every arm is a *present but
 *  unparseable* payload. */
export type MalformedReason =
  | 'MALFORMED_FRONTMATTER'
  | 'MALFORMED_RUNTIME'
  | 'MALFORMED_DESCRIPTOR';

/**
 * Raised when a record's descriptor payload is present but unparseable — a
 * SKILL.md frontmatter block that fails to YAML-parse, an `x-abca-runtime` value
 * that is not decodable base64/JSON, or a CUSTOM/MCP body that is not valid JSON
 * (see {@link MalformedReason}). Distinct from an *absent* record and from an
 * *empty* runtime. Mirrors `RegistryRecordMalformedError` in
 * `agent/src/registry/client.py`.
 */
export class RegistryRecordMalformedError extends Error {
  constructor(
    readonly reason: MalformedReason,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RegistryRecordMalformedError';
  }
}

/**
 * Raised when `publish` succeeds at CreateRegistryRecord but a later step
 * (submit/approve/re-read) fails, leaving a partial record on the substrate.
 * Carries the `recordId` so the operator can find and approve or delete the
 * orphan.
 */
export class RegistryPublishIncompleteError extends Error {
  constructor(
    readonly recordId: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RegistryPublishIncompleteError';
  }
}

export interface PublishInput {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly discovery: Readonly<Record<string, unknown>>;
  readonly runtime: RuntimePayload;
  /** Authenticated publisher (Cognito sub), stamped immutably on the record. */
  readonly publisher?: string;
  /** Force CUSTOM storage (verbatim) instead of a native descriptor. */
  readonly custom?: boolean;
  /** Dev convenience: also approve the record, so it resolves at once. Create and
   *  submit happen either way; this gates only the final transition to APPROVED. */
  readonly autoApprove?: boolean;
}

export interface ListFilter {
  readonly kind?: string;
  readonly namespace?: string;
  /** Asset name: with it, only the records of that asset are fetched. */
  readonly name?: string;
}
