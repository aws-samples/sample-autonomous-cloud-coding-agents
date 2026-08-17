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

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentVpc } from '../../src/constructs/agent-vpc';

describe('AgentVpc', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new AgentVpc(stack, 'AgentVpc');
    template = Template.fromStack(stack);
  });

  test('creates a VPC', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('creates public and private subnets', () => {
    // 2 AZs × 2 subnet types = 4 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  test('creates 1 NAT gateway by default', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('creates a flow log with ALL traffic type', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      TrafficType: 'ALL',
      LogDestinationType: 'cloud-watch-logs',
    });
  });

  test('flow log group has 1 month retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
  });

  test('creates a security group that denies all outbound by default', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'AgentCore Runtime - egress TCP 443 only',
    });
  });

  test('security group allows TCP 443 egress', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
        }),
      ]),
    });
  });

  test('creates S3 gateway endpoint', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([
            Match.stringLikeRegexp('com\\.amazonaws\\.'),
            Match.stringLikeRegexp('\\.s3'),
          ]),
        ]),
      }),
      VpcEndpointType: 'Gateway',
    });
  });

  test('creates DynamoDB gateway endpoint', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([
            Match.stringLikeRegexp('com\\.amazonaws\\.'),
            Match.stringLikeRegexp('\\.dynamodb'),
          ]),
        ]),
      }),
      VpcEndpointType: 'Gateway',
    });
  });

  test('creates 7 interface endpoints with private DNS', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: {
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      },
    });
    expect(Object.keys(endpoints).length).toBe(7);
  });

  test('creates 2 gateway endpoints', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: {
        VpcEndpointType: 'Gateway',
      },
    });
    expect(Object.keys(endpoints).length).toBe(2);
  });
});

describe('AgentVpc with custom props', () => {
  test('accepts custom maxAzs', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new AgentVpc(stack, 'AgentVpc', { maxAzs: 3 });
    const template = Template.fromStack(stack);

    // 3 AZs × 2 subnet types = 6 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  test('accepts custom natGateways count', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new AgentVpc(stack, 'AgentVpc', { natGateways: 2 });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::NatGateway', 2);
  });

  test('accepts explicit availabilityZones and ignores maxAzs', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new AgentVpc(stack, 'AgentVpc', {
      availabilityZones: ['us-east-1b', 'us-east-1c'],
      maxAzs: 3, // should be ignored when availabilityZones is provided
    });
    const template = Template.fromStack(stack);

    // 2 explicit AZs × 2 subnet types = 4 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 4);

    // Subnets are pinned to the requested AZ *names* — the whole point of the
    // fix (a wrong-count assertion would pass even if AZs were unpinned).
    template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'us-east-1b' });
    template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'us-east-1c' });
  });

  test('env-agnostic synth falls back to Fn::GetAZs (no pinning, no crash)', () => {
    const app = new App();
    // No env → account/region are tokens. The production AgentStack synthesizes
    // this way, so auto-pin is skipped and CDK selects AZs at deploy time.
    const stack = new Stack(app, 'TestStack');
    new AgentVpc(stack, 'AgentVpc');
    const template = Template.fromStack(stack);

    // Default maxAzs (2) → 4 subnets; AZ resolved at deploy via Fn::GetAZs.
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    template.hasResourceProperties('AWS::EC2::Subnet', {
      AvailabilityZone: {
        'Fn::Select': Match.arrayWith([{ 'Fn::GetAZs': '' }]),
      },
    });
  });

  test('availabilityZones with 3 zones creates 6 subnets', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new AgentVpc(stack, 'AgentVpc', {
      availabilityZones: ['us-east-1b', 'us-east-1c', 'us-east-1d'],
    });
    const template = Template.fromStack(stack);

    // 3 AZs × 2 subnet types = 6 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });
});
