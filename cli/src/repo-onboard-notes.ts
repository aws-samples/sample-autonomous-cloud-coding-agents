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

import { RepoConfigRow } from './repo-lookup';

export interface RepoOnboardNotesInput {
  readonly config: RepoConfigRow;
  readonly platformRuntimeArn: string | null;
  readonly platformGithubTokenSecretArn: string | null;
}

/** Operator-facing notes after `bgagent repo onboard` (text and JSON output). */
export function buildRepoOnboardNotes(input: RepoOnboardNotesInput): readonly string[] {
  const notes: string[] = [
    'This command writes RepoTable only. With no per-repo overrides, tasks inherit the '
    + 'platform RuntimeArn and GitHubTokenSecretArn (IAM for those is granted at CDK deploy).',
    'For Cedar policies, egress rules, custom runtime/token IAM, and durable lifecycle, '
    + 'prefer a CDK Blueprint construct and `mise //cdk:deploy`.',
  ];

  const customRuntime = input.config.runtime_arn;
  if (customRuntime && customRuntime !== input.platformRuntimeArn) {
    notes.push(
      'WARNING: A custom runtime_arn is stored. The orchestrator Lambda must be granted '
      + 'bedrock-agentcore:InvokeAgentRuntime on that ARN via TaskOrchestrator '
      + 'additionalRuntimeArns — update CDK and redeploy, or tasks may fail with AccessDenied.',
    );
  }

  const customSecret = input.config.github_token_secret_arn;
  if (customSecret && customSecret !== input.platformGithubTokenSecretArn) {
    notes.push(
      'WARNING: A custom github_token_secret_arn is stored. The orchestrator Lambda must be '
      + 'granted secretsmanager:GetSecretValue on that secret via TaskOrchestrator '
      + 'additionalSecretArns — update CDK and redeploy, or context hydration may fail.',
    );
  }

  if (input.config.compute_type === 'ecs') {
    notes.push(
      'NOTE: compute_type=ecs requires ECS wired into the stack (TaskOrchestrator ecsConfig). '
      + 'Verify your CDK stack before submitting tasks.',
    );
  }

  return notes;
}
