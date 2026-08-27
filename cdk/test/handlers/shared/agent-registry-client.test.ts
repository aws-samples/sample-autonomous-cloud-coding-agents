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
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
} from '@aws-sdk/client-agent-registry-control';
import { AgentRegistryClient } from '../../../src/handlers/shared/registry/agent-registry-client';
import { parseRef } from '../../../src/handlers/shared/registry/ref';
import { RegistryPublishIncompleteError, RegistryResolutionError } from '../../../src/handlers/shared/registry/types';

const RUNTIME_META_KEY = 'dev.abca.runtime';

/** A tiny in-memory fake of the Agent Registry control-plane client. Records are
 *  keyed by an opaque id; List returns summaries, Get returns the full record. */
class FakeClient {
  private records = new Map<string, Record<string, unknown>>();
  private seq = 0;
  public sent: string[] = [];
  /** Status a CREATING record settles into on the first Get. `'CREATING'`
   *  simulates a record that never settles (poll-budget timeout). */
  public settleStatus = 'DRAFT';
  /** Optional statusReason surfaced alongside a *_FAILED settle. */
  public settleReason?: string;
  /** When true, SubmitRegistryRecordForApproval throws — simulates a post-create
   *  failure that strands a DRAFT record. */
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
      // Mirror the real SKILL validator: SKILL.md must be Markdown
      // frontmatter (start with '---'), not JSON. This guards the adapter's
      // skill descriptor build against regressing to JSON (the original bug).
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
      // Simulate async settle: first Get after create flips CREATING → the
      // configured settle status (DRAFT by default; CREATE_FAILED or a stuck
      // CREATING for the failure/timeout tests).
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
    // discovery body carried the runtime under _meta (spike-verified shape)
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
    // Would throw in FakeClient if the adapter emitted JSON instead of frontmatter.
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
    // The exact case that broke single-quoted YAML frontmatter (#246 review):
    // js-yaml rejected `x-abca-runtime: '{"prompt_fragment":"Don't…"}'`.
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
    // The stored frontmatter value must be base64 (no raw apostrophe/JSON), so
    // the SKILL.md stays valid YAML for native descriptor validation.
    const skillMd = (record.discovery as { skillMd: string }).skillMd;
    const line = skillMd.split('\n').find((l) => l.startsWith('x-abca-runtime:'))!;
    expect(line).not.toContain('prompt_fragment'); // it's encoded, not raw JSON
  });

  test('publish (native skill) — a newline-bearing description cannot inject a shadowing runtime key (#246 B1)', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    // Attacker smuggles a second x-abca-runtime line via the discovery description,
    // trying to shadow the validated runtime on read (the B1 bypass).
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
    // The round-tripped runtime must be the validated one, never the injected payload.
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
      // autoApprove omitted → must still reach PENDING_APPROVAL, never approve.
    });
    expect(fake.sent).toEqual(['create', 'submit']);
    expect(record.status).toBe('PENDING_APPROVAL');
  });

  test('publish throws (not 201) when the record settles into CREATE_FAILED', async () => {
    const fake = new FakeClient();
    fake.settleStatus = 'CREATE_FAILED';
    fake.settleReason = 'descriptor rejected by substrate';
    const client = makeClient(fake);
    // The record was created before waitPastCreating saw CREATE_FAILED, so the
    // failure surfaces as a RegistryPublishIncompleteError carrying the orphan's
    // recordId; the underlying CREATE_FAILED reason rides on `cause`.
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
    // Never advanced past create — no submit/approve on a failed record.
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
    // The orphan's id is surfaced so an operator can find + delete/approve it.
    expect((err as RegistryPublishIncompleteError).recordId).toBeTruthy();
    // Create + submit were attempted; submit failed before approve.
    expect(fake.sent).toEqual(['create', 'submit']);
  });

  test('publish throws when the record never leaves CREATING (poll budget exhausted)', async () => {
    jest.useFakeTimers();
    try {
      const fake = new FakeClient();
      fake.settleStatus = 'CREATING'; // never settles
      const client = makeClient(fake);
      const p = client.publish({
        kind: 'mcp_server',
        namespace: 'acme',
        name: 'pdf-tools',
        version: '1.0.0',
        discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
        runtime: { transport: 'http' as const, url: 'https://x' },
      });
      // A timeout after create also strands a record, so it surfaces as
      // RegistryPublishIncompleteError with the underlying reason on `cause`.
      const assertion = expect(p).rejects.toBeInstanceOf(RegistryPublishIncompleteError);
      const causeAssertion = p.catch((e: unknown) => {
        expect(String((e as RegistryPublishIncompleteError).cause)).toMatch(/did not leave CREATING/);
      });
      await jest.runAllTimersAsync();
      await assertion;
      await causeAssertion;
      expect(fake.sent).toEqual(['create']);
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
    seedMcp('1.9.10', 'DRAFT'); // higher but not approved → excluded

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
    // APPROVED, but the server.json carries no `_meta` runtime block at all —
    // extractPayload would yield an empty runtime. Fail closed instead of
    // resolving to {} (REGISTRY.md §8).
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

  test('publish (native MCP) preserves a caller-supplied discovery._meta alongside ABCA keys', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const runtime = { transport: 'http', url: 'https://x' };
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
    // ABCA runtime rides under its key AND the caller's own _meta key survives.
    expect(meta).toMatchObject({ [RUNTIME_META_KEY]: runtime, 'io.example.custom': { keep: true } });
  });
});
