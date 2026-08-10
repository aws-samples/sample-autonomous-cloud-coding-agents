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

  if (input.config.compute_type === 'lambda-microvm') {
    // Mirrors the ECS note, plus the one thing that has no ECS analogue: the
    // substrate can be fully deployed and still carry no IMAGE (ADR-021's
    // three-state table — the artifact bucket must exist before the artifact can
    // be uploaded), in which case the orchestrator gets no MICROVM_* env block at
    // all and tasks fail with the strategy's own remedy. The `bgagent repo
    // onboard` substrate gate cannot see that: `ComputeSubstrate` says the
    // backend was provisioned, not that an image was configured.
    notes.push(
      'NOTE: compute_type=lambda-microvm requires the MicroVM substrate wired into the stack '
      + '(TaskOrchestrator microvmConfig) AND a MicroVM image configured. A stack deployed with '
      + '--context compute_type=lambda-microvm but no image yet (the expected FIRST deploy) still '
      + 'rejects tasks: package the artifact with cdk/scripts/package-microvm-artifact.sh, then '
      + 'redeploy with --context microvm_base_image_arn=<arn> --context microvm_base_image_version=<v> '
      + '(or --context microvm_image_identifier=<imageArn>).',
      'NOTE: the lambda-microvm backend has no smoke-parity guarantee yet (ADR-021 P1 — synth emits '
      + 'abca:microvm-image-p1-smoke-unverified). Keep production repos on agentcore or ecs until P2.',
    );
  }

  return notes;
}
