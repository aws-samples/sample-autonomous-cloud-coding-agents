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

import {
  ConflictException,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
} from '@aws-sdk/client-agent-registry-control';
import { AgentRegistryClient } from '../../../src/handlers/shared/registry/agent-registry-client';
import { parseRef } from '../../../src/handlers/shared/registry/ref';
import {
  RegistryPublishIncompleteError,
  RegistryRecordMalformedError,
  RegistryResolutionError,
} from '../../../src/handlers/shared/registry/types';

const RUNTIME_META_KEY = 'dev.abca.runtime';

class FakeClient {
  private records = new Map<string, Record<string, unknown>>();
  private seq = 0;
  public sent: string[] = [];
  public settleStatus = 'DRAFT';
  public settleReason?: string;
  public failSubmit = false;

  seed(record: Record<string, unknown>): string {
    const id = `rec-${++this.seq}`;
    this.records.set(id, { ...record, recordId: id });
    return id;
  }

  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof CreateRegistryRecordCommand) {
      this.sent.push('create');
      const input = cmd.input as {
        name?: string;
        recordType?: string;
        descriptors?: {
          agentSkillsDefinition?: {
            additionalData?: { skillMd?: { data?: string } };
          };
        };
        recordVersion?: string;
      };
      if (input.recordType === 'SKILL') {
        const md =
          input.descriptors?.agentSkillsDefinition?.additionalData?.skillMd?.data ?? '';
        if (!md.startsWith('---')) {
          throw new Error("agentSkillsDefinition.skillMd data must start with frontmatter delimited by '---'");
        }
      }
      const id = `rec-${++this.seq}`;
      this.records.set(id, {
        recordId: id,
        recordArn: `arn:aws:agent-registry:us-east-1:123456789012:registry/AbCdEfGh1234/record/${id}`,
        name: input.name,
        recordType: input.recordType,
        descriptors: input.descriptors,
        recordVersion: input.recordVersion,
        status: 'CREATING',
      });
      return {
        recordArn:
          `arn:aws:agent-registry:us-east-1:123456789012:registry/AbCdEfGh1234/record/${id}`,
        status: 'CREATING',
      };
    }
    if (cmd instanceof GetRegistryRecordCommand) {
      const id = (cmd.input as { recordId: string }).recordId;
      const rec = this.records.get(id);
      if (rec && rec.status === 'CREATING' && this.settleStatus !== 'CREATING') {
        rec.status = this.settleStatus;
        if (this.settleReason) rec.statusReason = this.settleReason;
      }
      return rec ?? {};
    }
    if (cmd instanceof ListRegistryRecordsCommand) {
      return { registryRecords: [...this.records.values()], nextToken: undefined };
    }
    if (cmd instanceof SubmitRegistryRecordForApprovalCommand) {
      this.sent.push('submit');
      if (this.failSubmit) throw new Error('submit rejected by substrate');
      const id = (cmd.input as { recordId: string }).recordId;
      const rec = this.records.get(id);
      if (rec) rec.status = 'PENDING_APPROVAL';
      return { status: 'PENDING_APPROVAL' };
    }
    if (cmd instanceof UpdateRegistryRecordStatusCommand) {
      this.sent.push('approve');
      const { recordId, status } = cmd.input as { recordId: string; status: string };
      const rec = this.records.get(recordId);
      if (rec) rec.status = status;
      return { status };
    }
    throw new Error(`unexpected command ${cmd?.constructor?.name}`);
  }
}

function makeClient(fake: FakeClient): AgentRegistryClient {
  return new AgentRegistryClient({
    registryId: 'AbCdEfGh1234',
    client: fake as never,
  });
}

