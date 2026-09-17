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

import { NestedStack, Stack, Tags, Token } from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  LambdaMicrovmCompute,
  type LambdaMicrovmComputeProps,
  MICROVM_BACKEND_TAG_KEY,
  MICROVM_BACKEND_TAG_VALUE,
} from './lambda-microvm-compute';

export interface LambdaMicrovmStackProps extends Omit<
  LambdaMicrovmComputeProps, 'buildRoleName' | 'connectorOperatorRoleName'
> {
  readonly deploymentName: string;
  readonly executionRole: iam.Role;
}

/** Child deployment for MicroVM resources; shared runtime trust stays in the parent. */
export class LambdaMicrovmStack extends NestedStack {
  public readonly compute: LambdaMicrovmCompute;

  constructor(scope: Construct, id: string, props: LambdaMicrovmStackProps) {
    super(scope, id, {
      description: 'ABCA Lambda MicroVM image, storage, build roles and network connectors',
    });
    if (Stack.of(props.executionRole) !== this.nestedStackParent) {
      throw new Error('LambdaMicrovmStack executionRole must be owned by its parent stack');
    }
    // CDK creates bucket-cleanup providers at stack scope, outside Compute.
    // Those providers are also MicroVM-specific in this child.
    Tags.of(this).add(MICROVM_BACKEND_TAG_KEY, MICROVM_BACKEND_TAG_VALUE);
    // Automatic IAM names include the generated nested-stack name and can lose
    // their discriminating role suffix to truncation. Explicit parent names keep
    // the bootstrap's unconditioned PassRole grant limited to these two roles.
    const roleName = (suffix: string): string => {
      const name = `${props.deploymentName}-${suffix}`;
      if (Token.isUnresolved(name) || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(name)) {
        throw new Error(`Nested MicroVM role name must be concrete and at most 64 characters: ${suffix}`);
      }
      return name;
    };
    this.compute = new LambdaMicrovmCompute(this, 'Compute', {
      ...props,
      buildRoleName: roleName('MicrovmBuildRole'),
      connectorOperatorRoleName: roleName('MicrovmConnectorRole'),
    });
  }
}
