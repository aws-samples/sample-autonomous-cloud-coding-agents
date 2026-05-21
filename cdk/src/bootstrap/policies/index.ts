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

import { aws_iam as iam } from 'aws-cdk-lib';

import { applicationPolicy } from './application';
import { infrastructurePolicy } from './infrastructure';
import { observabilityPolicy } from './observability';

export { applicationPolicy } from './application';
export { infrastructurePolicy } from './infrastructure';
export { observabilityPolicy } from './observability';

/**
 * Returns all three bootstrap IAM PolicyDocuments as an array.
 */
export function allPolicies(): iam.PolicyDocument[] {
  return [infrastructurePolicy(), applicationPolicy(), observabilityPolicy()];
}
