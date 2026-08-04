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

// The `RegistryClient` port (#246). Every consumer — handlers, the orchestrator
// resolve-step — talks to the registry through this interface, NEVER a raw AWS
// SDK client. The one implementation is `AgentCoreRegistryClient`; swapping the
// substrate (or absorbing the AgentCore GA namespace migration on 2026-08-06) is
// confined to that adapter file, not the call sites.

import type { ParsedRef } from './ref';
import type {
  ListFilter,
  PublishInput,
  RegistryRecord,
  ResolvedAsset,
} from './types';

export interface RegistryClient {
  /**
   * Publish a record. On the AgentCore substrate this is a multi-step operation
   * (create → poll READY-ish → submit → approve when `autoApprove`); the port
   * hides that so callers see a single verb. Returns the created record.
   * Throws on an immutability collision (same kind/namespace/name/version).
   */
  publish(input: PublishInput): Promise<RegistryRecord>;

  /** Fetch a single record by its exact coordinates, or null if absent. */
  getRecord(
    kind: string,
    namespace: string,
    name: string,
    version: string,
  ): Promise<RegistryRecord | null>;

  /** List records (optionally filtered by kind/namespace). */
  listRecords(filter?: ListFilter): Promise<readonly RegistryRecord[]>;

  /**
   * Resolve a parsed ref to a single asset: gather candidate versions, rank by
   * semver, apply the constraint + status rules (only APPROVED resolves;
   * DEPRECATED resolves with a warning). Throws `RegistryResolutionError` with a
   * specific reason on failure — resolution is fail-closed.
   */
  resolve(ref: ParsedRef): Promise<ResolvedAsset>;
}
