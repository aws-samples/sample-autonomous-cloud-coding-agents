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

// The ONE AWS Agent Registry implementation of the `RegistryClient` port (#246).
// This is the only file upstream of the port that imports the AWS SDK. It owns
// the substrate-specific decisions established by the live spikes:
//
//   - namespace-in-`name` encoding (Option A): Agent Registry has no namespace, so we
//     fold `kind/namespace/name` into the record `name` and split on read.
//   - native-vs-CUSTOM storage: purist native descriptors (MCP/SKILL)
//     by default, carrying ABCA runtime config in a `_meta` block; `custom:true`
//     stores a verbatim CUSTOM body instead.
//   - 3-call publish: CreateRegistryRecord is async and lands in DRAFT even with
//     registry autoApproval; `autoApprove` drives create→submit→approve.
//   - resolve ranks semver in code (Agent Registry stores a plain version string).

import {
  AgentRegistryControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
  ConflictException,
  ResourceNotFoundException,
  type Descriptors,
  type GetRegistryRecordCommandOutput,
} from '@aws-sdk/client-agent-registry-control';
import * as yaml from 'js-yaml';
import { logger } from '../logger';
import { makeClient } from '../ua';
import type { RegistryClient } from './client';
import type { ParsedRef } from './ref';
import { selectHighest } from './resolver';
import {
  PUBLISHER_FM_KEY,
  PUBLISHER_META_KEY,
  RUNTIME_META_KEY,
  RegistryPublishIncompleteError,
  RegistryRecordMalformedError,
  RegistryResolutionError,
  type ListFilter,
  type MalformedReason,
  type PublishInput,
  type RegistryBrowseEntry,
  type RegistryRecord,
  type RegistryStatus,
  type ResolvedAsset,
  type RuntimePayload,
  type StorageMode,
} from './types';

const NAME_SEP = '/';
const RECORD_CREATE_POLL_MS = 2000;
const RECORD_CREATE_MAX_POLLS = 30;

/** True when a runtime payload is a non-empty object — the fail-closed gate that
 *  keeps `resolve` from returning a record whose runtime is missing/`{}` (which
 *  would let a task load nothing while the audit claims the pin was honored). */
function isNonEmptyRuntime(runtime: unknown): boolean {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    !Array.isArray(runtime) &&
    Object.keys(runtime as Record<string, unknown>).length > 0
  );
}

/** Coordinates read straight from the record envelope (name/version/status),
 *  which stay readable even when the descriptor payload does not parse. */
interface RecordCoords {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: RegistryStatus;
}

/** A record whose envelope is readable but whose descriptor payload failed to
 *  parse — any {@link MalformedReason}: SKILL.md frontmatter, an `x-abca-runtime`
 *  value, or a CUSTOM/MCP JSON body. Identity comes from the envelope, so the read
 *  paths can skip it (browse) or reject it (resolve/getRecord) precisely,
 *  without trusting the erased payload (#791). */
interface MalformedRecordEntry {
  readonly malformed: true;
  readonly coords: RecordCoords;
  readonly recordId: string;
  readonly error: RegistryRecordMalformedError;
}

type RecordEntry = RegistryRecord | MalformedRecordEntry;

function isMalformed(entry: RecordEntry): entry is MalformedRecordEntry {
  return (entry as MalformedRecordEntry).malformed === true;
}

/** Coordinates of an entry regardless of whether it parsed. */
function entryCoords(entry: RecordEntry): RecordCoords {
  return isMalformed(entry)
    ? entry.coords
    : {
      kind: entry.kind,
      namespace: entry.namespace,
      name: entry.name,
      version: entry.version,
      status: entry.status,
    };
}

/** Kinds that map onto a native Agent Registry record type. */
const NATIVE_RECORD_TYPE_BY_KIND: Record<string, 'MCP' | 'SKILL'> = {
  mcp_server: 'MCP',
  skill: 'SKILL',
};

/** Frontmatter key carrying the ABCA runtime payload (JSON) inside a native
 *  SKILL record's SKILL.md — the Agent Skills validator requires Markdown
 *  frontmatter (not JSON), so the MCP `_meta` convention can't be reused here. */
