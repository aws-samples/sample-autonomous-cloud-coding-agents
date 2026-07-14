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
  // Environmental blocker (#251): agent could not progress for a missing
  // secret, egress denial, unreachable dependency, or fail-closed policy
  // engine error. Distinct from AUTH/CONFIG so operators can spot the
  // typed, self-diagnosed faults the platform names precisely.
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
} as const;

export type ErrorCategoryType = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/**
 * WHO should act, and whether retrying the SAME request can help — the axis a
 * channel reader needs to answer "just retry, or tell my admin?". Distinct from
 * ``category`` (which names WHAT broke) and from ``retryable`` (a plain boolean
 * that conflates "self-heals on retry" with "you must change something first"):
 *   - ``transient`` — an infrastructure/service HICCUP that usually clears itself:
 *     a retry of the identical request is the right move (ECS deploy-race, ENI
 *     delay, network blip, Bedrock throttle/5xx, concurrency cap). The platform
 *     may auto-retry these once at session-start; the user just retries otherwise.
 *   - ``service`` — a real PLATFORM/CONFIG fault an operator owns: retrying the
 *     same request won't change the outcome until an admin fixes the setup (bad
 *     token/scopes, model not enabled, quota, blueprint misconfig).
 *   - ``user`` — the REQUEST or the code is the thing to change: the build/tests
 *     failed, content was blocked, the repo/PR wasn't found, max turns/budget hit.
 * Every classification carries exactly one. Guidance copy is derived from this.
 */
export const ErrorClass = {
  TRANSIENT: 'transient',
  SERVICE: 'service',
  USER: 'user',
} as const;

export type ErrorClassType = (typeof ErrorClass)[keyof typeof ErrorClass];

/**
 * Structured classification of a task error.
 */
