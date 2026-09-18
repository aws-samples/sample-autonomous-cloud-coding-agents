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

import { canonical, digest, MigrationTemplate, referencesAny } from './template';

interface Policy {
  id: string;
  roles: any[];
  statements: any[];
  save: () => void;
}

const POLICY_ID_HASH_LENGTH = 12;
// Leave space below IAM's 6,144-character quota for resolved ARN values.
const POLICY_DOCUMENT_BUDGET = 5000;

const list = (value: any): any[] => Array.isArray(value) ? value : [value];
const unique = (values: any[]): any[] => [...new Map(values.map(value => [canonical(value), value])).values()];
const roleKey = (roles: any[]): string => canonical(roles.map(canonical).sort());

/** Include CDK overflow policies attached through Role.ManagedPolicyArns. */
function policies(template: MigrationTemplate): Policy[] {
  const result: Policy[] = [];
  const attached = new Map<string, any[]>();
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::IAM::Role') continue;
    for (const arn of resource.Properties?.ManagedPolicyArns ?? []) {
      if (arn?.Ref) attached.set(arn.Ref, [...(attached.get(arn.Ref) ?? []), { Ref: id }]);
    }
  }
  const add = (id: string, roles: any[], holder: Record<string, any>): void => {
    if (!roles.length) return;
    const encoded = typeof holder.PolicyDocument === 'string';
    const document = encoded ? JSON.parse(holder.PolicyDocument) : holder.PolicyDocument;
    if (!document || !Array.isArray(document.Statement)) throw new Error(`Unsupported IAM policy document: ${id}`);
    result.push({
      id,
      roles,
      statements: document.Statement,
      save: () => { holder.PolicyDocument = encoded ? JSON.stringify(document) : document; },
    });
  };
  for (const [id, resource] of Object.entries(template.Resources)) {
    const props = resource.Properties ?? {};
    if (['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)) {
      add(id, unique([...(props.Roles ?? []), ...(attached.get(id) ?? [])]), props);
    } else if (resource.Type === 'AWS::IAM::Role') {
      for (const policy of props.Policies ?? []) add(`${id}/${policy.PolicyName}`, [{ Ref: id }], policy);
    }
  }
  return result;
}

function shape(statement: Record<string, any>): string {
  const copy = structuredClone(statement);
  delete copy.Resource;
  delete copy.NotResource;
  delete copy.Sid;
  for (const field of ['Action', 'NotAction']) {
    if (copy[field]) copy[field] = list(copy[field]).sort();
  }
  return canonical(copy);
}

function mergeScope(target: Record<string, any>, source: Record<string, any>): void {
  for (const field of ['Resource', 'NotResource']) {
    if (Object.hasOwn(target, field) !== Object.hasOwn(source, field)) {
      throw new Error('IAM migration cannot change Resource into NotResource');
    }
    if (target[field] !== undefined) target[field] = unique([...list(target[field]), ...list(source[field])]);
  }
}

/**
 * Keep legacy access on its original roles while both resource sets exist.
 * Separate managed policies avoid exceeding a role's aggregate inline-policy
 * quota. They disappear from the final template after the retirement check.
 */
export function preserveLegacyPermissions(
  baseline: MigrationTemplate,
  target: MigrationTemplate,
  legacyIds: ReadonlySet<string>,
): { template: MigrationTemplate; bridgePolicyIds: string[] } {
  const template = structuredClone(target);
  const current = policies(template);
  const bridges = new Map<string, { roles: any[]; statements: any[] }>();
  for (const old of policies(baseline)) {
    if (legacyIds.has(old.id)) continue; // The old build/operator policy is retained verbatim.
    const affected = old.statements.filter(statement => referencesAny(statement, legacyIds));
    if (!affected.length) continue;
    const matchingPolicies = current.filter(policy => roleKey(policy.roles) === roleKey(old.roles));
    if (!matchingPolicies.length) throw new Error(`Missing original IAM principal for migration policy ${old.id}`);
    const statements = matchingPolicies.flatMap(policy => policy.statements);
    for (const statement of affected) {
      const matching = statements.filter(candidate => shape(candidate) === shape(statement));
      if (statement.Effect === 'Deny') {
        if (matching.length !== 1) throw new Error(`Ambiguous legacy Deny in ${old.id}; refusing to append another deny`);
        mergeScope(matching[0], statement);
        continue;
      }
      if (statement.Effect !== 'Allow' || !statement.Resource || statement.NotResource || statement.Principal) {
        throw new Error(`Unsupported legacy identity grant in ${old.id}`);
      }
      const key = roleKey(old.roles);
      const bridge = bridges.get(key) ?? { roles: old.roles, statements: [] };
      const retained = structuredClone(statement);
      delete retained.Sid;
      bridge.statements.push(retained);
      bridges.set(key, bridge);

      // P2 allowed direct reads of the old payload bucket and had no bootstrap
      // deny. P3's new deny must also exempt those pre-existing read resources
      // until old workers drain. This does not grant access to the NEW bucket.
      const oldActions: string[] = list(statement.Action ?? []);
      if (oldActions.some(action => /^s3:(GetObject\*?|\*)$/i.test(action))) {
        const oldObjects = list(statement.Resource).filter(value => referencesAny(value, legacyIds));
        const denies = statements.filter(candidate =>
          candidate.Effect === 'Deny' && candidate.NotResource
          && list(candidate.Action ?? []).some(action => /^s3:(GetObject\*?|\*)$/i.test(action)),
        );
        if (denies.length > 1) throw new Error(`Multiple S3 bootstrap denies for ${old.id}; explicit review required`);
        for (const deny of denies) deny.NotResource = unique([...list(deny.NotResource), ...oldObjects]);
      }
    }
  }
  for (const policy of current) policy.save();
  const bridgePolicyIds: string[] = [];
  for (const bridge of bridges.values()) {
    const id = `MicrovmMigrationAccess${digest(bridge.roles).slice(0, POLICY_ID_HASH_LENGTH)}`;
    if (template.Resources[id]) throw new Error(`Migration policy identifier already exists: ${id}`);
    const document = { Version: '2012-10-17', Statement: unique(bridge.statements) };
    if (Buffer.byteLength(JSON.stringify(document)) > POLICY_DOCUMENT_BUDGET) {
      throw new Error(`Legacy grants for ${id} need more than one managed policy; explicit review required`);
    }
    template.Resources[id] = {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        Description: 'Temporary original-role access while the MicroVM migration drains old workers',
        Roles: bridge.roles,
        PolicyDocument: document,
      },
    };
    bridgePolicyIds.push(id);
  }
  return { template, bridgePolicyIds };
}