const SKILL_RUNTIME_FM_KEY = 'x-abca-runtime';
const SKILL_NAME_MAX = 64;

/** Derive a SKILL.md `name` from namespace/name: the Agent Skills validator
 *  requires 1-64 lowercase alphanumerics + single hyphens (no slash, no
 *  leading/trailing/consecutive hyphens). */
function skillNameSlug(namespace: string, name: string): string {
  return `${namespace}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SKILL_NAME_MAX)
    .replace(/-$/, '');
}

/** Build a valid SKILL.md (frontmatter + body) carrying discovery metadata and
 *  the ABCA runtime payload in the `x-abca-runtime` frontmatter key. */
function buildSkillMd(input: {
  namespace: string;
  name: string;
  version: string;
  discovery: Readonly<Record<string, unknown>>;
  runtime: unknown;
  publisher?: string;
}): string {
  const description = String(
    input.discovery.description ?? input.discovery.summary ?? `${input.namespace}/${input.name} skill`,
  ).slice(0, 100);
  // Base64-encode the runtime JSON so the value is quote/newline/apostrophe-safe.
  const runtimeB64 = Buffer.from(JSON.stringify(input.runtime), 'utf-8').toString('base64');
  // Serialize the frontmatter with a real YAML emitter rather than concatenating
  // lines. Hand-built lines let a caller-controlled `description` containing a
  // newline smuggle a second `x-abca-runtime:` key that shadows the validated
  // one on read, bypassing publish-time validation (#246 review B1/B2). `yaml.dump`
  // quotes/escapes any newline in a value, so no discovery field can inject a key.
  const frontmatter: Record<string, unknown> = {
    name: skillNameSlug(input.namespace, input.name),
    description,
    version: input.version,
    [SKILL_RUNTIME_FM_KEY]: runtimeB64,
  };
  if (input.publisher) frontmatter[PUBLISHER_FM_KEY] = input.publisher;
  const frontmatterYaml = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd();
  return [
    '---',
    frontmatterYaml,
    '---',
    `# ${input.namespace}/${input.name}`,
    '',
    String(input.discovery.body ?? 'ABCA registry skill.'),
  ].join('\n');
}

/** Extract and YAML-parse the frontmatter block (between the first `---`/`---`
 *  pair) into an object. Returns {} when there is *no* block at all (a record
 *  legitimately without frontmatter). A block that is present but fails to parse
 *  throws {@link RegistryRecordMalformedError} — it must NOT collapse to `{}`,
 *  which would erase the publisher/runtime and make a malformed record look
 *  empty (#791). Parsing the whole block as one YAML document (rather than a
 *  per-line regex) means a newline-bearing value stays inside its value instead
 *  of being read as a second key — but the injection defense proper is on the
 *  write side (`buildSkillMd` quotes/escapes via the YAML dumper). Note a
 *  *duplicate* key does not raise under `json: true` (last value wins), so this
 *  parse does not itself reject duplicate-key documents. */
