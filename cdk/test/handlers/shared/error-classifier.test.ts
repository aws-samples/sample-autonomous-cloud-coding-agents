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

import { classifyError, ErrorCategory, ErrorClass, formatMicrovmTerminalFailure, isTransientError, retryGuidance, type ErrorClassification } from '../../../src/handlers/shared/error-classifier';
import { LAMBDA_MICROVM_SUPPORTED_REGIONS } from '../../../src/handlers/shared/microvm-regions';
import { toTaskDetail, type TaskRecord } from '../../../src/handlers/shared/types';

const MSG_CLASSIC = 'PushCapabilityError: Token cannot push to owner/repo: GitHub refused the classic personal access token write access (remote: Permission to owner/repo.git denied to <token user>). To fix it, give the token the `public_repo` scope for a public repository, or `repo` for a private one (`repo` grants every private repository its owner can reach); its owner needs write access to the repository. The task stopped before the agent ran, so no work was lost. Token types and the permissions they need: agent/README.md, GitHub PAT — Minimal Permissions.';
const MSG_FINE = 'PushCapabilityError: Token cannot push to owner/repo: GitHub refused the fine-grained personal access token write access (remote: Permission to owner/repo.git denied to <token user>). To fix it, include the repository in the token\'s repository access and give it the Contents permission with Read and write access; its owner needs write access to the repository. The task stopped before the agent ran, so no work was lost. Token types and the permissions they need: agent/README.md, GitHub PAT — Minimal Permissions.';
const MSG_APP = 'PushCapabilityError: Token cannot push to owner/repo: GitHub refused the GitHub App token write access (remote: Permission to owner/repo.git denied to <token user>). To fix it, give the app the Contents permission with Read and write access and install it on the repository. The task stopped before the agent ran, so no work was lost. Token types and the permissions they need: agent/README.md, GitHub PAT — Minimal Permissions.';
const MSG_UNKNOWN = 'PushCapabilityError: Token cannot push to owner/repo: GitHub refused the GitHub token write access (remote: Permission to owner/repo.git denied to <token user>). To fix it, for a fine-grained personal access token, include the repository in the token\'s repository access and give it the Contents permission with Read and write access; for a classic one, give the token the `public_repo` scope for a public repository, or `repo` for a private one (`repo` grants every private repository its owner can reach); either way, its owner needs write access to the repository. The task stopped before the agent ran, so no work was lost. Token types and the permissions they need: agent/README.md, GitHub PAT — Minimal Permissions.';
const MSG_LONGEST = 'PushCapabilityError: Token cannot push to ooooooooooooooooooooooooooooooooooooooo/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr: GitHub refused the GitHub token write access (remote: Permission to ooooooooooooooooooooooooooooooooooooooo/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr.git denied to <token user> xxxxxxxxxx). To fix it, for a fine-grained personal access token, include the repository in the token\'s repository access and give it the Contents permission with Read and write access; for a classic one, give the token the `public_repo` scope for a public repository, or `repo` for a private one (`repo` grants every private repository its owner can reach); either way, its owner needs write access to the repository. The task stopped before the agent ran, so no work was lost. Token types and the permissions they need: agent/README.md, GitHub PAT — Minimal Permissions.';
const MSG_DOTTED = 'PushCapabilityError: Token cannot push to owner/my.repo: GitHub refused the classic personal access token write access (remote: Permission to owner/my.repo.git denied to <token user>). To fix it, give the token the `public_repo` scope for a public repository, or `repo` for a private one (`repo` grants every private repository its owner can reach); its owner needs write access to the repository. The task stopped before the agent ran, so no work was lost. Token types and the permissions they need: agent/README.md, GitHub PAT — Minimal Permissions.';

