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

import type { ParsedRef } from './ref';
import type {
  ListFilter,
  PublishInput,
  RegistryBrowseEntry,
  RegistryRecord,
  ResolvedAsset,
} from './types';

export interface RegistryClient {
  /**
   * Publish a record. Returns the created record.
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

  listRecords(filter?: ListFilter): Promise<readonly RegistryRecord[]>;

  /**
   * Like {@link listRecords} but includes malformed records as envelope-only
   * markers instead of dropping them.
   */
  listBrowseEntries(filter?: ListFilter): Promise<readonly RegistryBrowseEntry[]>;

  /**
   * Resolve a parsed ref to a single asset: gather candidate versions, rank by
   * semver, apply the constraint + status rules (only APPROVED resolves;
   * DEPRECATED resolves with a warning). Throws `RegistryResolutionError` with a
   * specific reason on failure.
   */
  resolve(ref: ParsedRef): Promise<ResolvedAsset>;
}
