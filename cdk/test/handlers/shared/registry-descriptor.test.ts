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
  artifactKey,
  publishPk,
  validatePublish,
} from '../../../src/handlers/shared/registry-descriptor';

const validMcp = {
  kind: 'mcp_server',
  namespace: 'acme',
  name: 'pdf-tools',
  version: '1.4.1',
  descriptor: { summary: 'PDF tools', permissions: ['network:egress'], transport: 'http', tool_prefix: 'mcp__pdf__' },
  artifact_b64: Buffer.from('{}').toString('base64'),
};

describe('validatePublish', () => {
  test('accepts a well-formed mcp_server publish', () => {
    expect(validatePublish(validMcp)).toEqual([]);
  });

  test('accepts a cedar_policy_module with cedar_actions', () => {
    expect(
      validatePublish({
        kind: 'cedar_policy_module',
        namespace: 'acme',
        name: 'guard',
        version: '1.0.0',
        descriptor: { summary: 's', permissions: [], cedar_actions: ['Action::"ForcePush"'] },
        artifact_b64: Buffer.from('permit(...)').toString('base64'),
      }),
    ).toEqual([]);
  });

  test('accepts a skill with tool_hints', () => {
    expect(
      validatePublish({
        kind: 'skill',
        namespace: 'acme',
        name: 'refactor',
        version: '2.0.0',
        descriptor: { summary: 's', permissions: [], tool_hints: ['Edit'] },
        artifact_b64: Buffer.from('# skill').toString('base64'),
      }),
    ).toEqual([]);
  });

  test('rejects a reserved kind (no loader in MVP)', () => {
    const v = validatePublish({ ...validMcp, kind: 'plugin' });
    expect(v.some((x) => x.field === 'kind')).toBe(true);
  });

  test('rejects an unknown kind', () => {
    const v = validatePublish({ ...validMcp, kind: 'nonsense' });
    expect(v.some((x) => x.field === 'kind')).toBe(true);
  });

  test('rejects a non-exact version (range is not a publish version)', () => {
    expect(validatePublish({ ...validMcp, version: '^1.4.1' }).some((x) => x.field === 'version')).toBe(true);
    expect(validatePublish({ ...validMcp, version: 'latest' }).some((x) => x.field === 'version')).toBe(true);
  });

  test('rejects a bad namespace / name', () => {
    expect(validatePublish({ ...validMcp, namespace: 'Acme' }).some((x) => x.field === 'namespace')).toBe(true);
    expect(validatePublish({ ...validMcp, name: '-bad' }).some((x) => x.field === 'name')).toBe(true);
  });

  test('requires descriptor summary and permissions', () => {
    const v = validatePublish({ ...validMcp, descriptor: { transport: 'http', tool_prefix: 'x' } });
    expect(v.some((x) => x.field === 'descriptor.summary')).toBe(true);
    expect(v.some((x) => x.field === 'descriptor.permissions')).toBe(true);
  });

  test('mcp_server requires transport and tool_prefix', () => {
    const v = validatePublish({
      ...validMcp,
      descriptor: { summary: 's', permissions: [] },
    });
    expect(v.some((x) => x.field === 'descriptor.transport')).toBe(true);
    expect(v.some((x) => x.field === 'descriptor.tool_prefix')).toBe(true);
  });

  test('requires an artifact for loadable kinds', () => {
    const { artifact_b64: _omit, ...noArtifact } = validMcp;
    expect(validatePublish(noArtifact).some((x) => x.field === 'artifact_b64')).toBe(true);
  });
});

describe('key helpers', () => {
  test('publishPk builds {kind}#{namespace}/{name}', () => {
    expect(publishPk('mcp_server', 'acme', 'pdf-tools')).toBe('mcp_server#acme/pdf-tools');
  });

  test('artifactKey builds the versioned S3 key', () => {
    expect(artifactKey('mcp_server', 'acme', 'pdf-tools', '1.4.1')).toBe(
      'mcp_server/acme/pdf-tools/1.4.1/artifact',
    );
  });
});
