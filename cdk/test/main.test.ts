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

import * as fs from 'fs';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import {
  AGENTCORE_AZS_CONTEXT_KEY,
  AvailabilityZoneInfo,
  DescribeAzsFn,
  ResolveCallerAccountFn,
} from '../src/constructs/agentcore-azs';
import { BuildAppOptions, buildApp } from '../src/main';

/**
 * These tests drive the real `main.ts` wiring rather than a re-implementation of
 * it, so that deleting the AZ resolution, failing to thread the prop into
 * `AgentStack`, or annotating a scope CDK does not collect all fail here.
 *
 * `Template.fromStack` / `Annotations.fromStack` read the synthesized **stack
 * artifact** with validation skipped — which is exactly the seam that matters:
 * annotations attached to the `App` node never reach a stack artifact.
 */

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const STACK_NAME = 'backgroundagent-dev';

const ZONES: AvailabilityZoneInfo[] = [
  { zoneName: 'us-east-1a', zoneId: 'use1-az2' }, // supported
  { zoneName: 'us-east-1b', zoneId: 'use1-az4' }, // supported
  { zoneName: 'us-east-1c', zoneId: 'use1-az6' }, // unsupported
  { zoneName: 'us-east-1d', zoneId: 'use1-az1' }, // supported
];

const okZones: DescribeAzsFn = async () => ZONES;
const okAccount: ResolveCallerAccountFn = async () => ACCOUNT;

function app(options: BuildAppOptions = {}): Promise<App> {
  return buildApp({
    account: ACCOUNT,
    region: REGION,
    describeAzs: okZones,
    resolveCallerAccount: okAccount,
    ...options,
  });
}

function stackOf(built: App): Stack {
  return built.node.findChild(STACK_NAME) as Stack;
}

describe('buildApp — AgentCore AZ wiring', () => {
  it('threads auto-pinned zones all the way into the VPC subnets', async () => {
    const template = Template.fromStack(stackOf(await app()));

    // Sorted supported names capped at 2 => us-east-1a + us-east-1b, one public
    // and one private subnet each.
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'us-east-1a' });
    template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'us-east-1b' });
    // The unsupported zone must never appear.
    const subnets = template.findResources('AWS::EC2::Subnet');
    const azs = Object.values(subnets).map(s => s.Properties?.AvailabilityZone);
    expect(azs).not.toContain('us-east-1c');
    expect(new Set(azs)).toEqual(new Set(['us-east-1a', 'us-east-1b']));
  });

  it('pins from the context override on the env-agnostic (pipeline) path', async () => {
    // The assembly deploy.yml ships is synthesized without credentials, so the
    // override is the only mechanism available there.
    const built = await buildApp({
      account: undefined,
      region: undefined,
      appProps: { context: { [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b', 'us-east-1c'] } },
    });
    const template = Template.fromStack(stackOf(built));
    template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'us-east-1b' });
    template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'us-east-1c' });
    Annotations.fromStack(stackOf(built)).hasNoError('*', Match.stringLikeRegexp('AgentCore AZs'));
  });

  it('surfaces a lookup failure as a stack-artifact ERROR (regression: annotations were dropped)', async () => {
    // Previously the resolver annotated the App node, which CDK never collects
    // into a stack artifact — a failed lookup produced a clean, silent synth and
    // then the NotStabilized rollback this feature exists to prevent.
    const built = await app({
      describeAzs: async () => {
        throw new Error('AccessDeniedException');
      },
    });
    Annotations.fromStack(stackOf(built)).hasError(
      '*',
      Match.stringLikeRegexp('Could not resolve AgentCore-supported availability zones'),
    );
  });

  it('records the failure at error level in the assembly (what the CLI fails on)', async () => {
    // In-process `app.synth()` does not throw on error annotations; the CDK CLI
    // is what refuses to continue ("Synthesis finished with errors", exit 1) when
    // a stack artifact carries an error-level message. Verified against the CLI
    // in this tree, so this asserts exactly that condition — every real synth
    // path (mise //cdk:synth, cdk deploy, build.yml) goes through the CLI.
    const built = await app({
      describeAzs: async () => {
        throw new Error('AccessDeniedException');
      },
    });
    const messages = built.synth().getStackByName(STACK_NAME).messages;
    const errors = messages.filter(m => m.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].entry.data).toContain('[AgentCore AZs]');
    expect(errors[0].entry.data).toContain('Could not resolve AgentCore-supported availability zones');
  });

  it('surfaces the unpinned env-agnostic case as a stack-artifact WARNING', async () => {
    const built = await buildApp({ account: undefined, region: undefined });
    Annotations.fromStack(stackOf(built)).hasWarning(
      '*',
      Match.stringLikeRegexp('without a bound account/region'),
    );
  });

  it('leaves the VPC unpinned (Fn::GetAZs) when no zones resolve', async () => {
    const built = await buildApp({ account: undefined, region: undefined });
    Template.fromStack(stackOf(built)).hasResourceProperties('AWS::EC2::Subnet', {
      AvailabilityZone: { 'Fn::Select': Match.arrayWith([{ 'Fn::GetAZs': '' }]) },
    });
  });

  it('propagates a malformed override as a synth-time throw', async () => {
    await expect(
      buildApp({
        account: ACCOUNT,
        region: REGION,
        appProps: { context: { [AGENTCORE_AZS_CONTEXT_KEY]: 'us-east-1b' } },
      }),
    ).rejects.toThrow(/must be a JSON array of availability-zone names/);
  });
});

describe('buildApp — CloudFormation template-body budget (#852)', () => {
  // CloudFormation caps a template body at 1 MB; CDK checks against
  // `TEMPLATE_BODY_MAXIMUM_SIZE = 1e6` and, unlike the 500-resource ceiling, only
  // raises an `@aws-cdk/core:Stack.templateSize` *warning* — so this ceiling fails
  // **open**. A template can grow past it, synthesize cleanly, and fail at deploy.
  // These assertions read the emitted artifact rather than `Template.fromStack`,
  // because indentation is the thing under test and `Template` has already parsed
  // it away.
  const CDK_TEMPLATE_BODY_MAXIMUM_SIZE = 1_000_000;
  // CDK starts warning at 80% of the maximum. Budgeting to the same number means a
  // regression trips this assertion at exactly the point CDK would start warning,
  // instead of silently riding the warning band up to the hard limit.
  const TEMPLATE_BODY_BUDGET = CDK_TEMPLATE_BODY_MAXIMUM_SIZE * 0.8;

  let templateText: string;

  beforeAll(async () => {
    const built = await app();
    templateText = fs.readFileSync(
      built.synth().getStackByName(STACK_NAME).templateFullPath,
      'utf8',
    );
  });

  it('emits the template without pretty-print indentation', () => {
    // `suppressTemplateIndentation: true` in main.ts makes CDK pass `undefined` as
    // JSON.stringify's `space` argument, collapsing the document to a single line.
    // Roughly 31% of this template was indentation bytes, all of which counted
    // against the 1 MB ceiling. Assert the shape, not the saving, so the test does
    // not need re-baselining every time a resource is added.
    expect(templateText).not.toContain('\n  ');
  });

  it('stays inside the template-body budget', () => {
    expect(Buffer.byteLength(templateText, 'utf8')).toBeLessThan(TEMPLATE_BODY_BUDGET);
  });
});
