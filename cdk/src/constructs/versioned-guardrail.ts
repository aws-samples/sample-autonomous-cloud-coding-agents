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

import { createHash } from 'node:crypto';
import { Guardrail, GuardrailProps } from '@aws-cdk/aws-bedrock-alpha';
import { Lazy, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnGuardrail, CfnGuardrailVersion } from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import { canonicalJson, Json } from '../utils/canonical-json';

const LOGICAL_ID_HASH_LENGTH = 32;
const MAX_LOGICAL_ID_LENGTH = 255;
const LOGICAL_ID_PREFIX_LENGTH = MAX_LOGICAL_ID_LENGTH - LOGICAL_ID_HASH_LENGTH;
const CONFIGURATION_HASH_METADATA = 'abca:guardrail-configuration-sha256';

/** One-time binding to an existing version, verified against the exact synthesized configuration. */
export interface GuardrailVersionBinding {
  readonly logicalId: string;
  readonly configurationHash: string;
}

export interface VersionedGuardrailProps extends GuardrailProps {
  readonly existingVersion?: GuardrailVersionBinding;
}

/** Accept CDK JSON context or its command-line JSON string form; never guess a deployed logical ID. */
export function parseGuardrailVersionBinding(value: unknown): GuardrailVersionBinding | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch {
      throw new Error('guardrailVersionMigration must be a JSON object with logicalId and configurationHash');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('guardrailVersionMigration must be an object with logicalId and configurationHash');
  }
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).some(key => key !== 'logicalId' && key !== 'configurationHash') ||
    typeof fields.logicalId !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,254}$/.test(fields.logicalId) ||
    typeof fields.configurationHash !== 'string' || !/^[a-f0-9]{64}$/.test(fields.configurationHash)) {
    throw new Error('guardrailVersionMigration requires a valid CloudFormation logicalId and lowercase SHA-256 configurationHash');
  }
  return { logicalId: fields.logicalId, configurationHash: fields.configurationHash };
}

/**
 * Hash the final CloudFormation properties, including lazy values and escape-hatch overrides.
 * This isolated serialization seam mirrors CDK's Lambda version hashing. _toCloudFormation
 * is internal to CDK; regression tests cover its shape when the pinned CDK dependency changes.
 */
function configurationHash(resource: CfnGuardrail, versionDescription?: string): string {
  // CDK's intermediate object retains undefined optional fields. Serialize exactly
  // as the template writer does before canonicalizing the actual JSON properties.
  const rendered = JSON.parse(JSON.stringify(Stack.of(resource).resolve({
    resource: resource._toCloudFormation(),
    versionDescription,
  }))) as {
    resource: { Resources?: Record<string, { Type?: string; Properties?: Record<string, Json> }> };
    versionDescription?: string;
  };
  const resources = Object.values(rendered.resource.Resources ?? {});
  if (resources.length !== 1 || resources[0].Type !== CfnGuardrail.CFN_RESOURCE_TYPE_NAME || !resources[0].Properties) {
    throw new Error('Expected exactly one rendered guardrail configuration when publishing a version');
  }
  // Deployment tags (e.g. a GitHub run ID) do not change the guardrail's behavior.
  const configuration = Object.fromEntries(Object.entries(resources[0].Properties).filter(([key]) => key !== 'Tags'));
  // Description changes replace AWS::Bedrock::GuardrailVersion too. Include the
  // publication description so a migration binding cannot admit that replacement.
  return createHash('sha256').update(canonicalJson({
    guardrail: configuration,
    versionDescription: rendered.versionDescription ?? null,
  })).digest('hex');
}

/** Publish one retained version per rendered configuration, independent of CDK token counters. */
export class VersionedGuardrail extends Guardrail {
  private readonly existingVersion?: GuardrailVersionBinding;
  private publishedVersion?: CfnGuardrailVersion;

  constructor(scope: Construct, id: string, props: VersionedGuardrailProps) {
    const { existingVersion, ...guardrailProps } = props;
    super(scope, id, guardrailProps);
    this.existingVersion = parseGuardrailVersionBinding(existingVersion);
  }

  public override createVersion(description?: string): string {
    if (this.publishedVersion) throw new Error('VersionedGuardrail publishes one version per synthesis');
    const resources = this.node.children.filter((child): child is CfnGuardrail => child instanceof CfnGuardrail);
    if (resources.length !== 1) throw new Error('VersionedGuardrail requires exactly one native CfnGuardrail');
    const resource = resources[0];
    const stack = Stack.of(this);
    const version = new CfnGuardrailVersion(this, 'Version', {
      guardrailIdentifier: this.guardrailId,
      description,
    });
    this.publishedVersion = version;
    version.addDependency(resource);
    // Published versions can still be referenced by durable executions after an update.
    version.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const originalLogicalId = stack.resolve(version.logicalId) as string;
    version.overrideLogicalId(Lazy.uncachedString({
      produce: () => {
        const hash = configurationHash(resource, description);
        if (this.existingVersion) {
          if (hash !== this.existingVersion.configurationHash) {
            throw new Error(`guardrailVersionMigration configuration mismatch: synthesized ${hash}; refusing to replace the existing version`);
          }
          return this.existingVersion.logicalId;
        }
        return `${originalLogicalId.slice(0, LOGICAL_ID_PREFIX_LENGTH)}${hash.slice(0, LOGICAL_ID_HASH_LENGTH)}`;
      },
    }));
    version.addMetadata(CONFIGURATION_HASH_METADATA, Lazy.uncachedString({ produce: () => configurationHash(resource, description) }));
    this.updateVersion(version.attrVersion);
    return this.guardrailVersion;
  }
}
