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

// The ONE AgentCore-aware implementation of the `RegistryClient` port (#246).
// This is the only file upstream of the port that imports the AWS SDK. It owns
// the substrate-specific decisions established by the live spikes
// (ISSUE_246_AGENTCORE_FINDINGS.md):
//
//   - namespace-in-`name` encoding (Option A): AgentCore has no namespace, so we
//     fold `kind/namespace/name` into the record `name` and split on read.
//   - native-vs-CUSTOM storage: purist native descriptors (MCP/AGENT_SKILLS)
//     by default, carrying ABCA runtime config in a `_meta` block; `custom:true`
//     stores a verbatim CUSTOM body instead.
//   - 3-call publish: CreateRegistryRecord is async and lands in DRAFT even with
//     registry autoApproval; `autoApprove` drives create→submit→approve.
//   - resolve ranks semver in code (AgentCore stores a plain version string).

import {
  BedrockAgentCoreControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
  ConflictException,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { logger } from '../logger';
import type { RegistryClient } from './client';
import type { ParsedRef } from './ref';
import { selectHighest } from './resolver';
import {
  PUBLISHER_FM_KEY,
  PUBLISHER_META_KEY,
  RUNTIME_META_KEY,
  RegistryPublishIncompleteError,
  RegistryResolutionError,
  type ListFilter,
  type PublishInput,
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

/** Kinds that map onto a native AgentCore descriptor type. */
const NATIVE_DESCRIPTOR_BY_KIND: Record<string, 'MCP' | 'AGENT_SKILLS'> = {
  mcp_server: 'MCP',
  skill: 'AGENT_SKILLS',
};

/** Frontmatter key carrying the ABCA runtime payload (JSON) inside a native
 *  AGENT_SKILLS SKILL.md — the AGENT_SKILLS validator requires Markdown
 *  frontmatter (not JSON), so the MCP `_meta` convention can't be reused here. */
const SKILL_RUNTIME_FM_KEY = 'x-abca-runtime';
const SKILL_NAME_MAX = 64;

/** Derive a SKILL.md `name` from namespace/name: the AGENT_SKILLS validator
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
  // Base64-encode the runtime JSON. Emitting raw JSON in a single-quoted YAML
  // scalar breaks the moment the payload contains a `'` (e.g. prompt_fragment
  // "Don't skip tests") — js-yaml rejects the frontmatter and native AgentCore
  // descriptor validation fails, even though the ABCA API accepted it (#246
  // review). Base64 is quote/newline/apostrophe-safe and needs no YAML escaping.
  const runtimeB64 = Buffer.from(JSON.stringify(input.runtime), 'utf-8').toString('base64');
  const lines = [
    '---',
    `name: ${skillNameSlug(input.namespace, input.name)}`,
    `description: ${description}`,
    `version: ${input.version}`,
    `${SKILL_RUNTIME_FM_KEY}: ${runtimeB64}`,
  ];
  if (input.publisher) lines.push(`${PUBLISHER_FM_KEY}: ${input.publisher}`);
  lines.push(
    '---',
    `# ${input.namespace}/${input.name}`,
    '',
    String(input.discovery.body ?? 'ABCA registry skill.'),
  );
  return lines.join('\n');
}

/** Recover the publisher (Cognito sub) from a SKILL.md frontmatter line. */
function parseSkillPublisher(skillMd: string): string | undefined {
  const m = skillMd.match(new RegExp(`^${PUBLISHER_FM_KEY}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1] : undefined;
}

/** Recover the ABCA runtime payload from a SKILL.md's `x-abca-runtime`
 *  frontmatter line (base64-encoded JSON). Mirrors
 *  ``agent/src/registry/agentcore_client.py``. Also accepts the legacy
 *  single-quoted-JSON form so records published before the base64 switch still
 *  resolve. */
function parseSkillRuntime(skillMd: string): unknown {
  const line = skillMd.match(new RegExp(`^${SKILL_RUNTIME_FM_KEY}:\\s*(.+?)\\s*$`, 'm'));
  if (!line) return {};
  const raw = line[1];
  // Legacy form: '<json>' (single-quoted). New form: bare base64.
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return JSON.parse(raw.slice(1, -1));
  }
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
}

export interface AgentCoreRegistryClientOptions {
  readonly registryId: string;
  /** Injectable for tests; defaults to a real client in the target region. */
  readonly client?: BedrockAgentCoreControlClient;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AgentCoreRegistryClient implements RegistryClient {
  private readonly client: BedrockAgentCoreControlClient;
  private readonly registryId: string;

  constructor(opts: AgentCoreRegistryClientOptions) {
    this.registryId = opts.registryId;
    this.client = opts.client ?? new BedrockAgentCoreControlClient({});
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
    const useCustom = input.custom || !(input.kind in NATIVE_DESCRIPTOR_BY_KIND);
    const name = this.encodeName(input.kind, input.namespace, input.name);

    // Immutability: reject a re-publish of the same coordinates.
    const existing = await this.getRecord(input.kind, input.namespace, input.name, input.version);
    if (existing) {
      throw new ConflictException({
        message: `record ${name}@${input.version} already exists`,
        $metadata: {},
      });
    }

    const descriptors = useCustom
      ? { custom: { inlineContent: JSON.stringify(this.customBody(input)) } }
      : this.nativeDescriptors(input);

    const res = await this.client.send(
      new CreateRegistryRecordCommand({
        registryId: this.registryId,
        name,
        descriptorType: useCustom ? 'CUSTOM' : NATIVE_DESCRIPTOR_BY_KIND[input.kind],
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

      const record = await this.getRecordById(recordId);
      if (!record) throw new Error(`published record ${recordId} not readable after write`);
      return record;
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
    // AgentCore keys records by opaque id, not our coordinates, and List is
    // eventually consistent — so scan the (small) record set and match.
    const records = await this.listRecords({ kind, namespace });
    return records.find((r) => r.name === name && r.version === version) ?? null;
  }

  async listRecords(filter?: ListFilter): Promise<readonly RegistryRecord[]> {
    // TODO(GA): O(n) — List + one GetRegistryRecord per summary, and every read
    // path (resolve/show/getRecord) funnels through here. Fine at MVP catalog
    // sizes; revisit when the native AgentCore construct lands (server-side
    // filter / batch get) so large catalogs don't pay a per-record round trip.
    const out: RegistryRecord[] = [];
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
        const full = await this.getRecordById(recordId);
        if (full) out.push(full);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return out;
  }

  // --- resolve ----------------------------------------------------------------

  async resolve(ref: ParsedRef): Promise<ResolvedAsset> {
    const refStr = `registry://${ref.kind}/${ref.namespace}/${ref.name}@${ref.constraint.raw}`;
    const all = await this.listRecords({ kind: ref.kind, namespace: ref.namespace });
    const forName = all.filter((r) => r.name === ref.name);

    // Only APPROVED / DEPRECATED are resolution candidates.
    const candidates = forName.filter(
      (r) => r.status === 'APPROVED' || r.status === 'DEPRECATED',
    );
    const winningVersion = selectHighest(
      candidates.map((r) => r.version),
      ref.constraint,
    );
    if (!winningVersion) {
      throw new RegistryResolutionError(
        'NO_MATCHING_VERSION',
        refStr,
        `no approved version of ${ref.kind}/${ref.namespace}/${ref.name} satisfies ${ref.constraint.raw}`,
      );
    }
    const winner = candidates.find((r) => r.version === winningVersion)!;
    // Fail closed: an otherwise-resolvable record whose runtime payload is
    // empty/unreadable must NOT resolve to `{}` — that would let a task run with
    // a missing/substituted asset while the audit claims the pin was honored
    // (REGISTRY.md §8). A record can reach this state via an out-of-band write or
    // a corrupt `_meta`/CUSTOM body that slipped past publish validation.
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

  private async getRecordById(recordId: string): Promise<RegistryRecord | null> {
    let raw;
    try {
      raw = await this.client.send(
        new GetRegistryRecordCommand({ registryId: this.registryId, recordId }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
    const decoded = this.decodeName(raw.name ?? '');
    const { runtime, storageMode, discovery, publisher } = this.extractPayload(raw);
    return {
      kind: decoded.kind,
      namespace: decoded.namespace,
      name: decoded.name,
      version: raw.recordVersion ?? '',
      status: (raw.status ?? 'DRAFT') as RegistryStatus,
      storageMode,
      discovery,
      runtime,
      publisher,
      createdAt: raw.createdAt ? raw.createdAt.toISOString() : undefined,
    };
  }

  /** Pull the ABCA runtime payload back out of the descriptor (native `_meta` or
   *  the verbatim CUSTOM body). */
  private extractPayload(raw: {
    descriptorType?: string;
    descriptors?: {
      custom?: { inlineContent?: string };
      mcp?: { server?: { inlineContent?: string } };
      agentSkills?: { skillMd?: { inlineContent?: string } };
    };
  }): {
    runtime: RuntimePayload;
    storageMode: StorageMode;
    discovery: Record<string, unknown>;
    publisher?: string;
  } {
    if (raw.descriptorType === 'CUSTOM') {
      const body = JSON.parse(raw.descriptors?.custom?.inlineContent ?? '{}');
      return {
        runtime: body.runtime as RuntimePayload,
        storageMode: 'custom',
        discovery: (body.discovery ?? {}) as Record<string, unknown>,
        publisher: typeof body.publisher === 'string' ? body.publisher : undefined,
      };
    }
    if (raw.descriptorType === 'AGENT_SKILLS') {
      // SKILL.md is Markdown frontmatter, not JSON — recover the runtime from
      // the `x-abca-runtime` frontmatter key.
      const skillMd = raw.descriptors?.agentSkills?.skillMd?.inlineContent ?? '';
      return {
        runtime: parseSkillRuntime(skillMd) as RuntimePayload,
        storageMode: 'native',
        discovery: { skillMd },
        publisher: parseSkillPublisher(skillMd),
      };
    }
    // MCP: JSON server.json with the runtime in a `_meta` block.
    const inline = raw.descriptors?.mcp?.server?.inlineContent ?? '{}';
    const body = JSON.parse(inline);
    const meta = body._meta?.[RUNTIME_META_KEY];
    const publisher = body._meta?.[PUBLISHER_META_KEY];
    return {
      runtime: meta as RuntimePayload,
      storageMode: 'native',
      discovery: body as Record<string, unknown>,
      publisher: typeof publisher === 'string' ? publisher : undefined,
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

  private nativeDescriptors(input: PublishInput): {
    mcp?: { server: { inlineContent: string } };
    agentSkills?: { skillMd: { inlineContent: string } };
  } {
    if (NATIVE_DESCRIPTOR_BY_KIND[input.kind] === 'MCP') {
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
      return { mcp: { server: { inlineContent: JSON.stringify(withMeta) } } };
    }
    // AGENT_SKILLS: the validator requires Markdown frontmatter (not JSON), so
    // the runtime rides in an `x-abca-runtime` frontmatter key inside SKILL.md.
    const skillMd = buildSkillMd({
      namespace: input.namespace,
      name: input.name,
      version: input.version,
      discovery: input.discovery,
      runtime: input.runtime,
      publisher: input.publisher,
    });
    return { agentSkills: { skillMd: { inlineContent: skillMd } } };
  }
}