export interface ErrorClassification {
  readonly category: ErrorCategoryType;
  readonly title: string;
  readonly description: string;
  readonly remedy: string;
  readonly retryable: boolean;
  /**
   * transient (self-heals on retry) vs service (admin must fix) vs user (change
   * the request/code). Drives {@link retryGuidance} and the session-start
   * auto-retry. Optional so older/hand-built classifications still type-check;
   * absent ⇒ treated as ``user`` (safest: don't promise a retry works, don't
   * auto-retry). New PATTERNS should always set it.
   */
  readonly errorClass?: ErrorClassType;
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
      errorClass: ErrorClass.SERVICE,
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
      errorClass: ErrorClass.SERVICE,
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
      errorClass: ErrorClass.USER,
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
      errorClass: ErrorClass.SERVICE,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
    },
  },

  // --- Compute ---
  {
    // A task dispatched against a task-def revision that was deregistered by a
    // deploy (ABCA-660/663). Transient + self-clearing on retry; the family-based
    // RunTask fix prevents it going forward, but keep a precise classification so
    // any historical/edge occurrence reads as "temporary, just retry", not a
    // scary compute-health alarm.
    pattern: /TaskDefinition is inactive/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'Couldn\'t start — the compute environment was mid-update',
      description: 'The task was dispatched against an ECS task definition revision that a concurrent deployment had just replaced.',
      remedy: 'This is a transient deploy-timing race, not a problem with your request. Retry the task; it will pick up the current task definition. If it persists, an admin should check for a stuck/failed deployment.',
      retryable: true,
      errorClass: ErrorClass.TRANSIENT,
    },
  },
  {
    pattern: /Session start failed/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'Agent session failed to start',
      description: 'The compute backend could not start an agent session.',
      remedy: 'Check AgentCore Runtime or ECS cluster health. The runtime ARN may be invalid or the service quota may be exhausted.',
      retryable: true,
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
    },
  },
  {
    // The `claude` CLI on the agent image couldn't be exec'd: either the OS
    // refused the binary (`OSError: [Errno 8] Exec format error: 'claude'`) or
    // the claude-code shim reports its platform-native binary was never placed
    // ("claude native binary not installed" — its postinstall silently fell
    // back at image-build time). Live-caught on ABCA-659's retry: all 3 ECS runs
    // died at the run_agent step this way on a freshly rebuilt image, while the
    // native binary was present but unwired. This is an IMAGE/infra fault, NOT a
    // problem with the user's request — a fresh attempt usually lands on a host
    // that materializes the image cleanly; a persistent one is a bad build an
    // admin must rebuild. Without this bucket it fell through to a bare
    // "Unexpected error" with no guidance (the anti-pattern the error-feedback
    // work set out to kill). Matched before AGENT/UNKNOWN so the precise,
    // retry-oriented copy wins.
    pattern: /Exec format error.*claude|claude.*Exec format error|claude native binary not installed/i,
    classification: {
      category: ErrorCategory.COMPUTE,
      title: 'Couldn\'t start the coding agent (environment issue)',
      description: 'The agent runtime couldn\'t launch the `claude` CLI on the compute image — an infrastructure/image problem, not a problem with your request or code.',
      remedy: 'This is usually a transient image/compute hiccup. Reply here to try again — a fresh attempt typically clears it. If every attempt fails the same way, the agent image needs a rebuild: contact your ABCA admin with the task id above.',
      retryable: true,
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
    },
  },
  // Specific agent_status classifiers — ordered BEFORE the generic
  // ``Task did not succeed.*agent_status=`` catch-all so the concrete
  // cap / runtime-error signals surface to users rather than the
  // opaque "Agent task did not succeed" title. Each matches the
  // status literal under BOTH wrappers the agent emits:
  //   - ``agent_status=error_max_turns`` — ``agent/src/pipeline.py``
  //     (``_resolve_overall_task_status``); and
  //   - ``Agent session error (subtype='error_max_turns')`` —
  //     ``agent/src/runner.py:515`` (the terminal-error path).
  // Keying on only ``agent_status=`` missed the ``subtype=`` wrapper, so a
  // real max-turns failure fell through to UNKNOWN → "Unexpected error"
  // (live-caught on ABCA-483: a task hit the 100-turn cap but the reply
  // said "Unexpected error"). Match either ``agent_status=``/``subtype=``.
  {
    // A max-turns cap is a correct, self-explanatory classification. When the
    // stuck-guard observed the last several tool calls repeating the SAME failure
    // it is appended to the reason as a neutral OBSERVATION ("last tool calls
    // repeated: `<cmd>` → <err>") — we surface WHAT was on screen but deliberately
    // make NO causal claim about whether more turns would have helped: the
    // trailing window (last 6 calls) can't distinguish a hard blocker from a long
    // task that hit a recoverable snag only at the tail, so re-framing the whole
    // run as "retrying a failing step" would misrepresent the latter. The reader
    // sees the observed detail and the neutral remedy and decides.
    pattern: /(?:agent_status|subtype)=['"]?error_max_turns['"]?/i,
    classification: {
      category: ErrorCategory.TIMEOUT,
      title: 'Exceeded max turns',
      description: 'The agent reached the configured ``max_turns`` limit before completing. If a repeated tool failure was observed near the end, it is shown in the detail below.',
      remedy: 'Look at the detail below to see what the agent was doing when it ran out. Raise ``--max-turns`` on the submit call, simplify the task, or break it into smaller sub-tasks — and if the detail shows an environment/tooling blocker (auth, credentials, permission, network, disk), fix that first, then reply here to retry.',
      retryable: true,
      errorClass: ErrorClass.USER,
    },
  },
  {
    pattern: /(?:agent_status|subtype)=['"]?error_max_budget_usd['"]?/i,
    classification: {
      category: ErrorCategory.TIMEOUT,
      title: 'Exceeded max budget',
      description: 'The agent reached the configured ``max_budget_usd`` limit before completing.',
      remedy: 'Raise ``--max-budget`` on the submit call, simplify the task, or break it into smaller sub-tasks.',
      retryable: true,
      errorClass: ErrorClass.USER,
    },
  },
  {
    pattern: /(?:agent_status|subtype)=['"]?error_during_execution['"]?/i,
    classification: {
      category: ErrorCategory.AGENT,
      title: 'Agent errored during execution',
      description: 'The agent raised an uncaught error mid-turn. The Claude Agent SDK reported the task as failed before a clean terminal.',
      remedy: 'Retry the task. If persistent, check the agent container logs and the PR branch for partial state.',
      retryable: true,
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.USER,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.USER,
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
      errorClass: ErrorClass.USER,
    },
  },

  // --- Config ---
  {
    pattern: /not available on your bedrock|not available.*bedrock deployment/i,
    classification: {
      category: ErrorCategory.CONFIG,
      title: 'Bedrock model not available in this account or Region',
      description:
        'The requested model or inference profile cannot be invoked. This is distinct from IAM deny errors: the account may still need Marketplace subscription flow for the model, Anthropic first-time use (use case) submission, or the model may not be supported in this Region.',
      remedy:
        'Complete model access prerequisites in Amazon Bedrock (Anthropic first-time use via the console model catalog or PutUseCaseForModelAccess; AWS Marketplace Subscribe/ViewSubscriptions for first-time serverless model enablement where required; valid payment method for Marketplace-backed models). Grant bedrock:InvokeModel* on the inference profile and foundation model. For InvokeModel, use a supported inference profile ID in modelId where on-demand requires it. See https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html and https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html',
      retryable: false,
      errorClass: ErrorClass.SERVICE,
    },
  },
  {
    pattern: /Blueprint config load failed/i,
    classification: {
      category: ErrorCategory.CONFIG,
      title: 'Blueprint configuration error',
      description: 'Failed to load the per-repo Blueprint configuration from DynamoDB.',
      remedy: 'Verify the Blueprint construct is deployed correctly for this repository. Check the RepoTable in DynamoDB.',
      retryable: true,
      errorClass: ErrorClass.SERVICE,
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
      errorClass: ErrorClass.TRANSIENT,
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
      errorClass: ErrorClass.TRANSIENT,
    },
  },
];

/**
 * Canonical blocker-reason contract (#251, decision D). Matches
 * ``BLOCKED[<kind>]`` and, separately, the optional `` (resource: <resource>)``
 * segment ``format_blocker_reason`` appends. This is the SINGLE source of truth
 * on the CDK side and must stay in lockstep with ``format_blocker_reason`` in
 * ``agent/src/progress_writer.py`` and the taxonomy table in
 * ``docs/design/CEDAR_HITL_GATES.md`` §13.
 *
 * The two parts are matched independently (not one ``$``-anchored regex)
 * because ``failTask`` persists ``TaskResult.error`` verbatim and it may be
 * wrapped with trailing text or a stack trace after the reason — anchoring the
 * resource group to end-of-string would silently drop the host/secret name in
 * exactly that case. ``kind`` is matched case-insensitively and lowercased
 * before dispatch so a mixed-case producer still routes to the right remedy.
 */
const BLOCKED_KIND = /BLOCKED\[([a-z_]+)\]/i;
const BLOCKED_RESOURCE = /\(resource:\s*([^)]+)\)/i;

/** Closed blocker-kind set — mirrors ``BLOCKER_KINDS`` in agent/src/progress_writer.py. */
export type BlockerKind =
  | 'missing_secret'
  | 'egress_denied'
  | 'dependency_unreachable'
  | 'policy_fail_closed'
  | 'auth_failure'
  | 'unknown_environmental';

/**
 * Build the canonical terminal-reason string for an orchestration-side blocker
 * (#251, decision D) — the TypeScript twin of ``format_blocker_reason`` in
 * ``agent/src/progress_writer.py``. Produces ``BLOCKED[<kind>]: <detail>`` with
 * `` (resource: <resource>)`` appended when ``resource`` is set, so the same
 * ``classifyError`` regex that handles agent-carried reasons also classifies
 * reasons written directly by the orchestrator (e.g. a missing secret detected
 * during hydration).
 */
const BLOCKER_KINDS: ReadonlySet<string> = new Set<BlockerKind>([
  'missing_secret',
  'egress_denied',
  'dependency_unreachable',
  'policy_fail_closed',
  'auth_failure',
  'unknown_environmental',
]);

export function formatBlockerReason(kind: BlockerKind, detail: string, resource?: string): string {
  // Normalise an out-of-set kind to unknown_environmental — matches the Python
  // format_blocker_reason fallback so a value cast via `as BlockerKind` (or a
  // future non-literal caller) can never emit a reason the classifier's closed
  // taxonomy won't recognise.
  const safeKind = BLOCKER_KINDS.has(kind) ? kind : 'unknown_environmental';
  const base = `BLOCKED[${safeKind}]: ${detail}`;
  return resource ? `${base} (resource: ${resource})` : base;
}

/** Per-kind blocker remedy builder. ``resource`` is the extracted name (secret, host, …). */
function blockerClassification(kind: string, resource: string | undefined): ErrorClassification {
  const res = resource?.trim();
  switch (kind) {
    case 'missing_secret':
      return {
        category: ErrorCategory.BLOCKED,
        title: 'Blocked: missing secret',
        description: `A required secret${res ? ` (\`${res}\`)` : ''} was never wired into the blueprint, so the agent could not proceed.`,
        remedy: `Wire the secret${res ? ` \`${res}\`` : ''} into this repo's blueprint (Secrets Manager) and resubmit. The agent never acquires secrets itself.`,
        retryable: false,
      };
    case 'egress_denied':
      return {
        category: ErrorCategory.BLOCKED,
        title: 'Blocked: egress denied',
        description: `The agent's connection to a non-allowlisted host${res ? ` (\`${res}\`)` : ''} was blocked by the DNS Firewall.`,
        remedy: `Allowlist the domain${res ? ` \`${res}\`` : ''} in the DNS Firewall rule group if it is a legitimate dependency, then resubmit. The agent never widens egress itself.`,
        retryable: false,
      };
    case 'dependency_unreachable':
      return {
        category: ErrorCategory.BLOCKED,
        title: 'Blocked: dependency unreachable',
        description: `A dependency or registry${res ? ` (\`${res}\`)` : ''} could not be reached after bounded retries.`,
        remedy: 'Check whether the registry is up and reachable from the agent VPC. This is often transient — retry the task.',
        retryable: true,
      };
    case 'policy_fail_closed':
      return {
        category: ErrorCategory.BLOCKED,
        title: 'Blocked: policy engine fail-closed',
        description: 'The Cedar policy engine errored or was unavailable, so the tool call was denied fail-closed. This is a misconfiguration signal, not an intentional hard-deny.',
        remedy: 'Check the agent policy-engine logs (cedarpy load / policy compilation). Fix the policy bundle or engine availability, then resubmit.',
        retryable: false,
      };
    case 'auth_failure': {
      // A Secrets Manager ARN resource means the secret exists but couldn't be
      // read (AccessDenied / throttling) — the fix is IAM on the task role or
      // blueprint wiring, NOT PAT scopes (#251 review). A non-ARN resource is a
      // runtime credential rejection where scope/validity is the right advice.
      const isSecretArn = res?.startsWith('arn:aws:secretsmanager:') ?? false;
      return {
        category: ErrorCategory.BLOCKED,
        title: 'Blocked: authentication rejected',
        description: isSecretArn
          ? `The GitHub token secret${res ? ` (\`${res}\`)` : ''} exists but could not be read (access denied or throttled).`
          : `A credential was present but rejected${res ? ` for \`${res}\`` : ''}.`,
        remedy: isSecretArn
          ? 'Grant the task role `secretsmanager:GetSecretValue` on this secret (check the secret resource policy and the blueprint wiring), then resubmit.'
          : 'Verify the credential is valid and has the required scopes, then resubmit.',
        retryable: false,
      };
    }
    default:
      // unknown_environmental + any future/mis-typed kind
      return {
        category: ErrorCategory.BLOCKED,
        title: 'Blocked: environmental fault',
        description: `The agent was blocked by an environmental fault${res ? ` involving \`${res}\`` : ''} that could not be classified further.`,
        remedy: 'Check the agent logs for the blocker detail. This is an environmental issue, not a code problem.',
        retryable: false,
      };
  }
}

const UNKNOWN_CLASSIFICATION: ErrorClassification = {
  category: ErrorCategory.UNKNOWN,
  title: 'Unexpected error',
  description: 'An unrecognized error occurred during task execution.',
  remedy: 'Check the full error message and agent logs for details. If the issue persists, report it.',
  retryable: false,
  // Unknown = don't over-promise: a retry MIGHT clear a one-off, but we can't
  // assert it, so treat like 'user' (surface + suggest escalation) rather than
  // auto-retrying an error we don't understand.
  errorClass: ErrorClass.USER,
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

  // Environmental blockers (#251) carry a canonical ``BLOCKED[<kind>]`` prefix
  // and an extractable resource — check them first so the remedy can name the
  // exact secret / host rather than falling through to a generic pattern.
  const kindMatch = BLOCKED_KIND.exec(errorMessage);
  if (kindMatch) {
    const resource = BLOCKED_RESOURCE.exec(errorMessage)?.[1];
    return blockerClassification(kindMatch[1].toLowerCase(), resource);
  }

  for (const { pattern, exclude, classification } of PATTERNS) {
    if (pattern.test(errorMessage) && (!exclude || !exclude.test(errorMessage))) {
      return classification;
    }
  }

  return UNKNOWN_CLASSIFICATION;
}

/**
 * True when the error is a transient infrastructure/service HICCUP that a plain
 * retry usually clears (see {@link ErrorClass}). Used to gate the session-start
 * auto-retry AND to tune the guidance copy. Absent errorClass ⇒ NOT transient
 * (conservative: never auto-retry an error we didn't explicitly mark).
 */
export function isTransientError(classification: ErrorClassification | null | undefined): boolean {
  return classification?.errorClass === ErrorClass.TRANSIENT;
}

/**
 * One short, user-facing NEXT-STEP line for a classified failure — the answer to
 * "should I just retry this, or tell my admin?" that a channel reader (Linear/
 * Slack) can act on WITHOUT reading CloudWatch. Derived from the classification's
 * ``errorClass`` (transient / service / user — never the raw error), so it stays
 * safe to show and consistent with the CLI's structured display.
 *
 * The three-way split (which the ``retryable`` boolean alone couldn't express):
 *   - **transient** — infra/service hiccup, request is fine, a retry clears it
 *     (ECS deploy-race, ENI delay, network blip, throttle, concurrency cap). If
 *     ``autoRetried`` is set, say we ALREADY retried once and it still failed.
 *   - **service** — a real platform/config fault an operator owns; retrying the
 *     same request won't change the outcome until an admin fixes the setup.
 *   - **user** — the request or the code is the thing to change (build/test
 *     failed, content blocked, wrong PR, max turns) — a plain reply-to-retry with
 *     guidance, except guardrail which needs an edit.
 * Returned WITHOUT a trailing space; callers add their own separator.
 *
 * @param autoRetried set when the platform already auto-retried a transient
 *   failure once (session-start) — the copy then reflects "tried again, still
 *   failed" instead of "reply to retry".
 */
export function retryGuidance(
  classification: ErrorClassification,
  autoRetried = false,
): string {
  const cls = classification.errorClass ?? ErrorClass.USER;

  if (cls === ErrorClass.TRANSIENT) {
    return autoRetried
      ? 'This looks like a temporary infrastructure issue — I automatically tried again and it still failed. '
        + 'Reply here to retry, or if it keeps happening, contact your ABCA admin.'
      : 'This is usually a temporary infrastructure issue, not a problem with your request — '
        + 'reply here to try again. If it keeps happening, contact your ABCA admin.';
  }
  if (cls === ErrorClass.SERVICE) {
    // Platform/config fault — a plain retry won't change the outcome; an admin owns it.
    return 'Retrying as-is won\'t fix this — it needs your ABCA admin to correct the access or configuration, then re-apply the label.';
  }
  // user: the request/code is the thing to change.
  if (classification.category === ErrorCategory.GUARDRAIL) {
    return 'Retrying the same text won\'t help — edit the request to remove the flagged content, then re-apply the label.';
  }
  if (classification.retryable) {
    // build/test failed, max-turns, transient agent crash → a fresh attempt (or guidance) can clear it.
    return 'Reply here with any extra guidance and I\'ll try again.';
  }
  // not-retryable user/unknown (e.g. agent reported non-success) — don't promise a retry works.
  return 'A retry may not resolve this on its own — if it repeats, contact your ABCA admin with the task id above.';
}