describe('classifyError', () => {
  test('returns null for undefined', () => {
    expect(classifyError(undefined)).toBeNull();
  });

  test('returns null for null', () => {
    expect(classifyError(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(classifyError('')).toBeNull();
  });

  test.each([
    ['a number', 404],
    ['a boolean', true],
    ['a map', { message: 'Guardrail blocked' }],
  ])('a value that is not text has no classification: %s', (_kind, value) => {
    expect(classifyError(value as unknown as string)).toBeNull();
  });

  describe('auth errors', () => {
    test('classifies insufficient GitHub repo permissions (preflight)', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo.',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Insufficient GitHub permissions');
      expect(result!.retryable).toBe(false);
    });

    test('classifies repo not found or no access', () => {
      const result = classifyError(
        'Pre-flight check failed: REPO_NOT_FOUND_OR_NO_ACCESS — GitHub API returned HTTP 404 for owner/repo',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Repository not found or inaccessible');
      expect(result!.retryable).toBe(false);
    });

    test('classifies PR not found or closed', () => {
      const result = classifyError(
        'Pre-flight check failed: PR_NOT_FOUND_OR_CLOSED — PR #42 in owner/repo is closed, not open',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Pull request not found or closed');
      expect(result!.retryable).toBe(false);
    });

    test('classifies a pull request from a fork', () => {
      const result = classifyError(
        'Pre-flight check failed: PR_FROM_FORK — PR #42 in owner/repo comes from another repository (a fork): '
        + 'its branch is not in owner/repo, so it cannot be checked out or pushed to',
      )!;
      expect(result.category).toBe(ErrorCategory.AUTH);
      expect(result.title).toBe('Pull request from a fork');
      expect(result.retryable).toBe(false);
      expect(result.errorClass).toBe(ErrorClass.USER);
      expect(result.remedy).toContain('branch of the repository itself');
    });

    test('classifies token push scope error (detailed message)', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo. Required: push. For fine-grained PATs use Contents Read and write.',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.retryable).toBe(false);
    });

    test('classifies token PR scope error', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot interact with pull requests on owner/repo.',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.retryable).toBe(false);
    });

    test('classifies bare "Token cannot push to" without error code', () => {
      const result = classifyError('Token cannot push to owner/repo');
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Insufficient GitHub token scopes');
    });

    test.each([
      [
        'a token without write access',
        MSG_CLASSIC,
        ErrorCategory.AUTH,
        'Insufficient GitHub token scopes',
      ],
      [
        'a rejected credential',
        'PushCapabilityError: BLOCKED[auth_failure]: GitHub did not accept a token for the push (remote: Invalid username or token. Password authentication is not supported.): it is missing, invalid, expired or revoked. Replace the GitHub token secret, then resubmit. The task stopped before the agent ran, so no work was lost. (resource: owner/repo)',
        ErrorCategory.BLOCKED,
        'Blocked: authentication rejected',
      ],
      [
        'an archived repository',
        'PushCapabilityError: Repository owner/repo is archived on GitHub, so it is read-only (remote: This repository was archived so it is read-only.). Unarchive it or target another repository. The task stopped before the agent ran, so no work was lost.',
        ErrorCategory.CONFIG,
        'Repository is archived',
      ],
      [
        'SAML SSO enforcement',
        "PushCapabilityError: GitHub organization policy blocks pushes to owner/repo: it enforces SAML single sign-on and the token is not authorized for it. To fix it, authorize the classic token for the organization (GitHub > Settings > Developer settings > Personal access tokens > Tokens (classic) > Configure SSO) (remote: The 'acme' organization has enabled or enforced SAML SSO.). The task stopped before the agent ran, so no work was lost.",
        ErrorCategory.AUTH,
        'GitHub organization policy blocks the token',
      ],
      [
        'an IP allow list',
        "PushCapabilityError: GitHub organization policy blocks pushes to owner/repo: its IP allow list does not include the agent's address. To fix it, add the agent's egress IP addresses to the organization's IP allow list (remote: Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.). The task stopped before the agent ran, so no work was lost.",
        ErrorCategory.AUTH,
        'GitHub organization policy blocks the token',
      ],
    ])('classifies the agent push preflight refusal for %s (#801)', (_label, message, category, title) => {
      const result = classifyError(message);
      expect(result!.category).toBe(category);
      expect(result!.title).toBe(title);
      expect(result!.retryable).toBe(false);
    });

    test.each([
      ['a classic PAT', MSG_CLASSIC, 'owner/repo', ['`public_repo` scope for a public repository', '`repo` for a private one', 'its owner needs write access']],
      ['a fine-grained PAT', MSG_FINE, 'owner/repo', ['repository access', 'Contents permission with Read and write access']],
      ['a GitHub App token', MSG_APP, 'owner/repo', ['install it on the repository']],
      ['an unknown token type', MSG_UNKNOWN, 'owner/repo', ['For a fine-grained personal access token', 'for a classic one']],
      ['a repository with a dot in its name', MSG_DOTTED, 'owner/my.repo', ['its owner needs write access to the repository']],
      ['the longest refusal, as stored', MSG_LONGEST, 'ooooooooooooooooooooooooooooooooooooooo/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', ['For a fine-grained personal access token', 'for a classic one']],
    ])('carries the agent push preflight fix for %s (#801)', (_label, message, repo, fragments) => {
      const result = classifyError(message);
      expect(result!.title).toBe('Insufficient GitHub token scopes');
      expect(result!.description).toContain(repo);
      for (const fragment of fragments) {
        expect(result!.remedy).toContain(fragment);
      }
      expect(result!.remedy).toMatch(/Then resubmit\.$|Then resubmit\. /);
      expect(result!.remedy).not.toContain('Update the PAT with');
      expect(result!.retryable).toBe(false);
    });

    test('keeps the generic remedy for the orchestrator preflight message', () => {
      const result = classifyError('Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo. Required: push.');
      expect(result!.title).toBe('Insufficient GitHub permissions');
    });

    test('classifies bare "Token cannot interact with pull requests on" without error code', () => {
      const result = classifyError('Token cannot interact with pull requests on owner/repo');
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Insufficient GitHub token scopes');
    });

    test('classifies a 401 from GitHub as a rejected token, not as an unreachable API', () => {
      const result = classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — GitHub API returned HTTP 401',
      )!;
      expect(result.category).toBe(ErrorCategory.AUTH);
      expect(result.title).toBe('GitHub token rejected');
      expect(result.retryable).toBe(false);
      expect(result.errorClass).toBe(ErrorClass.SERVICE);
      expect(result.remedy).toContain('bgagent github set-token');
      expect(retryGuidance(result)).not.toMatch(/temporary infrastructure/i);
      expect(isTransientError(classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — GitHub API returned HTTP 503',
      ))).toBe(true);
    });
  });

  describe('network errors', () => {
    test('classifies GitHub unreachable', () => {
      const result = classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — connect ETIMEDOUT 140.82.121.6:443',
      );
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.title).toBe('GitHub API unreachable');
      expect(result!.retryable).toBe(true);
    });

    test('classifies GitHub API HTTP 5xx', () => {
      const result = classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — GitHub API returned HTTP 503',
      );
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.retryable).toBe(true);
    });

    test('classifies GitHub API HTTP 4xx in preflight detail', () => {
      const result = classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — GitHub API returned HTTP 403 for owner/repo',
      );
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.retryable).toBe(true);
    });

    test('classifies bare GitHub API HTTP status without GITHUB_UNREACHABLE', () => {
      const result = classifyError('GitHub API returned HTTP 502 during polling');
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.title).toBe('GitHub API error');
    });
  });

  describe('concurrency errors', () => {
    test('classifies user concurrency limit', () => {
      const result = classifyError('User concurrency limit reached');
      expect(result!.category).toBe(ErrorCategory.CONCURRENCY);
      expect(result!.title).toBe('Concurrency limit reached');
      expect(result!.retryable).toBe(true);
    });
  });

  describe('compute errors', () => {
    test('classifies session start failure', () => {
      const result = classifyError('Session start failed: ServiceQuotaExceededException');
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent session failed to start');
      expect(result!.retryable).toBe(true);
    });

    test('classifies ECS container failure', () => {
      const result = classifyError('ECS container failed: OutOfMemoryError');
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('ECS container failed');
      expect(result!.retryable).toBe(true);
    });

    test('classifies claude Exec-format / broken-shim as a transient image issue, not "Unexpected error"', () => {
      const result = classifyError(
        "Workflow run_agent step failed: OSError: [Errno 8] Exec format error: 'claude'",
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Couldn\'t start the coding agent (environment issue)');
      expect(result!.retryable).toBe(true);
      expect(result!.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(result!.remedy).toMatch(/try again|rebuild|admin/i);
    });

    test('classifies the claude shim self-report ("native binary not installed")', () => {
      const result = classifyError('Error: claude native binary not installed.');
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.errorClass).toBe(ErrorClass.TRANSIENT);
    });

    test('classifies ECS exit without terminal status', () => {
      const result = classifyError(
        'ECS task exited successfully but agent never wrote terminal status after 5 polls',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent exited without reporting status');
      expect(result!.retryable).toBe(true);
    });

    test('classifies ECS poll failures', () => {
      const result = classifyError(
        'ECS poll failed 3 consecutive times: AccessDeniedException',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('ECS polling failure');
      expect(result!.retryable).toBe(true);
    });

    test('classifies session never started (HYDRATING timeout)', () => {
      const result = classifyError(
        'Session never started — poll timeout exceeded while still HYDRATING',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent session never started');
      expect(result!.retryable).toBe(true);
    });

    const stranded = (status: string) =>
      `Stranded: ${status} for 1260s — no pipeline attached before the stranded-task timeout. `
      + 'This usually means the orchestrator Lambda crashed before invoking '
      + 'the runtime, or the agent container crashed during startup.';
    const approvalStranded = 'Approval stranded: task paused for approval for 7300s with '
      + 'no resume transition. Typically caused by the agent container being '
      + 'evicted mid-approval. Resubmit the task if the work is still needed.';

    test.each([
      { status: 'SUBMITTED', message: stranded('SUBMITTED') },
      { status: 'HYDRATING', message: stranded('HYDRATING') },
      { status: 'AWAITING_APPROVAL', message: approvalStranded },
    ])('classifies a task found stranded in $status as a retryable platform fault', ({ message }) => {
      const result = classifyError(message)!;
      expect(result.category).toBe(ErrorCategory.COMPUTE);
      expect(result.title).toBe('The platform lost track of this task');
      expect(result.retryable).toBe(true);
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(retryGuidance(result)).toMatch(/reply here to try again/i);
    });

    test('classifies agent heartbeat loss', () => {
      const result = classifyError(
        'Agent session lost: no recent heartbeat from the runtime (container may have crashed, been OOM-killed, or stopped)',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent session lost');
      expect(result!.retryable).toBe(true);
    });
  });

  describe('agent errors', () => {
    test('classifies SDK stream ended without ResultMessage', () => {
      const result = classifyError(
        'Agent SDK stream ended without a ResultMessage (agent_status=unknown). Treat as failure: possible SDK bug, network interruption, or protocol mismatch.',
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toBe('Agent SDK stream ended unexpectedly');
      expect(result!.retryable).toBe(true);
    });

    test('classifies SDK stream ended with chained error', () => {
      const result = classifyError(
        'some prior error; Agent SDK stream ended without a ResultMessage (agent_status=unknown). Treat as failure.',
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.retryable).toBe(true);
    });

    test('classifies task did not succeed', () => {
      const result = classifyError(
        "Task did not succeed (agent_status='error', build_ok=False)",
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toBe('Agent task did not succeed');
      expect(result!.retryable).toBe(false);
    });

    test.each(['success', 'end_turn'])(
      'a red build after agent_status=%s is a retryable build failure, not "the agent reported a non-success status"',
      (agentStatus) => {
        const result = classifyError(`Task did not succeed (agent_status='${agentStatus}', build_ok=False)`)!;
        expect(result.category).toBe(ErrorCategory.AGENT);
        expect(result.title).toBe('Build or tests did not pass');
        expect(result.description).not.toMatch(/non-success status/i);
        expect(result.retryable).toBe(true);
        expect(result.errorClass).toBe(ErrorClass.USER);
        expect(retryGuidance(result)).toMatch(/extra guidance/i);
      },
    );

    test('a build gate that timed out reads as "didn\'t finish in time", not as a red build', () => {
      const result = classifyError("Task did not succeed (agent_status='success', build_ok=timeout)")!;
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
      expect(result.title).toMatch(/build\/tests didn't finish in time/i);
      expect(result.title).not.toMatch(/did not pass/i);
      expect(result.retryable).toBe(true);
      expect(result.errorClass).toBe(ErrorClass.USER);
      expect(retryGuidance(result)).toMatch(/extra guidance/i);
    });

    test('build_ok=infra is a retryable COMPUTE fault, not "did not succeed"/build-failed', () => {
      const result = classifyError(
        "Task did not succeed (agent_status='success', build_ok=infra)",
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toMatch(/ran out of resources/i);
      expect(result!.retryable).toBe(true);
      expect(result!.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(result!.remedy).toMatch(/try again|capacity|admin/i);
    });

    const deliveredNothing = 'Task did not succeed (agent_status=success, deliverable=lost): the coding '
      + 'task reported success but no commit reached the branch and no PR was opened — ';

    test.each([
      {
        writer: 'an earlier agent image',
        message: `${deliveredNothing}the agent's changes did not land in the task's repository.`,
      },
      {
        writer: 'the agent',
        message: `${deliveredNothing}either the agent made no change, or its changes did not land in the task's repository.`,
      },
    ])('deliverable=lost, as $writer words it, names both lost work and a run that changed nothing', ({ message }) => {
      const result = classifyError(message)!;
      expect(result.category).toBe(ErrorCategory.AGENT);
      expect(result.title).toBe('No change was delivered');
      expect(result.description).toMatch(/nothing to change/i);
      expect(result.description).toMatch(/lost/i);
      expect(result.remedy).toMatch(/already has what you asked for/i);
      expect(result.remedy).toMatch(/try again/i);
      expect(`${result.description} ${result.remedy}`).not.toMatch(/transient/i);
      expect(result.retryable).toBe(true);
      expect(result.errorClass).toBe(ErrorClass.USER);
      expect(isTransientError(result)).toBe(false);
      expect(retryGuidance(result)).toMatch(/extra guidance/i);
      expect(retryGuidance(result)).not.toMatch(/temporary infrastructure/i);
    });

    test('deliverable=no_pr says the work is SAFE on the branch (the pull request just did not open)', () => {
      const result = classifyError(
        'Task did not succeed (agent_status=success, deliverable=no_pr): a commit '
        + 'reached the branch but no PR was opened — the change is on the branch but '
        + 'was not delivered.',
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toMatch(/pull request did not open/i);
      expect(result!.retryable).toBe(true);
      expect(result!.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(result!.description).toMatch(/safe on the branch/i);
    });

    test('classifies error_max_turns as TIMEOUT with specific title (ordered before generic catch-all)', () => {
      const result = classifyError(
        "Task did not succeed (agent_status='error_max_turns', build_ok=False)",
      );
      expect(result!.category).toBe(ErrorCategory.TIMEOUT);
      expect(result!.title).toBe('Exceeded max turns');
      expect(result!.retryable).toBe(true);
      expect(result!.remedy).toMatch(/--max-turns/);
    });

    test('max_turns with an observed repeated failure stays "Exceeded max turns" and makes NO causal claim', () => {
      const result = classifyError(
        "Agent session error (subtype='error_max_turns') — last tool calls repeated: "
        + '`git push --force-with-lease` — remote: invalid credentials fatal: exit 128',
      );
      expect(result!.category).toBe(ErrorCategory.TIMEOUT);
      expect(result!.title).toBe('Exceeded max turns');
      expect(result!.retryable).toBe(true);
      expect(result!.title).not.toMatch(/retrying a failing step/i);
      expect(result!.remedy).toMatch(/detail/i);
      expect(result!.remedy).toMatch(/environment|auth|credentials/i);
    });

    test('classifies error_max_budget_usd as TIMEOUT with specific title', () => {
      const result = classifyError(
        "Task did not succeed (agent_status='error_max_budget_usd', build_ok=False)",
      );
      expect(result!.category).toBe(ErrorCategory.TIMEOUT);
      expect(result!.title).toBe('Exceeded max budget');
      expect(result!.retryable).toBe(true);
      expect(result!.remedy).toMatch(/--max-budget/);
    });

    test('classifies error_during_execution with a mid-turn-error title', () => {
      const result = classifyError(
        "Task did not succeed (agent_status='error_during_execution', build_ok=False)",
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toBe('Agent errored during execution');
      expect(result!.retryable).toBe(true);
    });

    test('classifies the runner.py "Agent session error (subtype=...)" wrapper, not just agent_status=', () => {
      const turns = classifyError("Agent session error (subtype='error_max_turns')");
      expect(turns!.title).toBe('Exceeded max turns');
      expect(turns!.category).toBe(ErrorCategory.TIMEOUT);

      const budget = classifyError("Agent session error (subtype='error_max_budget_usd')");
      expect(budget!.title).toBe('Exceeded max budget');

      const exec = classifyError("Agent session error (subtype='error_during_execution')");
      expect(exec!.title).toBe('Agent errored during execution');
    });

    test('matches agent_status with or without quotes around the literal', () => {
      const quoted = classifyError("Task did not succeed (agent_status='error_max_turns', build_ok=False)");
      const unquoted = classifyError('Task did not succeed (agent_status=error_max_turns, build_ok=False)');
      expect(quoted!.title).toBe('Exceeded max turns');
      expect(unquoted!.title).toBe('Exceeded max turns');
    });

    test('classifies receive_response failure', () => {
      const result = classifyError(
        'receive_response() failed: Connection reset by peer',
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toBe('Agent communication failure');
      expect(result!.retryable).toBe(true);
    });
  });

  describe('guardrail errors', () => {
    test('classifies guardrail blocked during hydration', () => {
      const result = classifyError(
        'Hydration failed: Error: Guardrail blocked: CONTENT_POLICY_VIOLATION',
      );
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
      expect(result!.title).toBe('Content blocked by guardrail');
      expect(result!.retryable).toBe(false);
    });

    test('classifies direct guardrail blocked message', () => {
      const result = classifyError('Guardrail blocked: prompt injection detected');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
      expect(result!.retryable).toBe(false);
    });

    test('classifies content policy at submission', () => {
      const result = classifyError('Task description was blocked by content policy.');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
      expect(result!.title).toBe('Content policy violation');
      expect(result!.retryable).toBe(false);
    });
  });

  describe('config errors', () => {
    test('classifies Bedrock model not available on deployment', () => {
      const result = classifyError(
        'The model us.anthropic.claude-sonnet-4-6 is not available on your bedrock deployment. Try --model to switch',
      );
      expect(result!.category).toBe(ErrorCategory.CONFIG);
      expect(result!.title).toBe('Bedrock model not available in this account or Region');
      expect(result!.retryable).toBe(false);
    });

    test('classifies blueprint config load failure', () => {
      const result = classifyError(
        'Blueprint config load failed: ResourceNotFoundException: Requested resource not found',
      );
      expect(result!.category).toBe(ErrorCategory.CONFIG);
      expect(result!.title).toBe('Blueprint configuration error');
      expect(result!.retryable).toBe(true);
    });

    test.each([
      {
        where: 'the pin is refused when the blueprint loads',
        message: "Blueprint config load failed: Error: Repository compute_type 'ecs' is not deployed; "
          + "this stack deploys only 'agentcore'. Update the repository configuration before submitting tasks.",
      },
      {
        where: 'the MicroVM strategy has no image to run',
        message: 'Session start failed: Error: This repository is configured compute_type=lambda-microvm, but this stack was deployed without the '
          + 'Lambda MicroVMs substrate (missing MICROVM_IMAGE_IDENTIFIER/MICROVM_EXECUTION_ROLE_ARN/'
          + 'MICROVM_EGRESS_CONNECTOR_ARNS/MICROVM_PAYLOAD_BUCKET). Redeploy the stack with '
          + '`--context compute_type=lambda-microvm` to provision the MicroVM substrate, or set this repo to '
          + 'compute_type=agentcore (bgagent repo onboard <repo> --compute-type agentcore).',
      },
      {
        where: 'the ECS strategy has no cluster to run on',
        message: 'Session start failed: Error: This repository is configured compute_type=ecs, but this stack was deployed without the ECS '
          + 'substrate (missing ECS_CLUSTER_ARN/ECS_TASK_DEFINITION_ARN/ECS_SUBNETS/ECS_SECURITY_GROUP). '
          + 'Redeploy the stack with `--context compute_type=ecs` to provision the Fargate substrate, or '
          + 'set this repo to compute_type=agentcore (bgagent repo onboard <repo> --compute-type agentcore).',
      },
    ])('classifies a backend the stack does not deploy as a non-retryable config fault ($where)', ({ message }) => {
      const result = classifyError(message)!;
      expect(result.category).toBe(ErrorCategory.CONFIG);
      expect(result.title).toBe('The repository\'s compute backend is not deployed in this stack');
      expect(result.retryable).toBe(false);
      expect(result.errorClass).toBe(ErrorClass.SERVICE);
      expect(result.remedy).not.toMatch(/AgentCore Runtime or ECS cluster health|RepoTable/);
      expect(retryGuidance(result)).not.toMatch(/temporary infrastructure/i);
    });

    test('classifies hydration failure (non-guardrail)', () => {
      const result = classifyError(
        'Hydration failed: Error: Failed to fetch issue body',
      );
      expect(result!.category).toBe(ErrorCategory.CONFIG);
      expect(result!.title).toBe('Context hydration failed');
      expect(result!.retryable).toBe(true);
    });

    test('does not classify hydration + guardrail as config', () => {
      const result = classifyError('Hydration failed: Error: Guardrail blocked: xyz');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
    });
  });

  describe('timeout errors', () => {
    test('classifies orchestrator poll timeout', () => {
      const result = classifyError('Orchestrator poll timeout exceeded');
      expect(result!.category).toBe(ErrorCategory.TIMEOUT);
      expect(result!.title).toBe('Task timed out');
      expect(result!.retryable).toBe(false);
    });

    test.each([
      'Orchestrator poll timeout exceeded',
      'Orchestrator poll timeout exceeded while awaiting approval',
      'Task execution limit reached while waiting for approval. The task has closed; submit a new task to continue.',
    ])('does not answer "%s" with "temporary infrastructure issue, reply to retry"', (message) => {
      const result = classifyError(message)!;
      expect(result.retryable).toBe(false);
      expect(result.errorClass).toBe(ErrorClass.USER);
      expect(retryGuidance(result)).toMatch(/may not resolve this/i);
      expect(retryGuidance(result)).not.toMatch(/temporary infrastructure/i);
    });

    test.each([
      {
        command: 'gh repo clone',
        message: "TimeoutExpired: Command '['gh', 'repo', 'clone', '--no-upstream', 'acme/monorepo', '/workspace/01KX']' timed out after 600 seconds",
      },
      {
        command: 'mise install',
        message: "TimeoutExpired: Command '['mise', 'install']' timed out after 600 seconds",
      },
      {
        command: 'git push',
        message: "TimeoutExpired: Command '['git', 'push', '-u', 'origin', 'bgagent/01KX/fix']' timed out after 600 seconds",
      },
    ])('classifies an uncaught $command TIMEOUT distinctly from a crash, and not as a slow build', ({ message }) => {
      const result = classifyError(message);
      expect(result!.category).toBe(ErrorCategory.TIMEOUT);
      expect(result!.title).toMatch(/didn't finish in time|timed out/i);
      expect(result!.retryable).toBe(true);
      expect(result!.errorClass).toBe(ErrorClass.USER);
      expect(result!.title).not.toMatch(/Unexpected error/i);
      expect(`${result!.title} ${result!.description} ${result!.remedy}`).not.toMatch(/build|tests/i);
    });
  });

  describe('Lambda MicroVMs errors', () => {
    test('an unknown start requires investigation even when its detail describes a transient failure', () => {
      const result = classifyError(
        'Session start failed: MICROVM_START_OUTCOME_UNKNOWN: MicroVM RunMicrovm failed: TimeoutError: response lost [auto-retried]',
      )!;
      expect(result.retryable).toBe(false);
      expect(result.errorClass).toBe(ErrorClass.SERVICE);
      expect(retryGuidance(result, true)).toMatch(/needs your ABCA admin/);
      expect(result.remedy).toMatch(/before submitting another task/);
    });

    test('classifies regional unavailability as a non-retryable CONFIG fault with the supported-Region list', () => {
      const result = classifyError(
        'Session start failed: UnknownEndpoint: Inaccessible host: `lambda.eu-central-1.amazonaws.com\'. '
        + 'This service may not be available in the `eu-central-1\' region.',
      )!;
      expect(result.category).toBe(ErrorCategory.CONFIG);
      expect(result.title).toBe('Lambda MicroVMs is not available in this Region');
      expect(result.retryable).toBe(false);
      expect(result.errorClass).toBe(ErrorClass.SERVICE);
      expect(isTransientError(result)).toBe(false);
      for (const region of LAMBDA_MICROVM_SUPPORTED_REGIONS) {
        expect(result.remedy).toContain(region);
      }
      expect(result.remedy).toContain('--compute-type agentcore');
      expect(result.remedy).toContain('contracts/deployment-capabilities.json');
    });

    test('classifies regional unavailability from the raw (unwrapped) SDK error too', () => {
      const result = classifyError('Could not resolve endpoint for lambda in region ap-south-1')!;
      expect(result.title).toBe('Lambda MicroVMs is not available in this Region');
      expect(isTransientError(result)).toBe(false);
    });

    test('regional unavailability wins over the generic "Session start failed" copy (ordering)', () => {
      const generic = classifyError('Session start failed: boom')!;
      expect(generic.title).toBe('Agent session failed to start');
      const regional = classifyError('Session start failed: MicroVMs not available in this region')!;
      expect(regional.title).toBe('Lambda MicroVMs is not available in this Region');
    });

    test('does NOT hijack an AgentCore or ECS endpoint failure (marker-anchored pattern)', () => {
      const agentcore = classifyError(
        'Session start failed: UnknownEndpoint: Inaccessible host: `bedrock-agentcore.us-east-1.amazonaws.com\'.',
      )!;
      expect(agentcore.title).toBe('Agent session failed to start');
      const ecs = classifyError(
        'Session start failed: UnknownEndpoint: Inaccessible host: `ecs.us-east-1.amazonaws.com\'.',
      )!;
      expect(ecs.title).toBe('Agent session failed to start');
    });

    test('classifies ServiceQuotaExceededException as a retryable capacity fault', () => {
      const result = classifyError(
        'Session start failed: Error: MicroVM RunMicrovm failed: ServiceQuotaExceededException: MicroVM memory quota exceeded',
      )!;
      expect(result.category).toBe(ErrorCategory.COMPUTE);
      expect(result.retryable).toBe(true);
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(isTransientError(result)).toBe(true);
      expect(result.remedy).toMatch(/quota increase/i);
    });

    test('classifies ThrottlingException as retryable/transient', () => {
      const result = classifyError('MicroVM RunMicrovm failed: ThrottlingException: Rate exceeded')!;
      expect(result.category).toBe(ErrorCategory.COMPUTE);
      expect(result.retryable).toBe(true);
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(isTransientError(result)).toBe(true);
    });

    test('classifies TooManyRequestsException alongside ThrottlingException', () => {
      const result = classifyError('MicroVM GetMicrovm failed: TooManyRequestsException: slow down')!;
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
    });

    test('classifies a marked ResourceNotFoundException as a non-retryable deploy fault', () => {
      const result = classifyError('MicroVM RunMicrovm failed: ResourceNotFoundException: MicroVM image not found')!;
      expect(result.category).toBe(ErrorCategory.CONFIG);
      expect(result.retryable).toBe(false);
      expect(result.errorClass).toBe(ErrorClass.SERVICE);
      expect(isTransientError(result)).toBe(false);
      expect(result.remedy).toContain('MICROVM_IMAGE_IDENTIFIER');
    });

    test('classifies a marked payload-upload failure', () => {
      const result = classifyError('MicroVM payload upload failed: ThrottlingException: SlowDown')!;
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
    });

    test('classifies a MicroVM substrate-failure reason written by the orchestrator', () => {
      const result = classifyError(
        'MicroVM substrate terminated before the agent wrote a terminal status: substrate state completed',
      )!;
      expect(result.category).toBe(ErrorCategory.COMPUTE);
      expect(result.retryable).toBe(true);
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(result.title).not.toMatch(/Unexpected error/i);
    });

    // The service's `stateReason`, verbatim (docs/verification/645-p2-smoke-runbook.md §6.1).
    const hookReason = (status: number) =>
      `Run lifecycle hook returned HTTP status ${status}. `
      + 'Please check your hook endpoint and application logs for more details.';
    const reconciled = (reason: string) =>
      'MicroVM substrate terminated before the agent wrote a terminal status: '
      + `substrate state completed (${reason})`;

    test.each([
      'Resume lifecycle hook failed. Please check your hook endpoint and application logs for more details.',
      'Resume lifecycle hook connection was refused. Please check your hook endpoint and application logs for more details.',
      'Resume lifecycle hook timed out. Please check your hook endpoint and application logs for more details.',
      'Resume lifecycle hook returned HTTP status 503.',
      'Resume lifecycle hook returned HTTP status 409.',
    ])('gives actionable wake diagnostics for %s', reason => {
      const persisted = formatMicrovmTerminalFailure('substrate state completed', reason);
      expect(persisted).toMatch(/^MICROVM_RESUME_HOOK_FAILED: /);
      expect(persisted).toContain(reason);
      for (const message of [persisted, reconciled(reason), reason]) {
        const result = classifyError(message)!;
        expect(result.title).toBe('The MicroVM could not wake after being paused');
        expect(result.errorClass).toBe(ErrorClass.SERVICE);
        expect(result.retryable).toBe(false);
        expect(result.remedy).toContain('AWS request ID');
        expect(result.remedy).toContain('before starting a replacement');
        expect(retryGuidance(result)).toMatch(/needs your ABCA admin/i);
      }
    });

    test('keeps unknown wording generic and honors persisted codes ahead of diagnostic words', () => {
      expect(formatMicrovmTerminalFailure('completed', 'diagnostic: Resume lifecycle hook connection was refused.'))
        .toMatch(/^MICROVM_SUBSTRATE_TERMINATED: /);
      expect(classifyError(`MICROVM_SUBSTRATE_TERMINATED: ${reconciled('Resume lifecycle hook connection was refused.')}`)!.errorClass)
        .toBe(ErrorClass.TRANSIENT);
      expect(classifyError('MICROVM_RESUME_HOOK_FAILED: concurrency limit; missing_secret')!.errorClass)
        .toBe(ErrorClass.SERVICE);
    });

    test.each([
      'MicroVM host unavailable.',
      'MicroVM capacity unavailable in this Availability Zone.',
      'MicroVM host unavailable in this region.',
    ])('does not mistake "%s" for an unsupported region', (reason) => {
      for (const message of [reason, reconciled(reason)]) {
        const result = classifyError(message)!;
        expect(result.category).toBe(ErrorCategory.COMPUTE);
        expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
        expect(result.retryable).toBe(true);
        expect(retryGuidance(result)).toMatch(/reply here to try again/i);
      }
    });

    test.each([
      'MicroVM host unavailable.',
      'MicroVM unavailable in this region.',
      'INSUFFICIENT_GITHUB_REPO_PERMISSIONS',
      'concurrency limit reached',
      'BLOCKED[missing_secret]: diagnostic text',
      'Run lifecycle hook returned HTTP status 400.',
    ])('a stable terminal code cannot be reclassified by diagnostic text: %s', (reason) => {
      const result = classifyError(`MICROVM_SUBSTRATE_TERMINATED: ${reconciled(reason)}`)!;
      expect(result.title).toBe('The MicroVM stopped before the agent reported a result');
      expect(result.category).toBe(ErrorCategory.COMPUTE);
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
    });

    test('a stable hook-rejection code keeps configuration guidance despite other diagnostic words', () => {
      const result = classifyError(
        `MICROVM_RUN_HOOK_REJECTED: ${reconciled('MicroVM host unavailable; concurrency limit')}`,
      )!;
      expect(result.category).toBe(ErrorCategory.CONFIG);
      expect(result.retryable).toBe(false);
      expect(retryGuidance(result)).toMatch(/needs your ABCA admin/i);
    });

    test.each(['AccessDeniedException', 'UnauthorizedException'])(
      'does not retry a marked %s when starting a MicroVM', (name) => {
        const result = classifyError(`Session start failed: MicroVM RunMicrovm failed: ${name}: denied`)!;
        expect(result.category).toBe(ErrorCategory.AUTH);
        expect(result.errorClass).toBe(ErrorClass.SERVICE);
        expect(result.retryable).toBe(false);
      },
    );

    test.each(['ValidationException', 'InvalidParameterValueException'])('does not retry MicroVM %s', (name) => {
      const result = classifyError(`Session start failed: MicroVM RunMicrovm failed: ${name}: invalid connector`)!;
      expect(result.category).toBe(ErrorCategory.CONFIG);
      expect(result.errorClass).toBe(ErrorClass.SERVICE);
      expect(result.retryable).toBe(false);
    });

    test.each([400, 403, 404, 422, 499])(
      'classifies a lifecycle-hook %i as a NON-retryable config fault',
      (status) => {
        const result = classifyError(reconciled(hookReason(status)))!;
        expect(classifyError(hookReason(status))).toEqual(result);
        expect(result.category).toBe(ErrorCategory.CONFIG);
        expect(result.retryable).toBe(false);
        expect(result.errorClass).toBe(ErrorClass.SERVICE);
        expect(result.title).toMatch(/rejected its own run payload/i);
        // The service does not put the hook's response body in `stateReason` (645-p2-smoke-runbook.md §6.1).
        expect(result.remedy).toMatch(/log group/i);
      },
    );

    test('a lifecycle-hook 5xx stays RETRYABLE — MICROVM_RUN_PAYLOAD_UNREADABLE is a 500', () => {
      const result = classifyError(reconciled(hookReason(500)))!;
      expect(result.category).toBe(ErrorCategory.COMPUTE);
      expect(result.retryable).toBe(true);
      expect(result.errorClass).toBe(ErrorClass.TRANSIENT);
    });

    test('a terminal MicroVM with NO hook status keeps the generic retryable entry', () => {
      const result = classifyError(
        'MicroVM substrate terminated before the agent wrote a terminal status: substrate state completed',
      )!;
      expect(result.title).toMatch(/stopped before the agent reported a result/i);
      expect(result.retryable).toBe(true);
    });

    test.each(['substrate-read-failed', 'substrate-read-failed-repeatedly'])(
      'gives operator guidance for supervisor %s without promising cleanup succeeded', (reason) => {
        const result = classifyError(`MicroVM supervisor: ${reason}`)!;
        expect(result).toMatchObject({
          category: ErrorCategory.COMPUTE,
          title: 'The MicroVM status could not be checked',
          retryable: false,
          errorClass: ErrorClass.SERVICE,
        });
        expect(result.remedy).toContain('microvm_supervisor_request_failed');
        expect(result.remedy).toContain('AWS request ID');
        expect(result.remedy).toContain('Confirm worker termination');
      },
    );

    test.each([
      'AgentCore supervisor: substrate-read-failed',
      'Agent output mentions MicroVM supervisor: substrate-read-failed',
      'MicroVM supervisor: substrate-read-failed-unrecognized',
    ])('does not infer a supervisor failure from unrelated text: %s', (message) => {
      expect(classifyError(message)!.category).toBe(ErrorCategory.UNKNOWN);
    });

    test('a persisted terminal code still takes precedence over supervisor wording', () => {
      const result = classifyError('MICROVM_SUBSTRATE_TERMINATED: MicroVM supervisor: substrate-read-failed')!;
      expect(result.title).toBe('The MicroVM stopped before the agent reported a result');
      expect(result.retryable).toBe(true);
    });

    test('every new MicroVM classification carries a full, non-empty guidance shape', () => {
      const messages = [
        'Session start failed: UnknownEndpoint: Inaccessible host: `lambda.eu-central-1.amazonaws.com\'',
        'MicroVM RunMicrovm failed: ServiceQuotaExceededException: quota exceeded',
        'MicroVM RunMicrovm failed: ThrottlingException: Rate exceeded',
        'MicroVM RunMicrovm failed: ResourceNotFoundException: image not found',
        'MicroVM substrate terminated before the agent wrote a terminal status: substrate state completed',
        'MicroVM supervisor: substrate-read-failed',
        reconciled(hookReason(400)),
      ];
      for (const msg of messages) {
        const result = classifyError(msg) as ErrorClassification;
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.description.length).toBeGreaterThan(0);
        expect(result.remedy.length).toBeGreaterThan(0);
        expect(typeof result.retryable).toBe('boolean');
        expect([ErrorClass.TRANSIENT, ErrorClass.SERVICE, ErrorClass.USER]).toContain(result.errorClass);
        expect(result.category).not.toBe(ErrorCategory.UNKNOWN);
      }
    });
  });

  describe('MicroVM exception patterns must NOT change other backends', () => {
    const PRE_CHANGE_UNKNOWN = {
      category: ErrorCategory.UNKNOWN,
      title: 'Unexpected error',
      retryable: false,
      errorClass: ErrorClass.USER,
    };

    test.each([
      ['ThrottlingException: Rate exceeded'],
      ['ServiceQuotaExceededException: quota exceeded'],
      ['ResourceNotFoundException: Requested resource not found'],
      ['TooManyRequestsException: slow down'],
      ['AccessDeniedException: denied'],
      ['UnauthorizedException: denied'],
      ['ValidationException: invalid'],
    ])('an unmarked "%s" still classifies as UNKNOWN, exactly as before', (message) => {
      const result = classifyError(message)!;
      expect(result.category).toBe(PRE_CHANGE_UNKNOWN.category);
      expect(result.title).toBe(PRE_CHANGE_UNKNOWN.title);
      expect(result.retryable).toBe(PRE_CHANGE_UNKNOWN.retryable);
      expect(result.errorClass).toBe(PRE_CHANGE_UNKNOWN.errorClass);
      expect(isTransientError(result)).toBe(false);
    });

    test('an AgentCore StopRuntimeSession throttle is not re-classified as a MicroVM fault', () => {
      const result = classifyError(
        'ThrottlingException: Too many requests for agentRuntimeArn arn:aws:bedrock-agentcore:us-east-1:1:runtime/r',
      )!;
      expect(result.title).toBe('Unexpected error');
      expect(result.title).not.toMatch(/MicroVM/i);
    });

    test('an ECS RunTask quota error is not re-classified as a MicroVM fault', () => {
      const result = classifyError(
        'ECS RunTask returned no task: arn:test: ServiceQuotaExceededException',
      )!;
      expect(result.title).not.toMatch(/MicroVM/i);
      expect(result.category).toBe(ErrorCategory.UNKNOWN);
    });

    test('the generic "Session start failed" wrapper still wins for agentcore/ECS quota + throttle', () => {
      expect(classifyError('Session start failed: ServiceQuotaExceededException')!.title)
        .toBe('Agent session failed to start');
      expect(classifyError('Session start failed: ThrottlingException: Rate exceeded')!.title)
        .toBe('Agent session failed to start');
      expect(classifyError('Session start failed: ResourceNotFoundException')!.title)
        .toBe('Agent session failed to start');
    });

    test('Blueprint / hydration ResourceNotFoundException keep their precise CONFIG copy', () => {
      expect(
        classifyError('Blueprint config load failed: ResourceNotFoundException: Requested resource not found')!.title,
      ).toBe('Blueprint configuration error');
      expect(
        classifyError('Hydration failed: ResourceNotFoundException: secret missing')!.title,
      ).toBe('Context hydration failed');
    });
  });

  describe('blocker errors (canonical BLOCKED[<kind>] prefix)', () => {
    test('classifies missing_secret and extracts the secret name', () => {
      const result = classifyError('BLOCKED[missing_secret]: required secret not wired (resource: OPENAI_API_KEY)');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: missing secret');
      expect(result!.remedy).toContain('OPENAI_API_KEY');
      expect(result!.retryable).toBe(false);
    });

    test('classifies egress_denied and names the host to allowlist', () => {
      const result = classifyError('BLOCKED[egress_denied]: connection refused (resource: registry.npmjs.org)');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: egress denied');
      expect(result!.remedy).toContain('registry.npmjs.org');
      expect(result!.retryable).toBe(false);
    });

    test('classifies dependency_unreachable as retryable', () => {
      const result = classifyError('BLOCKED[dependency_unreachable]: pypi timed out (resource: pypi.org)');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.retryable).toBe(true);
    });

    test('classifies policy_fail_closed distinctly from a hard-deny', () => {
      const result = classifyError('BLOCKED[policy_fail_closed]: Cedar engine unavailable');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: policy engine fail-closed');
      expect(result!.retryable).toBe(false);
    });

    test('handles a blocker reason without a resource suffix', () => {
      const result = classifyError('BLOCKED[missing_secret]: a required secret was not wired');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: missing secret');
    });

    test('classifies auth_failure (runtime credential rejection → scope advice)', () => {
      const result = classifyError('BLOCKED[auth_failure]: credential rejected (resource: github.com)');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: authentication rejected');
      expect(result!.retryable).toBe(false);
      expect(result!.remedy).toContain('scopes');
    });

    test('auth_failure with a Secrets Manager ARN gives IAM remedy, not PAT scopes', () => {
      const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-token-abc';
      const result = classifyError(`BLOCKED[auth_failure]: the required GitHub token secret could not be read (resource: ${arn})`);
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: authentication rejected');
      expect(result!.retryable).toBe(false);
      expect(result!.remedy).toContain('secretsmanager:GetSecretValue');
      expect(result!.remedy).not.toContain('scopes');
    });

    test('falls back to environmental for an unknown kind', () => {
      const result = classifyError('BLOCKED[unknown_environmental]: something odd happened');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: environmental fault');
    });

    test('classifies a BLOCKED prefix appearing mid-message (agent carry-path)', () => {
      const result = classifyError('Task failed: BLOCKED[egress_denied]: refused (resource: api.example.com)');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.remedy).toContain('api.example.com');
    });

    test('extracts resource when the reason is wrapped with trailing text', () => {
      const result = classifyError('BLOCKED[egress_denied]: refused (resource: api.example.com) at step 3');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.remedy).toContain('api.example.com');
    });

    test('extracts resource when a stack trace follows on a new line', () => {
      const result = classifyError(
        'BLOCKED[missing_secret]: not wired (resource: OPENAI_API_KEY)\n  at foo (bar.py:12)',
      );
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.remedy).toContain('OPENAI_API_KEY');
    });

    test('routes a mixed-case kind to the right remedy (case-insensitive)', () => {
      const result = classifyError('BLOCKED[Egress_Denied]: refused (resource: host.com)');
      expect(result!.category).toBe(ErrorCategory.BLOCKED);
      expect(result!.title).toBe('Blocked: egress denied');
    });
  });

  describe('unknown errors', () => {
    test('classifies unrecognized error as unknown', () => {
      const result = classifyError('Something completely unexpected happened');
      expect(result!.category).toBe(ErrorCategory.UNKNOWN);
      expect(result!.title).toBe('Unexpected error');
      expect(result!.retryable).toBe(false);
    });

    test('classifies raw Python exception from agent as unknown', () => {
      const result = classifyError('ValueError: invalid literal for int()');
      expect(result!.category).toBe(ErrorCategory.UNKNOWN);
    });
  });

  describe('classification shape', () => {
    test('every classification has all required fields', () => {
      const messages = [
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo',
        'Pre-flight check failed: GITHUB_UNREACHABLE — timeout',
        'User concurrency limit reached',
        'Session start failed: boom',
        'Agent SDK stream ended without a ResultMessage (agent_status=unknown).',
        'Guardrail blocked: nope',
        'Blueprint config load failed: boom',
        'The model us.anthropic.claude-sonnet-4-6 is not available on your bedrock deployment.',
        'Orchestrator poll timeout exceeded',
        'mystery error',
      ];

      for (const msg of messages) {
        const result = classifyError(msg) as ErrorClassification;
        expect(result).toBeDefined();
        expect(typeof result.category).toBe('string');
        expect(typeof result.title).toBe('string');
        expect(typeof result.description).toBe('string');
        expect(typeof result.remedy).toBe('string');
        expect(typeof result.retryable).toBe('boolean');
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.description.length).toBeGreaterThan(0);
        expect(result.remedy.length).toBeGreaterThan(0);
        expect([ErrorClass.TRANSIENT, ErrorClass.SERVICE, ErrorClass.USER]).toContain(result.errorClass);
      }
    });
  });

  describe('errorClass axis + retryGuidance', () => {
    test('the ECS deploy-race is TRANSIENT and isTransientError is true', () => {
      const c = classifyError('Session start failed: InvalidParameterException: TaskDefinition is inactive')!;
      expect(c.errorClass).toBe(ErrorClass.TRANSIENT);
      expect(isTransientError(c)).toBe(true);
    });

    test('a generic session-start failure is TRANSIENT (compute infra)', () => {
      expect(classifyError('Session start failed: boom')!.errorClass).toBe(ErrorClass.TRANSIENT);
    });

    test('auth/permission is SERVICE (admin fixes it), not transient', () => {
      const c = classifyError('INSUFFICIENT_GITHUB_REPO_PERMISSIONS')!;
      expect(c.errorClass).toBe(ErrorClass.SERVICE);
      expect(isTransientError(c)).toBe(false);
    });

    test('a build/guardrail failure is USER (change the request/code)', () => {
      expect(classifyError('Guardrail blocked: nope')!.errorClass).toBe(ErrorClass.USER);
      expect(classifyError('Task did not succeed: agent_status="error_max_turns"')!.errorClass).toBe(ErrorClass.USER);
    });

    test('retryGuidance: TRANSIENT → "temporary … reply to retry … contact admin if it persists"', () => {
      const g = retryGuidance(classifyError('Session start failed: boom')!);
      expect(g).toMatch(/temporary infrastructure/i);
      expect(g).toMatch(/reply here to try again/i);
      expect(g).toMatch(/contact your ABCA admin/i);
    });

    test('retryGuidance: TRANSIENT + autoRetried → "I automatically tried again and it still failed"', () => {
      const g = retryGuidance(classifyError('Session start failed: boom')!, true);
      expect(g).toMatch(/automatically tried again/i);
    });

    test('retryGuidance: SERVICE → "retrying won\'t fix this … your ABCA admin"', () => {
      const g = retryGuidance(classifyError('INSUFFICIENT_GITHUB_REPO_PERMISSIONS')!);
      expect(g).toMatch(/won'?t fix this/i);
      expect(g).toMatch(/admin/i);
      expect(g).not.toMatch(/temporary infrastructure/i);
    });

    test('retryGuidance: USER guardrail → "edit the request"', () => {
      const g = retryGuidance(classifyError('Guardrail blocked: nope')!);
      expect(g).toMatch(/edit the request/i);
    });

    test('retryGuidance: retryable USER (non-guardrail) → "reply here with any extra guidance"', () => {
      const cls: ErrorClassification = {
        category: ErrorCategory.AGENT,
        title: 'build failed',
        description: 'the build/test step failed',
        remedy: 'fix the failing step',
        retryable: true,
        errorClass: ErrorClass.USER,
      };
      const g = retryGuidance(cls);
      expect(g).toMatch(/extra guidance/i);
      expect(g).toMatch(/try again/i);
      expect(g).not.toMatch(/edit the request/i);
    });

    test('retryGuidance: not-retryable USER/unknown → "a retry may not resolve this"', () => {
      const cls: ErrorClassification = {
        category: ErrorCategory.UNKNOWN,
        title: 'agent reported non-success',
        description: 'the agent finished without success',
        remedy: 'review the task output',
        retryable: false,
        errorClass: ErrorClass.USER,
      };
      const g = retryGuidance(cls);
      expect(g).toMatch(/may not resolve this/i);
      expect(g).toMatch(/contact your ABCA admin/i);
    });

    test('isTransientError is false for null / absent classification', () => {
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(undefined)).toBe(false);
    });
  });

  describe('pattern priority', () => {
    test('INSUFFICIENT_GITHUB_REPO_PERMISSIONS takes priority over GITHUB_UNREACHABLE substring', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
    });

    test('guardrail in hydration message takes priority over generic hydration failure', () => {
      const result = classifyError('Hydration failed: Error: Guardrail blocked: test');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
    });

    test('agent heartbeat loss matches compute, not agent', () => {
      const result = classifyError(
        'Agent session lost: no recent heartbeat from the runtime (container may have crashed, been OOM-killed, or stopped)',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
    });
  });

  describe('toTaskDetail integration', () => {
    const baseRecord: TaskRecord = {
      task_id: 'task-1',
      user_id: 'user-1',
      status: 'FAILED',
      repo: 'owner/repo',
      resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
      branch_name: 'bgagent/task-1/fix',
      channel_source: 'api',
      status_created_at: 'FAILED#2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    test('populates error_classification for a known error pattern', () => {
      const record: TaskRecord = { ...baseRecord, error_message: 'User concurrency limit reached' };
      const detail = toTaskDetail(record);
      expect(detail.error_classification).not.toBeNull();
      expect(detail.error_classification!.category).toBe('concurrency');
      expect(detail.error_classification!.title).toBe('Concurrency limit reached');
    });

    test('gives the console the token-specific fix of an agent push preflight refusal (#801)', () => {
      const detail = toTaskDetail({ ...baseRecord, error_message: MSG_APP });
      expect(detail.error_classification!.description).toContain('GitHub App token');
      expect(detail.error_classification!.remedy).toContain('install it on the repository');
      expect(detail.error_classification!.remedy).not.toContain('fine-grained');
      expect(detail.error_classification!.remedy).not.toContain('Update the PAT');
    });

    test('returns null error_classification when error_message is undefined', () => {
      const detail = toTaskDetail(baseRecord);
      expect(detail.error_message).toBeNull();
      expect(detail.error_classification).toBeNull();
    });

    test('returns unknown classification for unrecognized error_message', () => {
      const record: TaskRecord = { ...baseRecord, error_message: 'ValueError: something broke' };
      const detail = toTaskDetail(record);
      expect(detail.error_classification).not.toBeNull();
      expect(detail.error_classification!.category).toBe('unknown');
    });

    test('coerces string-typed numeric DDB fields to numbers on output', () => {
      const record = {
        ...baseRecord,
        duration_s: '12.5',
        cost_usd: '0.0042',
        max_turns: '30',
        max_budget_usd: '1.50',
        turns_attempted: '7',
        turns_completed: '6',
      } as unknown as TaskRecord;
      const detail = toTaskDetail(record);
      expect(typeof detail.duration_s).toBe('number');
      expect(detail.duration_s).toBe(12.5);
      expect(typeof detail.cost_usd).toBe('number');
      expect(detail.cost_usd).toBe(0.0042);
      expect(typeof detail.max_turns).toBe('number');
      expect(detail.max_turns).toBe(30);
      expect(typeof detail.max_budget_usd).toBe('number');
      expect(detail.max_budget_usd).toBe(1.5);
      expect(typeof detail.turns_attempted).toBe('number');
      expect(detail.turns_attempted).toBe(7);
      expect(typeof detail.turns_completed).toBe('number');
      expect(detail.turns_completed).toBe(6);
    });

    test('coerces unparseable numeric strings to null (does not crash)', () => {
      const record = {
        ...baseRecord,
        turns_attempted: 'not-a-number',
        turns_completed: 'NaN',
      } as unknown as TaskRecord;
      const detail = toTaskDetail(record);
      expect(detail.turns_attempted).toBeNull();
      expect(detail.turns_completed).toBeNull();
    });

    test('channel_source narrows to the literal union', () => {
      const apiRecord: TaskRecord = { ...baseRecord, channel_source: 'api' };
      const webhookRecord: TaskRecord = { ...baseRecord, channel_source: 'webhook' };
      const slackRecord: TaskRecord = { ...baseRecord, channel_source: 'slack' };
      const linearRecord: TaskRecord = { ...baseRecord, channel_source: 'linear' };
      expect(toTaskDetail(apiRecord).channel_source).toBe('api');
      expect(toTaskDetail(webhookRecord).channel_source).toBe('webhook');
      expect(toTaskDetail(slackRecord).channel_source).toBe('slack');
      expect(toTaskDetail(linearRecord).channel_source).toBe('linear');

      // @ts-expect-error — 'email' is not a valid ChannelSource
      const invalid: TaskRecord = { ...baseRecord, channel_source: 'email' };
      expect(invalid.channel_source).toBeDefined();
    });
  });
});
