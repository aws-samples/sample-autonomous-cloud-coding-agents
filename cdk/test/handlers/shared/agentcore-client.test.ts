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
} from '@aws-sdk/client-bedrock-agentcore-control';
import { AgentCoreRegistryClient } from '../../../src/handlers/shared/registry/agentcore-client';
import { parseRef } from '../../../src/handlers/shared/registry/ref';
import { RegistryResolutionError } from '../../../src/handlers/shared/registry/types';

const RUNTIME_META_KEY = 'dev.abca.runtime';

/** A tiny in-memory fake of the AgentCore control-plane client. Records are
 *  keyed by an opaque id; List returns summaries, Get returns the full record. */
class FakeClient {
  private records = new Map<string, Record<string, unknown>>();
  private seq = 0;
  public sent: string[] = [];

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
        descriptorType?: string;
        descriptors?: { agentSkills?: { skillMd?: { inlineContent?: string } } };
        recordVersion?: string;
      };
      // Mirror the real AGENT_SKILLS validator: SKILL.md must be Markdown
      // frontmatter (start with '---'), not JSON. This guards the adapter's
      // skill descriptor build against regressing to JSON (the original bug).
      if (input.descriptorType === 'AGENT_SKILLS') {
        const md = input.descriptors?.agentSkills?.skillMd?.inlineContent ?? '';
        if (!md.startsWith('---')) {
          throw new Error("agentSkills.skillMd inlineContent must start with frontmatter delimited by '---'");
        }
      }
      const id = `rec-${++this.seq}`;
      this.records.set(id, {
        recordId: id,
        recordArn: `arn:aws:bedrock-agentcore:us-east-1:1:registry/r/record/${id}`,
        name: input.name,
        descriptorType: input.descriptorType,
        descriptors: input.descriptors,
        recordVersion: input.recordVersion,
        status: 'CREATING',
      });
      return { recordArn: `arn:aws:bedrock-agentcore:us-east-1:1:registry/r/record/${id}`, status: 'CREATING' };
    }
    if (cmd instanceof GetRegistryRecordCommand) {
      const id = (cmd.input as { recordId: string }).recordId;
      const rec = this.records.get(id);
      // Simulate async settle: first Get after create flips CREATING → DRAFT.
      if (rec && rec.status === 'CREATING') rec.status = 'DRAFT';
      return rec ?? {};
    }
    if (cmd instanceof ListRegistryRecordsCommand) {
      return { registryRecords: [...this.records.values()], nextToken: undefined };
    }
    if (cmd instanceof SubmitRegistryRecordForApprovalCommand) {
      this.sent.push('submit');
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

function makeClient(fake: FakeClient): AgentCoreRegistryClient {
  return new AgentCoreRegistryClient({
    registryId: 'r',
    client: fake as never,
  });
}

describe('AgentCoreRegistryClient', () => {
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

  test('resolve picks the highest APPROVED version matching the constraint', async () => {
    const fake = new FakeClient();
    const client = makeClient(fake);
    const seedMcp = (version: string, status: string): void => {
      fake.seed({
        name: 'mcp_server/acme/pdf-tools',
        descriptorType: 'MCP',
        descriptors: { mcp: { server: { inlineContent: JSON.stringify({ name: 'acme/pdf-tools', version, _meta: { [RUNTIME_META_KEY]: { transport: 'http', url: `https://x/${version}` } } }) } } },
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
      descriptorType: 'MCP',
      descriptors: { mcp: { server: { inlineContent: JSON.stringify({ name: 'acme/pdf-tools', version: '1.4.1', _meta: { [RUNTIME_META_KEY]: { transport: 'http' } } }) } } },
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
      descriptorType: 'MCP',
      descriptors: { mcp: { server: { inlineContent: JSON.stringify({ name: 'acme/pdf-tools', version: '1.4.1' }) } } },
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
});
