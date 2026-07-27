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
import type { RegistryClient } from './client';
import type { ParsedRef } from './ref';
import { selectHighest } from './resolver';
import {
  RUNTIME_META_KEY,
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
}): string {
  const description = String(
    input.discovery.description ?? input.discovery.summary ?? `${input.namespace}/${input.name} skill`,
  ).slice(0, 100);
  const runtimeJson = JSON.stringify(input.runtime);
  return [
    '---',
    `name: ${skillNameSlug(input.namespace, input.name)}`,
    `description: ${description}`,
    `version: ${input.version}`,
    `${SKILL_RUNTIME_FM_KEY}: '${runtimeJson}'`,
    '---',
    `# ${input.namespace}/${input.name}`,
    '',
    String(input.discovery.body ?? 'ABCA registry skill.'),
  ].join('\n');
}

/** Recover the ABCA runtime payload from a SKILL.md's `x-abca-runtime`
 *  frontmatter line. Mirrors ``agent/src/registry/agentcore_client.py``. */
function parseSkillRuntime(skillMd: string): unknown {
  const m = skillMd.match(new RegExp(`^${SKILL_RUNTIME_FM_KEY}:\\s*'(.+)'\\s*$`, 'm'));
  return m ? JSON.parse(m[1]) : {};
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

    let recordId: string;
    try {
      const res = await this.client.send(
        new CreateRegistryRecordCommand({
          registryId: this.registryId,
          name,
          descriptorType: useCustom ? 'CUSTOM' : NATIVE_DESCRIPTOR_BY_KIND[input.kind],
          descriptors,
          recordVersion: input.version,
        }),
      );
      recordId = this.idFromArn(res.recordArn!);
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      throw err;
    }

    // CreateRegistryRecord is async — wait until it leaves CREATING.
    await this.waitPastCreating(recordId);

    if (input.autoApprove) {
      // DRAFT -> PENDING_APPROVAL -> APPROVED (submit is a mandatory waypoint).
      await this.client.send(
        new SubmitRegistryRecordForApprovalCommand({ registryId: this.registryId, recordId }),
      );
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

  private async waitPastCreating(recordId: string): Promise<void> {
    for (let i = 0; i < RECORD_CREATE_MAX_POLLS; i++) {
      try {
        const rec = await this.client.send(
          new GetRegistryRecordCommand({ registryId: this.registryId, recordId }),
        );
        if (!String(rec.status).includes('CREATING')) return;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
      await sleep(RECORD_CREATE_POLL_MS);
    }
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
    const { runtime, storageMode, discovery } = this.extractPayload(raw);
    return {
      kind: decoded.kind,
      namespace: decoded.namespace,
      name: decoded.name,
      version: raw.recordVersion ?? '',
      status: (raw.status ?? 'DRAFT') as RegistryStatus,
      storageMode,
      discovery,
      runtime,
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
  }): { runtime: RuntimePayload; storageMode: StorageMode; discovery: Record<string, unknown> } {
    if (raw.descriptorType === 'CUSTOM') {
      const body = JSON.parse(raw.descriptors?.custom?.inlineContent ?? '{}');
      return {
        runtime: body.runtime as RuntimePayload,
        storageMode: 'custom',
        discovery: (body.discovery ?? {}) as Record<string, unknown>,
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
      };
    }
    // MCP: JSON server.json with the runtime in a `_meta` block.
    const inline = raw.descriptors?.mcp?.server?.inlineContent ?? '{}';
    const body = JSON.parse(inline);
    const meta = body._meta?.[RUNTIME_META_KEY];
    return {
      runtime: meta as RuntimePayload,
      storageMode: 'native',
      discovery: body as Record<string, unknown>,
    };
  }

  private customBody(input: PublishInput): Record<string, unknown> {
    return {
      abca_kind: input.kind,
      discovery: input.discovery,
      runtime: input.runtime,
    };
  }

  private nativeDescriptors(input: PublishInput): {
    mcp?: { server: { inlineContent: string } };
    agentSkills?: { skillMd: { inlineContent: string } };
  } {
    if (NATIVE_DESCRIPTOR_BY_KIND[input.kind] === 'MCP') {
      // MCP: embed the runtime in a `_meta` block on the validated server.json.
      const withMeta = { ...input.discovery, _meta: { [RUNTIME_META_KEY]: input.runtime } };
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
    });
    return { agentSkills: { skillMd: { inlineContent: skillMd } } };
  }
}
