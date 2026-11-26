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

// AWS Agent Registry (#246):
//   - Agent Registry has no namespace.
//   - CreateRegistryRecord is async and lands in DRAFT even with registry autoApproval.
//   - Agent Registry stores a plain version string.

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
const RECORD_CREATE_MAX_POLLS = 10;

function isNonEmptyRuntime(runtime: unknown): boolean {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    !Array.isArray(runtime) &&
    Object.keys(runtime as Record<string, unknown>).length > 0
  );
}

interface RecordCoords {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: RegistryStatus;
}

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

const NATIVE_RECORD_TYPE_BY_KIND: Record<string, 'MCP' | 'SKILL'> = {
  mcp_server: 'MCP',
  skill: 'SKILL',
};

/** The Agent Skills validator requires Markdown frontmatter (not JSON) in SKILL.md. */
const SKILL_RUNTIME_FM_KEY = 'x-abca-runtime';
const SKILL_NAME_MAX = 64;

/** For a SKILL.md `name` the Agent Skills validator
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
  const runtimeB64 = Buffer.from(JSON.stringify(input.runtime), 'utf-8').toString('base64');
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

/** js-yaml: a *duplicate* key does not raise under `json: true` (last value wins). */
function parseSkillFrontmatter(skillMd: string): Record<string, unknown> {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  let parsed: unknown;
  try {
    // `loadAll` plus a count rather than `load`: since js-yaml 5, `load` throws on a block
    // with no document in it (empty, blank lines, only comments), which 4.x answered with
    // undefined.
    const documents = yaml.loadAll(m[1], { json: true });
    if (documents.length > 1) {
      throw new Error('expected a single document in the stream, but found more');
    }
    parsed = documents[0];
  } catch (err) {
    throw new RegistryRecordMalformedError(
      'MALFORMED_FRONTMATTER',
      `SKILL.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RegistryRecordMalformedError(
      'MALFORMED_FRONTMATTER',
      'SKILL.md frontmatter is not a mapping',
    );
  }
  return parsed as Record<string, unknown>;
}

function readPublisherField(value: unknown, reason: MalformedReason): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new RegistryRecordMalformedError(reason, 'publisher field is present but not a string');
}

function parseSkillPublisher(skillMd: string): string | undefined {
  return readPublisherField(parseSkillFrontmatter(skillMd)[PUBLISHER_FM_KEY], 'MALFORMED_FRONTMATTER');
}

function parseSkillRuntime(skillMd: string): unknown {
  const raw = parseSkillFrontmatter(skillMd)[SKILL_RUNTIME_FM_KEY];
  if (typeof raw !== 'string') return {};
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
    this.client = opts.client ?? makeClient(AgentRegistryControlClient);
  }

  private encodeName(kind: string, namespace: string, name: string): string {
    return [kind, namespace, name].join(NAME_SEP);
  }

  private decodeName(recordName: string): { kind: string; namespace: string; name: string } {
    const [kind, namespace, ...rest] = recordName.split(NAME_SEP);
    return { kind, namespace, name: rest.join(NAME_SEP) };
  }

  async publish(input: PublishInput): Promise<RegistryRecord> {
    const useCustom = input.custom || !(input.kind in NATIVE_RECORD_TYPE_BY_KIND);
    const name = this.encodeName(input.kind, input.namespace, input.name);

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

    try {
      await this.waitPastCreating(recordId);

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

  async getRecord(
    kind: string,
    namespace: string,
    name: string,
    version: string,
  ): Promise<RegistryRecord | null> {
    // Agent Registry keys records by opaque id, not our coordinates, and List is
    // eventually consistent.
    const entries = await this.loadEntries({ kind, namespace, name });
    const match = entries.find(
      (e) => entryCoords(e).name === name && entryCoords(e).version === version,
    );
    if (!match) return null;
    if (isMalformed(match)) throw match.error;
    return match;
  }

  async listRecords(filter?: ListFilter): Promise<readonly RegistryRecord[]> {
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
    const entries = await this.loadEntries(filter);
    return entries.map((entry) => {
      if (isMalformed(entry)) {
        const { kind, namespace, name, version, status } = entry.coords;
        return { malformed: true, kind, namespace, name, version, status };
      }
      return { malformed: false, record: entry };
    });
  }

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
        if (filter?.name && decoded.name !== filter.name) continue;
        const recordId = summary.recordArn ? this.idFromArn(summary.recordArn) : summary.recordId;
        if (!recordId) continue;
        const entry = await this.loadRecordById(recordId);
        if (entry) out.push(entry);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return out;
  }

  async resolve(ref: ParsedRef): Promise<ResolvedAsset> {
    const refStr = `registry://${ref.kind}/${ref.namespace}/${ref.name}@${ref.constraint.raw}`;
    const all = await this.loadEntries({ kind: ref.kind, namespace: ref.namespace, name: ref.name });
    const forName = all.filter((e) => entryCoords(e).name === ref.name);

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
    if (isMalformed(winner)) {
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

  private idFromArn(arn: string): string {
    return arn.includes('/') ? arn.split('/').pop()! : arn;
  }

  /**
   * CreateRegistryRecord is async. Not-found, `CREATING` and a missing status are
   * transient right after the create.
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
        if (status && status !== 'CREATING') return;
      } catch (err) {
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
        return null;
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
      const skillMd = raw.descriptors?.agentSkillsDefinition?.additionalData?.skillMd?.data ?? '';
      return {
        runtime: parseSkillRuntime(skillMd) as RuntimePayload,
        storageMode: 'native',
        discovery: { skillMd },
        publisher: parseSkillPublisher(skillMd),
      };
    }
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
      // A valid server.json may legitimately carry its own `_meta`
      // (the MCP spec reserves it for arbitrary metadata).
      const callerMeta =
        input.discovery._meta && typeof input.discovery._meta === 'object' && !Array.isArray(input.discovery._meta)
          ? (input.discovery._meta as Record<string, unknown>)
          : {};
      const meta: Record<string, unknown> = { ...callerMeta, [RUNTIME_META_KEY]: input.runtime };
      if (input.publisher) meta[PUBLISHER_META_KEY] = input.publisher;
      const withMeta = { ...input.discovery, _meta: meta };
      return { mcpServer: { data: JSON.stringify(withMeta) } };
    }
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
