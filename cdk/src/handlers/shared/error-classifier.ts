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

/**
 * Error categories for runtime task errors.
 */
export const ErrorCategory = {
  AUTH: 'auth',
  NETWORK: 'network',
  CONCURRENCY: 'concurrency',
  COMPUTE: 'compute',
  AGENT: 'agent',
  GUARDRAIL: 'guardrail',
  CONFIG: 'config',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
} as const;

export type ErrorCategoryType = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/**
 * Structured classification of a task error.
 */
export interface ErrorClassification {
  readonly category: ErrorCategoryType;
  readonly title: string;
  readonly description: string;
  readonly remedy: string;
  readonly retryable: boolean;
}

interface ErrorPattern {
  readonly pattern: RegExp;
  readonly exclude?: RegExp;
  readonly classification: ErrorClassification;
}

const PATTERNS: readonly ErrorPattern[] = [
  // --- Auth ---
  {
    pattern: /INSUFFICIENT_GITHUB_REPO_PERMISSIONS/i,
    classification: {
      category: ErrorCategory.AUTH,
      title: 'Insufficient GitHub permissions',
      description: 'The GitHub token does not have the required permissions for this repository.',
      remedy: 'Verify the PAT has Contents (Read and write), Pull requests (Read and write), and Issues (Read) scopes for this repo. See the developer guide.',
      retryable: false,
    },
  },
  {
    pattern: /REPO_NOT_FOUND_OR_NO_ACCESS/i,
    classification: {
      category: ErrorCategory.AUTH,
      title: 'Repository not found or inaccessible',
      description: 'The GitHub token cannot access the target repository. It may not exist or the token lacks visibility.',
      remedy: 'Check that the repository name is correct and the configured PAT has access to it.',
      retryable: false,
    },
  },
  {
    pattern: /PR_NOT_FOUND_OR_CLOSED/i,
    classification: {
      category: ErrorCategory.AUTH,
      title: 'Pull request not found or closed',
      description: 'The specified pull request does not exist or has already been closed.',
      remedy: 'Verify the PR number is correct and the PR is still open.',
      retryable: false,
    },
  },
  {
    pattern: /Token cannot (push to|interact with pull requests on)/i,
    classification: {
      category: ErrorCategory.AUTH,
      title: 'Insufficient GitHub token scopes',
      description: 'The GitHub token is missing required scopes for the requested operation.',
      remedy: 'Update the PAT with Contents (Read and write), Pull requests (Read and write), and Issues (Read) scopes.',
      retryable: false,
    },
  },

  // --- Network ---
  {
    pattern: /GITHUB_UNREACHABLE/i,
    classification: {
      category: ErrorCategory.NETWORK,
      title: 'GitHub API unreachable',
      description: 'Could not reach the GitHub API during pre-flight checks.',
      remedy: 'Check network connectivity and DNS Firewall rules. GitHub may be experiencing an outage.',
      retryable: true,
    },
  },
  {
    pattern: /GitHub API returned HTTP [45]\d{2}/i,
    classification: {
      category: ErrorCategory.NETWORK,
      title: 'GitHub API error',
      description: 'The GitHub API returned an error response during pre-flight checks.',
      remedy: 'Check the HTTP status code in the error detail. Retry if transient (5xx), or fix credentials if 401/403.',
      retryable: true,
    },
  },

  // --- Concurrency ---
  {
    pattern: /concurrency limit/i,
    classification: {
      category: ErrorCategory.CONCURRENCY,
      title: 'Concurrency limit reached',
      description: 'The maximum number of concurrent tasks for this user has been reached.',
      remedy: 'Wait for an active task to complete, cancel a running task, or ask an admin to increase the limit.',
      retryable: true,
    },
  },

  // --- Compute ---
  {
    pattern: /Session start failed/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'Agent session failed to start',
      description: 'The compute backend could not start an agent session.',
      remedy: 'Check AgentCore Runtime or ECS cluster health. The runtime ARN may be invalid or the service quota may be exhausted.',
      retryable: true,
    },
  },
  {
    pattern: /ECS container failed/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'ECS container failed',
      description: 'The ECS Fargate container exited with an error.',
      remedy: 'Check the container logs in CloudWatch for the specific failure reason (OOM, image pull failure, etc.).',
      retryable: true,
    },
  },
  {
    pattern: /ECS task exited successfully but agent never wrote terminal status/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'Agent exited without reporting status',
      description: 'The ECS container exited successfully but the agent never wrote a terminal status to DynamoDB.',
      remedy: 'Check agent logs for crashes after the main pipeline completed. This may indicate a bug in the agent finalization code.',
      retryable: true,
    },
  },
  {
    pattern: /ECS poll failed .* consecutive times/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'ECS polling failure',
      description: 'Repeated failures polling the ECS task status.',
      remedy: 'Check ECS cluster health and IAM permissions for DescribeTasks.',
      retryable: true,
    },
  },
  {
    pattern: /Session never started/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'Agent session never started',
      description: 'The task remained in HYDRATING state — the agent container never transitioned to RUNNING.',
      remedy: 'Check if the container image pulled successfully and the runtime is available. Review CloudWatch logs for the session.',
      retryable: true,
    },
  },
  {
    pattern: /Agent session lost.*heartbeat/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'Agent session lost',
      description: 'The agent stopped sending heartbeats. The container may have crashed, been OOM-killed, or stopped unexpectedly.',
      remedy: 'Check CloudWatch logs for the agent session. If OOM, consider a less memory-intensive task or a larger container.',
      retryable: true,
    },
  },

  // --- Agent ---
  {
    pattern: /Agent SDK stream ended without a ResultMessage/i,
    classification: {
      category: ErrorCategory.AGENT,
      title: 'Agent SDK stream ended unexpectedly',
      description: 'The Claude Agent SDK stream closed without returning a result. This may indicate a network interruption, SDK bug, or protocol mismatch.',
      remedy: 'Retry the task. If persistent, check the agent container logs and SDK version compatibility.',
      retryable: true,
    },
  },
  // Specific agent_status classifiers — ordered BEFORE the generic
  // ``Task did not succeed.*agent_status=`` catch-all so the concrete
  // cap / runtime-error signals surface to users rather than the
  // opaque "Agent task did not succeed" title. Each matches the
  // ``agent_status`` literals emitted by ``agent/src/pipeline.py``
  // (see ``_resolve_overall_task_status``) and
  // ``agent/src/runner.py``.
  {
    pattern: /agent_status=['"]?error_max_turns['"]?/i,
    classification: {
      category: ErrorCategory.TIMEOUT,
      title: 'Exceeded max turns',
      description: 'The agent reached the configured ``max_turns`` limit before completing.',
      remedy: 'Raise ``--max-turns`` on the submit call, simplify the task, or break it into smaller sub-tasks.',
      retryable: true,
    },
  },
  {
    pattern: /agent_status=['"]?error_max_budget_usd['"]?/i,
    classification: {
      category: ErrorCategory.TIMEOUT,
      title: 'Exceeded max budget',
      description: 'The agent reached the configured ``max_budget_usd`` limit before completing.',
      remedy: 'Raise ``--max-budget`` on the submit call, simplify the task, or break it into smaller sub-tasks.',
      retryable: true,
    },
  },
  {
    pattern: /agent_status=['"]?error_during_execution['"]?/i,
    classification: {
      category: ErrorCategory.AGENT,
      title: 'Agent errored during execution',
      description: 'The agent raised an uncaught error mid-turn. The Claude Agent SDK reported the task as failed before a clean terminal.',
      remedy: 'Retry the task. If persistent, check the agent container logs and the PR branch for partial state.',
      retryable: true,
    },
  },
  {
    pattern: /Task did not succeed.*agent_status=/i,
    classification: {
      category: ErrorCategory.AGENT,
      title: 'Agent task did not succeed',
      description: 'The agent completed but reported a non-success status.',
      remedy: 'Check the agent logs and PR (if created) for details on what went wrong during execution.',
      retryable: false,
    },
  },
  {
    pattern: /receive_response\(\) failed/i,
    classification: {
      category: ErrorCategory.AGENT,
      title: 'Agent communication failure',
      description: 'The agent runner failed to receive a response from the Claude Agent SDK.',
      remedy: 'Retry the task. If persistent, check Bedrock model availability and agent container connectivity.',
      retryable: true,
    },
  },

  // --- Guardrail ---
  {
    pattern: /Guardrail blocked/i,
    classification: {
      category: ErrorCategory.GUARDRAIL,
      title: 'Content blocked by guardrail',
      description: 'Bedrock Guardrails blocked the task content during hydration.',
      remedy: 'Review the task description, issue body, or PR content for policy violations. Rephrase and resubmit.',
      retryable: false,
    },
  },
  {
    pattern: /content policy/i,
    classification: {
      category: ErrorCategory.GUARDRAIL,
      title: 'Content policy violation',
      description: 'The task description was blocked by the content screening policy.',
      remedy: 'Rephrase the task description to comply with content policy guidelines.',
      retryable: false,
    },
  },

  // --- Config ---
  {
    pattern: /Blueprint config load failed/i,
    classification: {
      category: ErrorCategory.CONFIG,
      title: 'Blueprint configuration error',
      description: 'Failed to load the per-repo Blueprint configuration from DynamoDB.',
      remedy: 'Verify the Blueprint construct is deployed correctly for this repository. Check the RepoTable in DynamoDB.',
      retryable: true,
    },
  },
  {
    pattern: /Hydration failed/i,
    exclude: /Guardrail blocked/i,
    classification: {
      category: ErrorCategory.CONFIG,
      title: 'Context hydration failed',
      description: 'Failed to assemble the task context (issue content, PR data, memory).',
      remedy: 'Check GitHub API accessibility, token permissions, and Bedrock Guardrails availability.',
      retryable: true,
    },
  },

  // --- Timeout ---
  {
    pattern: /poll timeout exceeded/i,
    classification: {
      category: ErrorCategory.TIMEOUT,
      title: 'Task timed out',
      description: 'The orchestrator polling window expired before the agent completed.',
      remedy: 'The task may be too large for the configured turn/budget limits. Consider breaking it into smaller tasks or increasing max_turns.',
      retryable: false,
    },
  },
];

const UNKNOWN_CLASSIFICATION: ErrorClassification = {
  category: ErrorCategory.UNKNOWN,
  title: 'Unexpected error',
  description: 'An unrecognized error occurred during task execution.',
  remedy: 'Check the full error message and agent logs for details. If the issue persists, report it.',
  retryable: false,
};

/**
 * Classify an error message into a structured category with user-facing guidance.
 * Returns null if the error message is empty or undefined.
 *
 * @param errorMessage - the raw error_message string from a task record.
 * @returns the classification, or null if there is no error to classify.
 */
export function classifyError(errorMessage: string | undefined | null): ErrorClassification | null {
  if (!errorMessage) {
    return null;
  }

  for (const { pattern, exclude, classification } of PATTERNS) {
    if (pattern.test(errorMessage) && (!exclude || !exclude.test(errorMessage))) {
      return classification;
    }
  }

  return UNKNOWN_CLASSIFICATION;
}
