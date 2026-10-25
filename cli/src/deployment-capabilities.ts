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

import type { DeploymentFeature } from './deployment-profile';

/** Region data for one capability; `regions` absent means no constraint beyond core. */
export interface Capability {
  readonly label: string;
  readonly requiredServices: readonly string[];
  readonly regions?: readonly string[];
  readonly remediation: string;
}

export interface FeatureCapability extends Capability {
  readonly description: string;
  readonly maturity: 'stable' | 'experimental';
  readonly approximateResources: number;
  readonly stateful: boolean;
}

export interface CapabilityCatalog {
  readonly schemaVersion: number;
  readonly lastVerified: string;
  readonly source: string;
  readonly core: Capability;
  readonly features: Readonly<Record<DeploymentFeature, FeatureCapability>>;
}

/**
 * Package-safe copy of ``contracts/deployment-capabilities.json`` (ADR-024).
 * The contract lives outside the published ``lib`` files, so the CLI carries
 * literals and ``test/deployment-capabilities-parity.test.ts`` fails on drift.
 * Update the JSON first, then mirror it here.
 */
export const CAPABILITY_CATALOG: CapabilityCatalog = {
  schemaVersion: 1,
  lastVerified: '2026-10-25',
  source: 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html',
  core: {
    label: 'ABCA core platform',
    requiredServices: ['AgentCore Runtime', 'AgentCore Memory'],
    regions: ['us-east-1', 'us-east-2', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ca-central-1', 'sa-east-1', 'us-gov-west-1'],
    remediation: 'Deploy ABCA to a Region where both AgentCore Runtime and AgentCore Memory are available.',
  },
  features: {
    slack: {
      label: 'Slack',
      description: 'Slack App: /bgagent slash command, mentions, DMs and task notifications.',
      maturity: 'stable',
      requiredServices: [],
      approximateResources: 51,
      stateful: true,
      remediation: 'Slack uses only Regional services that ABCA core already requires.',
    },
    linear: {
      label: 'Linear',
      description: 'Linear webhook intake, epic orchestration and issue status updates.',
      maturity: 'stable',
      requiredServices: [],
      approximateResources: 45,
      stateful: true,
      remediation: 'Linear uses only Regional services that ABCA core already requires.',
    },
    jira: {
      label: 'Jira',
      description: 'Jira Cloud webhook intake, epic orchestration and issue status updates.',
      maturity: 'stable',
      requiredServices: [],
      approximateResources: 35,
      stateful: true,
      remediation: 'Jira uses only Regional services that ABCA core already requires.',
    },
    deployPreviewScreenshots: {
      label: 'Deploy-preview screenshots',
      description: 'GitHub deployment_status webhook that screenshots preview deploys with AgentCore Browser.',
      maturity: 'stable',
      requiredServices: ['AgentCore Built-in Tools (Browser)', 'Amazon CloudFront'],
      regions: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-south-1', 'eu-west-3', 'eu-south-2', 'eu-north-1', 'ap-southeast-5', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-7', 'ap-northeast-1', 'ap-northeast-2', 'ca-central-1', 'sa-east-1', 'us-gov-west-1'],
      approximateResources: 23,
      stateful: true,
      remediation: 'Choose a Region where AgentCore Built-in Tools are available, or disable deploy-preview screenshots: set features.deployPreviewScreenshots to false in abca.deployment.json, pass -c enableDeployPreviewScreenshots=false, or run bgagent setup.',
    },
    agentRegistry: {
      label: 'AWS Agent Registry',
      description: 'Central registry for Blueprint MCP servers, skills and Cedar policy modules (ADR-022).',
      maturity: 'stable',
      requiredServices: ['AWS Agent Registry'],
      regions: ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-2', 'ap-northeast-1'],
      approximateResources: 2,
      stateful: true,
      remediation: 'Choose one of the supported Regions, or disable the Agent Registry: set features.agentRegistry to false in abca.deployment.json, pass -c enableAgentRegistry=false, or run bgagent setup.',
    },
    toolGateway: {
      label: 'Tool Gateway',
      description: 'AgentCore Gateway federating platform MCP tools to the agent (ADR-019, proposed).',
      maturity: 'experimental',
      requiredServices: ['AgentCore Gateway'],
      regions: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-south-1', 'eu-west-3', 'eu-south-2', 'eu-north-1', 'ap-southeast-5', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-7', 'ap-northeast-1', 'ap-northeast-2', 'ca-central-1', 'sa-east-1', 'us-gov-west-1'],
      approximateResources: 7,
      stateful: false,
      remediation: 'Choose a Region where AgentCore Gateway is available, or disable the Tool Gateway: set features.toolGateway to false in abca.deployment.json, pass -c enableToolGateway=false, or run bgagent setup.',
    },
  },
};

/** Whether a capability is usable in a Region (core constraints are checked separately). */
export function isAvailableIn(capability: Capability, region: string): boolean {
  return capability.regions === undefined || capability.regions.includes(region);
}