describe('AgentRegistryClient', () => {
  test('publish (native + autoApprove) drives create → submit → approve and embeds _meta', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const runtime = { transport: 'http' as const, url: 'https://x/sse', tool_prefix: 'mcp__x__' };

    const record = await client.publish({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
      runtime,
      autoApprove: true,
    });

    expect(fake.sent).toEqual(['create', 'submit', 'approve']);
    expect(record.status).toBe('APPROVED');
    expect(record.storageMode).toBe('native');
    expect(record.runtime).toEqual(runtime);
    expect((record.discovery as Record<string, unknown>)._meta).toMatchObject({ [RUNTIME_META_KEY]: runtime });
  });

  test('publish (custom) round-trips runtime verbatim in the CUSTOM body', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const runtime = { cedar_text: 'permit(principal, action, resource);' };
    const record = await client.publish({
      kind: 'cedar_policy_module',
      namespace: 'acme',
      name: 'permit-all',
      version: '1.0.0',
      discovery: { summary: 's' },
      runtime,
    });
    expect(record.storageMode).toBe('custom');
    expect(record.runtime).toEqual(runtime);
  });

  test('publish (native skill) emits valid SKILL.md frontmatter + round-trips runtime', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const runtime = { prompt_fragment: 'Always add a trailing note when editing.', tool_hints: ['Edit'] };
    const record = await client.publish({
      kind: 'skill',
      namespace: 'acme',
      name: 'readme-helper',
      version: '1.0.0',
      discovery: { description: 'Appends a note when editing files' },
      runtime,
      autoApprove: true,
    });
    expect(record.status).toBe('APPROVED');
    expect(record.storageMode).toBe('native');
    expect(record.runtime).toEqual(runtime);
  });

  test('publish (native skill) round-trips a prompt_fragment containing an apostrophe', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const runtime = { prompt_fragment: "Don't skip tests; it's required.", tool_hints: ["Don't"] };
    const record = await client.publish({
      kind: 'skill',
      namespace: 'acme',
      name: 'strict-tester',
      version: '1.0.0',
      discovery: { description: 'Insists on tests' },
      runtime,
      autoApprove: true,
    });
    expect(record.runtime).toEqual(runtime);
    const skillMd = (record.discovery as { skillMd: string }).skillMd;
    const line = skillMd.split('\n').find((l) => l.startsWith('x-abca-runtime:'))!;
    expect(line).not.toContain('prompt_fragment');
  });

  test('publish (native skill) — a newline-bearing description cannot inject a shadowing runtime key (#246 B1)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const injectedB64 = Buffer.from(JSON.stringify({ prompt_fragment: 'INJECTED-EXFIL' }), 'utf-8').toString('base64');
    const record = await client.publish({
      kind: 'skill',
      namespace: 'acme',
      name: 'tdd',
      version: '1.0.0',
      discovery: { description: `benign\nx-abca-runtime: ${injectedB64}` },
      runtime: { prompt_fragment: 'THE VALIDATED BENIGN FRAGMENT' },
      autoApprove: true,
    });
    expect(record.runtime).toEqual({ prompt_fragment: 'THE VALIDATED BENIGN FRAGMENT' });
    expect(JSON.stringify(record.runtime)).not.toContain('INJECTED-EXFIL');
  });

  test('publish rejects a duplicate (kind,namespace,name,version)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const input = {
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
      runtime: { transport: 'http' as const, url: 'https://x' },
      autoApprove: true,
    };
    await client.publish(input);
    await expect(client.publish(input)).rejects.toThrow();
  });

  test('publish stamps + round-trips the publisher across MCP, skill, and CUSTOM', async () => {
    const cases = [
      { kind: 'mcp_server', runtime: { transport: 'http' as const, url: 'https://x' }, discovery: { name: 'acme/a', description: 'd', version: '1.0.0' } },
      { kind: 'skill', runtime: { prompt_fragment: 'note' }, discovery: { description: 'd' } },
      { kind: 'cedar_policy_module', runtime: { cedar_text: 'permit(principal, action, resource);' }, discovery: { summary: 's' } },
    ];
    for (const c of cases) {
      const client = makeClient(new FakeClient());
      const record = await client.publish({
        kind: c.kind,
        namespace: 'acme',
        name: 'thing',
        version: '1.0.0',
        discovery: c.discovery,
        runtime: c.runtime as never,
        publisher: 'cognito-sub-123',
        autoApprove: true,
      });
      expect(record.publisher).toBe('cognito-sub-123');
    }
  });

  test('publish without autoApprove still submits, landing in PENDING_APPROVAL (not DRAFT)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const record = await client.publish({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
      runtime: { transport: 'http' as const, url: 'https://x' },
    });
    expect(fake.sent).toEqual(['create', 'submit']);
    expect(record.status).toBe('PENDING_APPROVAL');
  });

  test('publish throws (not 201) when the record settles into CREATE_FAILED', async () => {
    const fake = new FakeClient();
    fake.settleStatus = 'CREATE_FAILED';
    fake.settleReason = 'descriptor rejected by substrate';
    const client = makeClient(fake);
    const err = await client.publish({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
      runtime: { transport: 'http' as const, url: 'https://x' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryPublishIncompleteError);
    expect((err as RegistryPublishIncompleteError).recordId).toBeTruthy();
    expect(String((err as RegistryPublishIncompleteError).cause)).toMatch(/CREATE_FAILED.*descriptor rejected/);
    expect(fake.sent).toEqual(['create']);
  });

  test('publish wraps a post-create submit failure in RegistryPublishIncompleteError', async () => {
    const fake = new FakeClient();
    fake.failSubmit = true;
    const client = makeClient(fake);
    const err = await client.publish({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
      runtime: { transport: 'http' as const, url: 'https://x' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryPublishIncompleteError);
    expect((err as RegistryPublishIncompleteError).recordId).toBeTruthy();
    expect((err as RegistryPublishIncompleteError).message).toContain('approve or delete it before retrying');
    expect(fake.sent).toEqual(['create', 'submit']);
  });

  test('publish throws when the record never leaves CREATING (poll budget exhausted)', async () => {
    jest.useFakeTimers();
    try {
      const fake = new FakeClient();
      fake.settleStatus = 'CREATING';
      const client = makeClient(fake);
      const startedAt = Date.now();
      const p = client.publish({
        kind: 'mcp_server',
        namespace: 'acme',
        name: 'pdf-tools',
        version: '1.0.0',
        discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
        runtime: { transport: 'http' as const, url: 'https://x' },
      });
      // eslint-disable-next-line jest/valid-expect -- handler attached before the timers advance, awaited below
      const assertion = expect(p).rejects.toBeInstanceOf(RegistryPublishIncompleteError);
      const causeAssertion = p.catch((e: unknown) => {
        expect(String((e as RegistryPublishIncompleteError).cause)).toMatch(/did not leave CREATING/);
      });
      await jest.runAllTimersAsync();
      await assertion;
      await causeAssertion;
      expect(fake.sent).toEqual(['create']);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(25_000);
    } finally {
      jest.useRealTimers();
    }
  });

  test('resolve picks the highest APPROVED version matching the constraint', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const seedMcp = (version: string, status: string): void => {
      fake.seed({
        name: 'mcp_server/acme/pdf-tools',
        recordType: 'MCP',
        descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/pdf-tools', version, _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: `https://x/${version}` } } }) } },
        recordVersion: version,
        status,
      });
    };
    seedMcp('1.4.1', 'APPROVED');
    seedMcp('1.9.9', 'APPROVED');
    seedMcp('2.0.0', 'APPROVED');
    seedMcp('1.9.10', 'DRAFT');

    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@^1.4.1');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    const asset = await client.resolve(parsed.ref);
    expect(asset.version).toBe('1.9.9');
    expect(asset.warnings).toEqual([]);
    expect(asset.runtime).toMatchObject({ url: 'https://x/1.9.9' });
  });

  test('resolve warns on a DEPRECATED winner', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/pdf-tools', version: '1.4.1', _meta: { [RUNTIME_META_KEY]: { transport: 'http' } } }) } },
      recordVersion: '1.4.1',
      status: 'DEPRECATED',
    });
    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.4.1');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    const asset = await client.resolve(parsed.ref);
    expect(asset.version).toBe('1.4.1');
    expect(asset.warnings).toEqual(['DEPRECATED']);
  });

  test('resolve fails NO_MATCHING_VERSION when only non-candidate statuses exist', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/pdf-tools', version: '1.4.1' }) } },
      recordVersion: '1.4.1',
      status: 'PENDING_APPROVAL',
    });
    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@^1.4.1');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({
      reason: 'NO_MATCHING_VERSION',
    });
    await expect(client.resolve(parsed.ref)).rejects.toBeInstanceOf(RegistryResolutionError);
  });

  test('resolve fails closed (REMOVED) when an APPROVED record has an empty runtime', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/pdf-tools', version: '1.4.1' }) } },
      recordVersion: '1.4.1',
      status: 'APPROVED',
    });
    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.4.1');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'REMOVED' });
    await expect(client.resolve(parsed.ref)).rejects.toBeInstanceOf(RegistryResolutionError);
  });

  const seedMalformedSkill = (fake: FakeClient, status = 'APPROVED'): string =>
    fake.seed({
      name: 'skill/acme/readme-helper',
      recordType: 'SKILL',
      descriptors: {
        agentSkillsDefinition: {
          additionalData: { skillMd: { data: '---\nname: acme-readme-helper\nx-abca-runtime: [1, 2\n---\n# body' } },
        },
      },
      recordVersion: '1.0.0',
      status,
    });

  test('resolve fails closed (MALFORMED) when the winning record has unparseable frontmatter', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedMalformedSkill(fake);
    const parsed = parseRef('registry://skill/acme/readme-helper@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
    await expect(client.resolve(parsed.ref)).rejects.toBeInstanceOf(RegistryResolutionError);
  });

  test('resolve rejects a malformed winner rather than downgrading to a lower valid version', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'skill/acme/readme-helper',
      recordType: 'SKILL',
      descriptors: {
        agentSkillsDefinition: {
          additionalData: {
            skillMd: {
              data:
                `---\nname: acme-readme-helper\nx-abca-runtime: ${Buffer.from(JSON.stringify({ prompt_fragment: 'ok' })).toString('base64')}\n---\n# body`,
            },
          },
        },
      },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    fake.seed({
      name: 'skill/acme/readme-helper',
      recordType: 'SKILL',
      descriptors: {
        agentSkillsDefinition: {
          additionalData: { skillMd: { data: '---\nname: acme-readme-helper\nx-abca-runtime: [1, 2\n---\n# body' } },
        },
      },
      recordVersion: '1.1.0',
      status: 'APPROVED',
    });
    const parsed = parseRef('registry://skill/acme/readme-helper@^1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  const seedCorruptRuntimeSkill = (fake: FakeClient, status = 'APPROVED'): string =>
    fake.seed({
      name: 'skill/acme/readme-helper',
      recordType: 'SKILL',
      descriptors: {
        agentSkillsDefinition: {
          additionalData: {
            skillMd: {
              data: `---\nname: acme-readme-helper\nx-abca-runtime: ${Buffer.from('not json').toString('base64')}\n---\n# body`,
            },
          },
        },
      },
      recordVersion: '1.0.0',
      status,
    });

  const seedCorruptCustom = (fake: FakeClient, status = 'APPROVED'): string =>
    fake.seed({
      name: 'cedar_policy_module/acme/permit',
      recordType: 'CUSTOM',
      descriptors: { custom: { data: 'not json{' } },
      recordVersion: '1.0.0',
      status,
    });

  const seedCorruptMcp = (fake: FakeClient, status = 'APPROVED'): string =>
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: '{bad json' } },
      recordVersion: '1.0.0',
      status,
    });

  test('resolve fails closed (MALFORMED) when x-abca-runtime is undecodable base64/JSON', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedCorruptRuntimeSkill(fake);
    const parsed = parseRef('registry://skill/acme/readme-helper@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
    await expect(client.resolve(parsed.ref)).rejects.toBeInstanceOf(RegistryResolutionError);
  });

  test('resolve fails closed (MALFORMED) when a CUSTOM body is not valid JSON', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedCorruptCustom(fake);
    const parsed = parseRef('registry://cedar_policy_module/acme/permit@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  test('resolve fails closed (MALFORMED) when an MCP server.json is not valid JSON', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedCorruptMcp(fake);
    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  test('listRecords tolerates a corrupt CUSTOM/MCP/runtime record (skips, does not abort the namespace)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedCorruptRuntimeSkill(fake);
    seedCorruptCustom(fake);
    seedCorruptMcp(fake);
    fake.seed({
      name: 'mcp_server/acme/healthy',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/healthy', version: '1.0.0', _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: 'https://x' } } }) } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const records = await client.listRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'mcp_server', name: 'healthy' });
  });

  test('getRecord throws RegistryRecordMalformedError for a corrupt-runtime target record', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedCorruptRuntimeSkill(fake, 'DRAFT');
    await expect(client.getRecord('skill', 'acme', 'readme-helper', '1.0.0')).rejects.toBeInstanceOf(
      RegistryRecordMalformedError,
    );
  });

  test('getRecord throws RegistryRecordMalformedError for a malformed target record', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedMalformedSkill(fake, 'DRAFT');
    await expect(client.getRecord('skill', 'acme', 'readme-helper', '1.0.0')).rejects.toBeInstanceOf(
      RegistryRecordMalformedError,
    );
  });

  test('listRecords skips a malformed record but returns the healthy ones', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedMalformedSkill(fake);
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/pdf-tools', version: '1.0.0', _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: 'https://x' } } }) } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const records = await client.listRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'mcp_server', name: 'pdf-tools' });
  });

  test('listBrowseEntries keeps a malformed record as an envelope-only marker', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedMalformedSkill(fake);
    const entries = await client.listBrowseEntries({ kind: 'skill', namespace: 'acme' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      malformed: true,
      kind: 'skill',
      namespace: 'acme',
      name: 'readme-helper',
      version: '1.0.0',
      status: 'APPROVED',
    });
  });

  test('listBrowseEntries wraps a healthy record under { malformed: false, record }', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/pdf-tools', version: '1.0.0', _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: 'https://x' } } }) } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const entries = await client.listBrowseEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ malformed: false, record: { kind: 'mcp_server', name: 'pdf-tools' } });
  });

  test('publish (native MCP) preserves a caller-supplied discovery._meta alongside ABCA keys', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const runtime = { transport: 'http', url: 'https://x' } as const;
    const record = await client.publish({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      discovery: { name: 'acme/pdf-tools', version: '1.0.0', _meta: { 'io.example.custom': { keep: true } } },
      runtime,
      autoApprove: true,
    });
    const meta = (record.discovery as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta).toMatchObject({ [RUNTIME_META_KEY]: runtime, 'io.example.custom': { keep: true } });
  });

  const seedHealthyMcp = (fake: FakeClient, meta: Record<string, unknown>, status = 'APPROVED'): string =>
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: {
        mcpServer: {
          data: JSON.stringify({
            name: 'acme/pdf-tools',
            version: '1.0.0',
            _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: 'https://x' }, ...meta },
          }),
        },
      },
      recordVersion: '1.0.0',
      status,
    });

  test('resolve/getRecord preserve a healthy record publisher (read-path positive control)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedHealthyMcp(fake, { 'dev.abca.publisher': 'cognito-sub-999' });
    const record = await client.getRecord('mcp_server', 'acme', 'pdf-tools', '1.0.0');
    expect(record?.publisher).toBe('cognito-sub-999');
  });

  test.each([
    ['a number', 123],
    ['an array', ['cognito-sub']],
    ['an object', { sub: 'x' }],
    ['null', null],
  ])('getRecord rejects a healthy record whose publisher is %s (MALFORMED, not silent drop)', async (_label, badPublisher) => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedHealthyMcp(fake, { 'dev.abca.publisher': badPublisher });
    await expect(client.getRecord('mcp_server', 'acme', 'pdf-tools', '1.0.0')).rejects.toBeInstanceOf(
      RegistryRecordMalformedError,
    );
  });

  const seedNeighbours = (fake: FakeClient): void => {
    for (const name of ['other-a', 'other-b', 'other-c']) {
      fake.seed({
        name: `mcp_server/acme/${name}`,
        recordType: 'MCP',
        descriptors: { mcpServer: { data: JSON.stringify({ name: `acme/${name}`, version: '1.0.0', _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: 'https://x' } } }) } },
        recordVersion: '1.0.0',
        status: 'APPROVED',
      });
    }
  };
  const recordsFetched = (send: jest.SpyInstance): number =>
    send.mock.calls.filter(([cmd]) => cmd instanceof GetRegistryRecordCommand).length;

  test('resolve fetches the records of the asset it resolves, not those of its neighbours', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedNeighbours(fake);
    seedHealthyMcp(fake, {});
    const send = jest.spyOn(fake, 'send');

    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    const asset = await client.resolve(parsed.ref);

    expect(asset).toMatchObject({ name: 'pdf-tools', version: '1.0.0' });
    expect(recordsFetched(send)).toBe(1);
  });

  test('getRecord (the publish pre-check) fetches no record of another asset', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedNeighbours(fake);
    const send = jest.spyOn(fake, 'send');

    expect(await client.getRecord('mcp_server', 'acme', 'pdf-tools', '1.0.0')).toBeNull();
    expect(recordsFetched(send)).toBe(0);
  });

  test('listBrowseEntries filtered by name fetches and returns that asset only', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedNeighbours(fake);
    seedHealthyMcp(fake, {});
    const send = jest.spyOn(fake, 'send');

    const entries = await client.listBrowseEntries({ kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ malformed: false, record: { name: 'pdf-tools' } });
    expect(recordsFetched(send)).toBe(1);
  });

  test.each([
    ['null', 'null'],
    ['a number', '123'],
    ['an array', '[1, 2]'],
    ['a string', '"just a string"'],
  ])('resolve fails closed (MALFORMED) when a CUSTOM body parses to %s', async (_label, data) => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'cedar_policy_module/acme/permit',
      recordType: 'CUSTOM',
      descriptors: { custom: { data } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const parsed = parseRef('registry://cedar_policy_module/acme/permit@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  test('resolve fails closed (MALFORMED) when an MCP body parses to a non-object', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: '[1, 2]' } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  test('resolve fails closed (MALFORMED) when SKILL.md frontmatter is a non-mapping (not a bare {})', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'skill/acme/readme-helper',
      recordType: 'SKILL',
      descriptors: {
        agentSkillsDefinition: { additionalData: { skillMd: { data: '---\n- a\n- b\n---\n# body' } } },
      },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const parsed = parseRef('registry://skill/acme/readme-helper@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  const seedSkillMd = (fake: FakeClient, skillMd: string): string =>
    fake.seed({
      name: 'skill/acme/readme-helper',
      recordType: 'SKILL',
      descriptors: { agentSkillsDefinition: { additionalData: { skillMd: { data: skillMd } } } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });

  // js-yaml 5 throws on a block that holds no YAML document; PyYAML's safe_load returns None for it.
  test.each([
    ['is empty', '---\n\n---\n# body'],
    ['has only blank lines', '---\n  \n\n---\n# body'],
    ['has only a comment', '---\n# no frontmatter yet\n---\n# body'],
  ])('a SKILL.md whose frontmatter block %s is a record without frontmatter, not a malformed one', async (_label, skillMd) => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedSkillMd(fake, skillMd);

    const record = await client.getRecord('skill', 'acme', 'readme-helper', '1.0.0');
    expect(record).toMatchObject({ kind: 'skill', name: 'readme-helper', version: '1.0.0', storageMode: 'native' });
    expect(record?.runtime).toEqual({});
    expect(record?.publisher).toBeUndefined();

    const entries = await client.listBrowseEntries({ kind: 'skill', namespace: 'acme' });
    expect(entries).toEqual([{ malformed: false, record }]);

    const parsed = parseRef('registry://skill/acme/readme-helper@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'REMOVED' });
  });

  test('a SKILL.md whose frontmatter block holds two YAML documents is malformed (the first one does not win)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const runtimeB64 = Buffer.from(JSON.stringify({ prompt_fragment: 'ok' })).toString('base64');
    // `...` ends the first document; the lines after it are a second one.
    seedSkillMd(fake, `---\nname: acme-readme-helper\nx-abca-runtime: ${runtimeB64}\n...\nx-abca-publisher: cognito-sub-999\n---\n# body`);

    const err = await client.getRecord('skill', 'acme', 'readme-helper', '1.0.0').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryRecordMalformedError);
    expect(err).toMatchObject({ reason: 'MALFORMED_FRONTMATTER' });

    const parsed = parseRef('registry://skill/acme/readme-helper@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  test('a SKILL.md that repeats a frontmatter key is read with the last value, as the agent reads it', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const b64 = (runtime: unknown): string => Buffer.from(JSON.stringify(runtime)).toString('base64');
    seedSkillMd(fake, [
      '---',
      'name: acme-readme-helper',
      `x-abca-runtime: ${b64({ prompt_fragment: 'FIRST' })}`,
      'x-abca-publisher: first-sub',
      `x-abca-runtime: ${b64({ prompt_fragment: 'SECOND' })}`,
      'x-abca-publisher: second-sub',
      '---',
      '# body',
    ].join('\n'));

    const record = await client.getRecord('skill', 'acme', 'readme-helper', '1.0.0');
    expect(record?.runtime).toEqual({ prompt_fragment: 'SECOND' });
    expect(record?.publisher).toBe('second-sub');
  });

  test.each([
    ['CUSTOM', 'descriptors is null', null],
    ['CUSTOM', 'custom is null', { custom: null }],
    ['CUSTOM', 'data is null', { custom: { data: null } }],
    ['CUSTOM', 'descriptors is a string', 'text'],
    ['CUSTOM', 'custom is a string', { custom: 'text' }],
    ['MCP', 'descriptors is null', null],
    ['MCP', 'mcpServer is null', { mcpServer: null }],
    ['MCP', 'data is null', { mcpServer: { data: null } }],
    ['MCP', 'mcpServer is a list', { mcpServer: ['x'] }],
    ['SKILL', 'descriptors is null', null],
    ['SKILL', 'agentSkillsDefinition is null', { agentSkillsDefinition: null }],
    ['SKILL', 'additionalData is null', { agentSkillsDefinition: { additionalData: null } }],
    ['SKILL', 'skillMd is null', { agentSkillsDefinition: { additionalData: { skillMd: null } } }],
    ['SKILL', 'data is null', { agentSkillsDefinition: { additionalData: { skillMd: { data: null } } } }],
    ['SKILL', 'skillMd is a string', { agentSkillsDefinition: { additionalData: { skillMd: 'text' } } }],
    ['CUSTOM', 'body holds a null runtime', { custom: { data: '{"runtime": null}' } }],
    ['MCP', 'body holds a null _meta', { mcpServer: { data: '{"_meta": null}' } }],
    ['MCP', 'body holds a null runtime in _meta', { mcpServer: { data: `{"_meta": {"${RUNTIME_META_KEY}": null}}` } }],
  ])('%s record whose %s reads as an empty record and fails to resolve as REMOVED', async (recordType, _what, descriptors) => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({ name: 'mcp_server/acme/pdf-tools', recordType, descriptors, recordVersion: '1.0.0', status: 'APPROVED' });

    const record = await client.getRecord('mcp_server', 'acme', 'pdf-tools', '1.0.0');
    expect(record).toMatchObject({ name: 'pdf-tools', version: '1.0.0' });
    expect(record?.runtime ?? {}).toEqual({});
    expect(record?.publisher).toBeUndefined();

    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'REMOVED' });
  });

  test.each([
    ['CUSTOM', 'is an empty string', { custom: { data: '' } }],
    ['MCP', 'is an empty string', { mcpServer: { data: '' } }],
    ['CUSTOM', 'is the number 0', { custom: { data: 0 } }],
    ['MCP', 'is the number 0', { mcpServer: { data: 0 } }],
    ['CUSTOM', 'is false', { custom: { data: false } }],
    ['MCP', 'is false', { mcpServer: { data: false } }],
    ['CUSTOM', 'holds NaN', { custom: { data: '{"runtime": {"limit": NaN}}' } }],
    ['MCP', 'holds Infinity', { mcpServer: { data: `{"_meta": {"${RUNTIME_META_KEY}": {"limit": Infinity}}}` } }],
  ])('resolve fails closed (MALFORMED) when the %s body %s', async (recordType, _what, descriptors) => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({ name: 'mcp_server/acme/pdf-tools', recordType, descriptors, recordVersion: '1.0.0', status: 'APPROVED' });
    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  test.each([
    ['base64', Buffer.from('{"limit": -Infinity}').toString('base64')],
    ['legacy JSON', '\'{"limit": NaN}\''],
  ])('resolve fails closed (MALFORMED) when a %s x-abca-runtime holds a number literal that is not JSON', async (_form, value) => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    seedSkillMd(fake, `---\nname: acme-readme-helper\nx-abca-runtime: ${value}\n---\n# body`);
    const parsed = parseRef('registry://skill/acme/readme-helper@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  const healthyMcp = (version: string, status: string): Record<string, unknown> => ({
    name: 'mcp_server/acme/pdf-tools',
    recordType: 'MCP',
    descriptors: { mcpServer: { data: JSON.stringify({ name: 'acme/pdf-tools', version, _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: 'https://x' } } }) } },
    recordVersion: version,
    status,
  });

  test('resolve returns a healthy record that shares its namespace with corrupt ones', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'mcp_server/acme/other',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: '{bad json' } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    seedCorruptMcp(fake);
    fake.seed(healthyMcp('1.1.0', 'APPROVED'));

    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@^1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).resolves.toMatchObject({ name: 'pdf-tools', version: '1.1.0' });
  });

  test('a record whose status this code does not know is not a resolution candidate', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed(healthyMcp('1.0.0', 'APPROVED'));
    fake.seed(healthyMcp('1.1.0', 'SOME_FUTURE_STATUS'));

    const range = parseRef('registry://mcp_server/acme/pdf-tools@^1.0.0');
    const exact = parseRef('registry://mcp_server/acme/pdf-tools@1.1.0');
    if (!range.ok || !exact.ok) throw new Error('fixture refs should parse');
    await expect(client.resolve(range.ref)).resolves.toMatchObject({ version: '1.0.0' });
    await expect(client.resolve(exact.ref)).rejects.toMatchObject({ reason: 'NO_MATCHING_VERSION' });
  });

  test('a record without a name does not stop the others', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({ ...healthyMcp('2.0.0', 'APPROVED'), name: null });
    fake.seed(healthyMcp('1.0.0', 'APPROVED'));

    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@^1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).resolves.toMatchObject({ version: '1.0.0' });
    await expect(client.getRecord('mcp_server', 'acme', 'pdf-tools', '1.0.0')).resolves.toMatchObject({ version: '1.0.0' });
  });

  test('a record without a version does not stop its siblings', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({ ...healthyMcp('1.1.0', 'APPROVED'), recordVersion: null });
    fake.seed(healthyMcp('1.0.0', 'APPROVED'));

    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@^1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    await expect(client.resolve(parsed.ref)).resolves.toMatchObject({ version: '1.0.0' });
  });

  test('resolve MALFORMED message carries the discriminator, never the raw descriptor bytes', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    // The message of Node's JSON.parse error quotes the input around the failure position.
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: '{"_meta": {"dev.abca.runtime": SUPERSECRETTOKEN' } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const parsed = parseRef('registry://mcp_server/acme/pdf-tools@1.0.0');
    if (!parsed.ok) throw new Error('fixture ref should parse');
    const err = await client.resolve(parsed.ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryResolutionError);
    expect((err as RegistryResolutionError).message).toContain('MALFORMED_DESCRIPTOR');
    expect((err as RegistryResolutionError).message).not.toContain('SUPERSECRETTOKEN');
  });

  test('publish over coordinates holding a malformed record throws ConflictException (not a bare 500)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    fake.seed({
      name: 'mcp_server/acme/pdf-tools',
      recordType: 'MCP',
      descriptors: { mcpServer: { data: '{bad json' } },
      recordVersion: '1.0.0',
      status: 'APPROVED',
    });
    const err = await client.publish({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
      runtime: { transport: 'http' as const, url: 'https://x' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(fake.sent).toEqual([]);
  });
});