function parseSkillFrontmatter(skillMd: string): Record<string, unknown> {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  let parsed: unknown;
  try {
    parsed = yaml.load(m[1], { json: true });
  } catch (err) {
    throw new RegistryRecordMalformedError(
      'MALFORMED_FRONTMATTER',
      `SKILL.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  // An empty block (`---\n\n---`) is a record legitimately without frontmatter.
  if (parsed === null || parsed === undefined) return {};
  // A block that parses to a non-mapping (a sequence `- a\n- b`, or a bare scalar)
  // is corrupt: collapsing it to `{}` would erase the publisher/runtime and let
  // `show`/`list` surface it as an ordinary healthy record while attribution is
  // silently gone. Reject it as MALFORMED, same as an unparseable block (#791).
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RegistryRecordMalformedError(
      'MALFORMED_FRONTMATTER',
      'SKILL.md frontmatter is not a mapping',
    );
  }
  return parsed as Record<string, unknown>;
}

/** Read a publisher (Cognito sub) field. Absent stays absent, but a *present but
 *  wrong-typed* value (`123`, `["sub"]`) is a MALFORMED descriptor — coercing it
 *  to `undefined` would silently erase attribution while the record stays
 *  APPROVED and loadable, which is #791's vulnerability verbatim. */
function readPublisherField(value: unknown, reason: MalformedReason): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new RegistryRecordMalformedError(reason, 'publisher field is present but not a string');
}

/** Recover the publisher (Cognito sub) from the parsed SKILL.md frontmatter. */
function parseSkillPublisher(skillMd: string): string | undefined {
  return readPublisherField(parseSkillFrontmatter(skillMd)[PUBLISHER_FM_KEY], 'MALFORMED_FRONTMATTER');
}

/** Recover the ABCA runtime payload from a SKILL.md's `x-abca-runtime`
 *  frontmatter key (base64-encoded JSON). Mirrors
 *  ``agent/src/registry/agent_registry_client.py``. Also accepts the legacy
 *  single-quoted-JSON form so records published before the base64 switch still
 *  resolve. Reads the key from the YAML-parsed frontmatter object, so a
 *  caller-controlled discovery field cannot inject a shadowing key. */
function parseSkillRuntime(skillMd: string): unknown {
  const raw = parseSkillFrontmatter(skillMd)[SKILL_RUNTIME_FM_KEY];
  if (typeof raw !== 'string') return {};
  // Legacy form: raw JSON (YAML has already unwrapped its single-quoting, so the
  // value arrives starting with `{`). New form: base64-encoded JSON. A present
  // but undecodable value must NOT slip out as a raw SyntaxError: box it as
  // MALFORMED so `loadRecordById` carries it as a marker and the read paths
  // skip/reject it precisely, exactly as they do for bad frontmatter (#791).
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed);
    }
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch (err) {
    throw new RegistryRecordMalformedError(
      'MALFORMED_RUNTIME',
      `SKILL.md ${SKILL_RUNTIME_FM_KEY} is not decodable base64/JSON: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

/** JSON.parse a descriptor body into an object, boxing any failure as a MALFORMED
 *  marker (rather than a raw SyntaxError/TypeError) so a corrupt CUSTOM/MCP body
 *  funnels through the same skip/reject read paths as bad SKILL.md frontmatter
 *  (#791). `JSON.parse` succeeds on non-objects too (`"null"`, `"[1,2]"`, `"123"`,
 *  `"\"s\""`), and the callers immediately dereference the result — so a
 *  successful parse that is not a plain object is rejected here rather than
 *  crashing the next line with an unboxed `TypeError` that would escape `resolve`
 *  as an opaque 500 and take down the whole namespace listing (#837 review). */
function parseDescriptorJson(data: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw new RegistryRecordMalformedError(
      'MALFORMED_DESCRIPTOR',
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RegistryRecordMalformedError(
      'MALFORMED_DESCRIPTOR',
      `${what} is not a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

export interface AgentRegistryClientOptions {
  readonly registryId: string;
  /** Injectable for tests; defaults to a real client in the target region. */
  readonly client?: AgentRegistryControlClient;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AgentRegistryClient implements RegistryClient {
  private readonly client: AgentRegistryControlClient;
  private readonly registryId: string;

  constructor(opts: AgentRegistryClientOptions) {
    this.registryId = opts.registryId;
    // makeClient attaches the ABCA solution UA segment (#319); the injection
    // seam (opts.client) is preserved for tests.
    this.client = opts.client ?? makeClient(AgentRegistryControlClient);
  }

  // --- name (Option A) encode/decode ------------------------------------------

  private encodeName(kind: string, namespace: string, name: string): string {
    return [kind, namespace, name].join(NAME_SEP);
  }

  private decodeName(recordName: string): { kind: string; namespace: string; name: string } {
    const [kind, namespace, ...rest] = recordName.split(NAME_SEP);
    return { kind, namespace, name: rest.join(NAME_SEP) };
  }

  // --- publish (3-call) -------------------------------------------------------

  async publish(input: PublishInput): Promise<RegistryRecord> {
    const useCustom = input.custom || !(input.kind in NATIVE_RECORD_TYPE_BY_KIND);
    const name = this.encodeName(input.kind, input.namespace, input.name);

    // Immutability: reject a re-publish of the same coordinates. `getRecord`
    // throws RegistryRecordMalformedError when a corrupt record already occupies
    // them — that is still an occupied slot, so treat it as a conflict (409) with
    // a corruption hint rather than letting it fall through to an opaque 500 that
    // names neither the conflict nor the corruption (#837 review).
    let existing: RegistryRecord | null;
    try {
      existing = await this.getRecord(input.kind, input.namespace, input.name, input.version);
    } catch (err) {
      if (err instanceof RegistryRecordMalformedError) {
        throw new ConflictException({
          message: `record ${name}@${input.version} already exists but its descriptor is malformed (${err.reason}); delete it before republishing`,
          $metadata: {},
        });
      }
      throw err;
    }
    if (existing) {
      throw new ConflictException({
        message: `record ${name}@${input.version} already exists`,
        $metadata: {},
      });
    }

    const descriptors = useCustom
      ? { custom: { data: JSON.stringify(this.customBody(input)) } }
      : this.nativeDescriptors(input);

    const res = await this.client.send(
      new CreateRegistryRecordCommand({
        registryId: this.registryId,
        name,
        recordType: useCustom ? 'CUSTOM' : NATIVE_RECORD_TYPE_BY_KIND[input.kind],
        descriptors,
        recordVersion: input.version,
      }),
    );
    const recordId = this.idFromArn(res.recordArn!);

    // The record now exists on the substrate. Any failure past this point leaves
    // a partial (DRAFT/PENDING_APPROVAL) record that immutability will block a
    // clean retry of — so surface the recordId in a typed error rather than a
    // bare 500, and log it, so an operator can approve or delete the orphan.
    try {
      // CreateRegistryRecord is async — wait until it leaves CREATING.
      await this.waitPastCreating(recordId);

      // Always submit for approval so a normal publish lands in PENDING_APPROVAL —
      // otherwise the record sits in DRAFT, which no ABCA surface can resolve or
      // promote (there is no standalone submit endpoint). Only the final APPROVED
      // transition is gated on autoApprove.
      await this.client.send(
        new SubmitRegistryRecordForApprovalCommand({ registryId: this.registryId, recordId }),
      );
      if (input.autoApprove) {
        await this.client.send(
          new UpdateRegistryRecordStatusCommand({
            registryId: this.registryId,
            recordId,
            status: 'APPROVED',
            statusReason: 'auto-approved on publish',
          }),
        );
      }

      const entry = await this.loadRecordById(recordId);
      if (!entry) throw new Error(`published record ${recordId} not readable after write`);
      // The record we just serialized should always parse; if it doesn't, the
      // write produced a corrupt descriptor — surface it (the catch below wraps
      // it as a stranded-record error) rather than returning it.
      if (isMalformed(entry)) throw entry.error;
      return entry;
    } catch (err) {
      logger.error('registry publish incomplete — partial record stranded', {
        recordId,
        name,
        version: input.version,
        error: String(err),
      });
      throw new RegistryPublishIncompleteError(
        recordId,
        `record ${name}@${input.version} was created (id ${recordId}) but could not be `
          + 'driven to a resolvable state; approve or delete it before retrying',
        err,
      );
    }
  }

  // --- get / list -------------------------------------------------------------

  async getRecord(
    kind: string,
    namespace: string,
    name: string,
    version: string,
  ): Promise<RegistryRecord | null> {
    // Agent Registry keys records by opaque id, not our coordinates, and List is
    // eventually consistent — so scan the (small) record set and match.
    const entries = await this.loadEntries({ kind, namespace });
    const match = entries.find(
      (e) => entryCoords(e).name === name && entryCoords(e).version === version,
    );
    if (!match) return null;
    // Fail closed on the targeted record: a malformed descriptor erased its
    // publisher/runtime, so hand back the parse failure rather than a record
    // with silently-dropped attribution (#791).
    if (isMalformed(match)) throw match.error;
    return match;
  }

  async listRecords(filter?: ListFilter): Promise<readonly RegistryRecord[]> {
    // Browse tolerates a poisoned record: skip a malformed one (with a loud
    // warning) so one corrupt SKILL.md can't break listing an entire namespace.
    // The trust-critical paths (resolve/getRecord) still reject it precisely.
    const entries = await this.loadEntries(filter);
    const out: RegistryRecord[] = [];
    for (const entry of entries) {
      if (isMalformed(entry)) {
        logger.warn('Skipping malformed registry record during list', {
          record_id: entry.recordId,
          kind: entry.coords.kind,
          namespace: entry.coords.namespace,
          name: entry.coords.name,
          version: entry.coords.version,
          error: entry.error.message,
        });
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  async listBrowseEntries(filter?: ListFilter): Promise<readonly RegistryBrowseEntry[]> {
    // Unlike listRecords, keep malformed records as envelope-only markers so
    // `show` can surface a corrupt version (flagged) instead of dropping it and
    // making an all-malformed asset look absent (#791).
    const entries = await this.loadEntries(filter);
    return entries.map((entry) => {
      if (isMalformed(entry)) {
        const { kind, namespace, name, version, status } = entry.coords;
        return { malformed: true, kind, namespace, name, version, status };
      }
      return { malformed: false, record: entry };
    });
  }

  /** Load every record matching `filter` as an entry that is either a parsed
   *  record or a malformed marker. O(n): List + one GetRegistryRecord per
   *  summary, and every read path (resolve/show/getRecord) funnels through here.
   *  Fine at MVP catalog sizes; revisit with a secondary coordinate index if
   *  large catalogs make the per-record round trips material. */
  private async loadEntries(filter?: ListFilter): Promise<RecordEntry[]> {
    const out: RecordEntry[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListRegistryRecordsCommand({
          registryId: this.registryId,
          nextToken,
          maxResults: 50,
        }),
      );
      for (const summary of page.registryRecords ?? []) {
        const decoded = this.decodeName(summary.name ?? '');
        if (filter?.kind && decoded.kind !== filter.kind) continue;
        if (filter?.namespace && decoded.namespace !== filter.namespace) continue;
        const recordId = summary.recordArn ? this.idFromArn(summary.recordArn) : summary.recordId;
        if (!recordId) continue;
        const entry = await this.loadRecordById(recordId);
        if (entry) out.push(entry);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return out;
  }

  // --- resolve ----------------------------------------------------------------

  async resolve(ref: ParsedRef): Promise<ResolvedAsset> {
    const refStr = `registry://${ref.kind}/${ref.namespace}/${ref.name}@${ref.constraint.raw}`;
    // Consider malformed entries as candidates too: a malformed record still has
    // a readable version/status from its envelope, so if it is the winning
    // version we must reject it rather than silently downgrade to a lower one.
    const all = await this.loadEntries({ kind: ref.kind, namespace: ref.namespace });
    const forName = all.filter((e) => entryCoords(e).name === ref.name);

    // Only APPROVED / DEPRECATED are resolution candidates.
    const candidates = forName.filter((e) => {
      const status = entryCoords(e).status;
      return status === 'APPROVED' || status === 'DEPRECATED';
    });
    const winningVersion = selectHighest(
      candidates.map((e) => entryCoords(e).version),
      ref.constraint,
    );
    if (!winningVersion) {
      throw new RegistryResolutionError(
        'NO_MATCHING_VERSION',
        refStr,
        `no approved version of ${ref.kind}/${ref.namespace}/${ref.name} satisfies ${ref.constraint.raw}`,
      );
    }
    const winner = candidates.find((e) => entryCoords(e).version === winningVersion)!;
    // Fail closed: the resolved winner's descriptor is unparseable, so its
    // publisher/runtime were erased. Reject rather than trust an empty payload
    // or silently pick a different version (#791).
    if (isMalformed(winner)) {
      // Keep the parser text (which can echo a fragment of the raw descriptor —
      // a token in a `url` query string, an `Authorization` header value) out of
      // the client-facing 422 body: resolve/list/show are open to any
      // authenticated caller (REGISTRY.md §10), and the resolve handler returns
      // this message verbatim, bypassing `redactRuntimeForResponse`. Surface only
      // the coordinates + the `MalformedReason` discriminator; log the detail for
      // the operator (#837 review).
      logger.error('resolve rejected a malformed winner', {
        recordId: winner.recordId,
        kind: winner.coords.kind,
        namespace: winner.coords.namespace,
        name: winner.coords.name,
        version: winner.coords.version,
        reason: winner.error.reason,
        error: winner.error.message,
      });
      throw new RegistryResolutionError(
        'MALFORMED',
        refStr,
        `resolved ${winner.coords.kind}/${winner.coords.namespace}/${winner.coords.name}@${winner.coords.version} has a malformed descriptor (${winner.error.reason})`,
      );
    }
    // Fail closed: an otherwise-resolvable record whose runtime payload is
    // empty must NOT resolve to `{}` — that would let a task run with a
    // missing/substituted asset while the audit claims the pin was honored
    // (REGISTRY.md §8). A record can reach this state via an out-of-band write;
    // a corrupt descriptor is caught above as MALFORMED.
    if (!isNonEmptyRuntime(winner.runtime)) {
      throw new RegistryResolutionError(
        'REMOVED',
        refStr,
        `resolved ${winner.kind}/${winner.namespace}/${winner.name}@${winner.version} has no loadable runtime payload`,
      );
    }
    const warnings = winner.status === 'DEPRECATED' ? ['DEPRECATED'] : [];
    return {
      kind: winner.kind,
      namespace: winner.namespace,
      name: winner.name,
      version: winner.version,
      runtime: winner.runtime,
      warnings,
    };
  }

  // --- internals --------------------------------------------------------------

  private idFromArn(arn: string): string {
    return arn.includes('/') ? arn.split('/').pop()! : arn;
  }

  /**
   * Poll a freshly-created record until it settles into a usable state.
   *
   * CreateRegistryRecord is async, so we must confirm the substrate actually
   * accepted the record before treating publish as successful. Prior behavior
   * returned on *any* non-`CREATING` status (so `CREATE_FAILED` looked like
   * success), treated a not-found as success (it's transient right after
   * create), and treated poll-budget exhaustion as success — any of which let
   * the handler return 201 for a record that never became usable (#246 review).
   *
   * Now: not-found and `CREATING` are transient (keep polling); any `*_FAILED`
   * status throws with the substrate's statusReason; reaching a usable state
   * (`DRAFT`/`PENDING_APPROVAL`/`APPROVED`) returns; exhausting the budget throws.
   */
  private async waitPastCreating(recordId: string): Promise<void> {
    for (let i = 0; i < RECORD_CREATE_MAX_POLLS; i++) {
      try {
        const rec = await this.client.send(
          new GetRegistryRecordCommand({ registryId: this.registryId, recordId }),
        );
        const status = String(rec.status ?? '');
        if (status.endsWith('_FAILED')) {
          throw new Error(
            `record ${recordId} entered ${status}${rec.statusReason ? `: ${rec.statusReason}` : ''}`,
          );
        }
        if (status && status !== 'CREATING') return; // DRAFT / PENDING_APPROVAL / APPROVED
      } catch (err) {
        // Transient right after CreateRegistryRecord — the record may not be
        // readable yet. Keep polling rather than declaring success.
        if (!(err instanceof ResourceNotFoundException)) throw err;
      }
      await sleep(RECORD_CREATE_POLL_MS);
    }
    throw new Error(
      `record ${recordId} did not leave CREATING within ${RECORD_CREATE_MAX_POLLS} polls`,
    );
  }

  private async loadRecordById(recordId: string): Promise<RecordEntry | null> {
    let raw;
    try {
      raw = await this.client.send(
        new GetRegistryRecordCommand({ registryId: this.registryId, recordId }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return null; // nosemgrep: ts-silent-success-masking -- service 404 is the port's absent-record contract
      }
      throw err;
    }
    const decoded = this.decodeName(raw.name ?? '');
    const coords: RecordCoords = {
      kind: decoded.kind,
      namespace: decoded.namespace,
      name: decoded.name,
      version: raw.recordVersion ?? '',
      status: (raw.status ?? 'DRAFT') as RegistryStatus,
    };
    let payload;
    try {
      payload = this.extractPayload(raw);
    } catch (err) {
      // A malformed descriptor payload keeps its envelope identity but its
      // publisher/runtime are unreadable — carry it as a marker so the read
      // paths can skip (browse) or reject (resolve/getRecord) it precisely.
      if (err instanceof RegistryRecordMalformedError) {
        return { malformed: true, coords, recordId, error: err };
      }
      throw err;
    }
    return {
      ...coords,
      storageMode: payload.storageMode,
      discovery: payload.discovery,
      runtime: payload.runtime,
      publisher: payload.publisher,
      createdAt: raw.createdAt ? raw.createdAt.toISOString() : undefined,
    };
  }

  /** Pull the ABCA runtime payload back out of the descriptor (native `_meta` or
   *  the verbatim CUSTOM body). */
  private extractPayload(raw: Pick<GetRegistryRecordCommandOutput, 'recordType' | 'descriptors'>): {
    runtime: RuntimePayload;
    storageMode: StorageMode;
    discovery: Record<string, unknown>;
    publisher?: string;
  } {
    if (raw.recordType === 'CUSTOM') {
      const body = parseDescriptorJson(raw.descriptors?.custom?.data ?? '{}', 'CUSTOM record body');
      return {
        runtime: body.runtime as RuntimePayload,
        storageMode: 'custom',
        discovery: (body.discovery ?? {}) as Record<string, unknown>,
        publisher: readPublisherField(body.publisher, 'MALFORMED_DESCRIPTOR'),
      };
    }
    if (raw.recordType === 'SKILL') {
      // SKILL.md is Markdown frontmatter, not JSON — recover the runtime from
      // the `x-abca-runtime` frontmatter key.
      const skillMd = raw.descriptors?.agentSkillsDefinition?.additionalData?.skillMd?.data ?? '';
      return {
        runtime: parseSkillRuntime(skillMd) as RuntimePayload,
        storageMode: 'native',
        discovery: { skillMd },
        publisher: parseSkillPublisher(skillMd),
      };
    }
    // MCP: JSON server.json with the runtime in a `_meta` block.
    const inline = raw.descriptors?.mcpServer?.data ?? '{}';
    const body = parseDescriptorJson(inline, 'MCP server.json body');
    const meta = body._meta && typeof body._meta === 'object' && !Array.isArray(body._meta)
      ? (body._meta as Record<string, unknown>)
      : {};
    return {
      runtime: meta[RUNTIME_META_KEY] as RuntimePayload,
      storageMode: 'native',
      discovery: body,
      publisher: readPublisherField(meta[PUBLISHER_META_KEY], 'MALFORMED_DESCRIPTOR'),
    };
  }

  private customBody(input: PublishInput): Record<string, unknown> {
    return {
      abca_kind: input.kind,
      discovery: input.discovery,
      runtime: input.runtime,
      ...(input.publisher && { publisher: input.publisher }),
    };
  }

  private nativeDescriptors(input: PublishInput): Descriptors {
    if (NATIVE_RECORD_TYPE_BY_KIND[input.kind] === 'MCP') {
      // MCP: embed the runtime + publisher in a `_meta` block on the validated
      // server.json. A valid server.json may legitimately carry its own `_meta`
      // (the MCP spec reserves it for arbitrary metadata), so merge our ABCA keys
      // into the caller's block rather than replacing it — clobbering it would
      // silently drop the publisher's metadata, and a future reorder could drop
      // our runtime on read (extractPayload reads `_meta[RUNTIME_META_KEY]`).
      const callerMeta =
        input.discovery._meta && typeof input.discovery._meta === 'object' && !Array.isArray(input.discovery._meta)
          ? (input.discovery._meta as Record<string, unknown>)
          : {};
      const meta: Record<string, unknown> = { ...callerMeta, [RUNTIME_META_KEY]: input.runtime };
      if (input.publisher) meta[PUBLISHER_META_KEY] = input.publisher;
      const withMeta = { ...input.discovery, _meta: meta };
      return { mcpServer: { data: JSON.stringify(withMeta) } };
    }
    // SKILL: the validator requires Markdown frontmatter (not JSON), so
    // the runtime rides in an `x-abca-runtime` frontmatter key inside SKILL.md.
    const skillMd = buildSkillMd({
      namespace: input.namespace,
      name: input.name,
      version: input.version,
      discovery: input.discovery,
      runtime: input.runtime,
      publisher: input.publisher,
    });
    return {
      agentSkillsDefinition: {
        additionalData: { skillMd: { data: skillMd } },
      },
    };
  }
}
