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

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { buildAppId, ComponentUaAspect, SolutionUaAspect } from '../../src/constructs/solution-ua-aspect';

describe('buildAppId', () => {
  test('defaults to uksb-wt64nei4u6#{stackName}', () => {
    expect(buildAppId('backgroundagent-dev')).toBe('uksb-wt64nei4u6#backgroundagent-dev');
  });

  test('CloudFormation-legal stack names pass through unsanitized', () => {
    // CFN names are [A-Za-z0-9-]; all already UA-token-safe.
    expect(buildAppId('ABCA-Prod-123')).toBe('uksb-wt64nei4u6#ABCA-Prod-123');
  });

  test('clips to the documented 50-char value cap', () => {
    const appId = buildAppId('a'.repeat(80));
    expect(appId).toBeDefined();
    expect(appId!.length).toBe(50);
    expect(appId!.startsWith('uksb-wt64nei4u6#aaaa')).toBe(true);
  });

  test('explicit override is used verbatim (sanitized)', () => {
    expect(buildAppId('stack', 'custom-value')).toBe('custom-value');
    expect(buildAppId('stack', 'has/slash')).toBe('has-slash');
  });

  test('empty-string override opts out (undefined)', () => {
    expect(buildAppId('stack', '')).toBeUndefined();
    expect(buildAppId('stack', '   ')).toBeUndefined();
  });
});

function envVarsOfFirstFunction(aspects: (stack: Stack) => void): Record<string, string> {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  new lambda.Function(stack, 'Fn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });
  aspects(stack);
  const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function');
  const first = Object.values(fns)[0] as { Properties?: { Environment?: { Variables?: Record<string, string> } } };
  return first.Properties?.Environment?.Variables ?? {};
}

describe('SolutionUaAspect', () => {
  test('sets AWS_SDK_UA_APP_ID on every Lambda', () => {
    const vars = envVarsOfFirstFunction((s) => Aspects.of(s).add(new SolutionUaAspect('uksb-wt64nei4u6#dev')));
    expect(vars.AWS_SDK_UA_APP_ID).toBe('uksb-wt64nei4u6#dev');
  });

  test('undefined appId (opt-out) sets nothing', () => {
    const vars = envVarsOfFirstFunction((s) => Aspects.of(s).add(new SolutionUaAspect(undefined)));
    expect(vars.AWS_SDK_UA_APP_ID).toBeUndefined();
  });
});

describe('ComponentUaAspect', () => {
  test('sets ABCA_COMPONENT on every Lambda in scope', () => {
    const vars = envVarsOfFirstFunction((s) => Aspects.of(s).add(new ComponentUaAspect('webhook')));
    expect(vars.ABCA_COMPONENT).toBe('webhook');
  });
});
