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
 * AgentCore Gateway Lambda target backing the ``abca_repo_config`` MCP tool
 * (ADR-019 P1 exemplar). The agent, working inside a cloned repo, calls this
 * tool to look up that repo's ABCA onboarding configuration — compute
 * substrate, model, and the build/lint commands the platform will gate its PR
 * against — so it can align its own build verification with what CI expects.
 *
 * This is the FIRST tool federated through the AgentCore Gateway. It is
 * deliberately minimal and read-only: its job is to prove the substrate-portable
 * Gateway path (AWS_IAM/SigV4 inbound → Lambda target → gateway-execution-role
 * outbound, no vaulted credential) end to end, not to be a rich tool. Richer
 * tools (e.g. task history) follow once the mechanism is proven.
 *
 * ## Gateway → Lambda invocation contract
 *
 * When the Gateway invokes a Lambda target it passes the tool's input arguments
 * as the raw ``event`` (no envelope) and the routing metadata via the Lambda
 * client context: ``context.clientContext.custom.bedrockAgentCoreToolName`` is
 * ``<targetName>___<toolName>`` (three-underscore delimiter). One Lambda can
 * back many tools, so we switch on the stripped tool name. The return value is
 * any JSON-serializable object; the Gateway wraps it as an MCP tool result. A
 * thrown error surfaces as an MCP tool error.
 */

import type { Context } from 'aws-lambda';
import { logger } from './shared/logger';
import { type ComputeType, lookupRepo } from './shared/repo-config';

/** Three-underscore delimiter the Gateway uses in ``<target>___<tool>``. */
const TOOL_NAME_DELIMITER = '___';

/** The single tool this target backs. */
const TOOL_REPO_CONFIG = 'abca_repo_config';

/** Input arguments for ``abca_repo_config`` (mirrors the inline tool schema). */
interface RepoConfigToolInput {
  readonly repo?: unknown;
}

/**
 * The tool's response shape — a curated, non-sensitive projection of
 * ``RepoConfig``. Secret ARNs and other operational internals are deliberately
 * omitted: the agent only needs the fields that let it mirror CI's build/lint
 * gating and understand which substrate it runs on.
 *
 * Modeled as a discriminated union keyed on ``onboarded``: a non-onboarded repo
 * carries none of the config fields, and an onboarded one carries all of them.
 * This makes the "config present iff onboarded" invariant a compile-time
 * guarantee rather than a runtime convention of a bag of optionals.
 */
type RepoConfigToolResult =
  | { readonly repo: string; readonly onboarded: false }
  | {
    readonly repo: string;
    readonly onboarded: true;
    readonly compute_type?: ComputeType;
    readonly model_id?: string;
    readonly max_turns?: number;
    readonly build_command?: string;
    readonly lint_command?: string;
  };

/**
 * Extract the tool name from the Gateway client context, stripping the
 * ``<targetName>___`` prefix. Returns ``undefined`` when the context is absent
 * (e.g. a direct/local invoke rather than a Gateway invoke).
 */
function resolveToolName(context: Context): string | undefined {
  // The AgentCore runtime delivers the tool name under the client context's
  // custom map. The Node Lambda types expose it lowercase (`custom`), but the
  // wire payload has historically used `Custom` — read both defensively.
  const clientContext = context.clientContext as unknown as {
    custom?: Record<string, unknown>;
    Custom?: Record<string, unknown>;
  } | undefined;
  const raw = clientContext?.custom ?? clientContext?.Custom;
  const toolName = raw?.bedrockAgentCoreToolName;
  if (typeof toolName !== 'string') {
    return undefined;
  }
  const idx = toolName.indexOf(TOOL_NAME_DELIMITER);
  return idx >= 0 ? toolName.slice(idx + TOOL_NAME_DELIMITER.length) : toolName;
}

/** Validate + normalize the ``repo`` argument to an "owner/name" string. */
function parseRepoArg(input: RepoConfigToolInput): string {
  const { repo } = input;
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new Error("abca_repo_config requires a non-empty 'repo' argument (\"owner/name\").");
  }
  const trimmed = repo.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error(`abca_repo_config 'repo' must be in "owner/name" form; got '${trimmed}'.`);
  }
  return trimmed;
}

/**
 * Gateway Lambda target handler. Errors are thrown (not swallowed) so the
 * Gateway surfaces them as MCP tool errors rather than the agent silently
 * seeing an empty/mislabeled result.
 */
export async function handler(event: RepoConfigToolInput, context: Context): Promise<RepoConfigToolResult> {
  const toolName = resolveToolName(context);
  logger.info('abca gateway tool invoked', { toolName });

  // Defensive: this target backs exactly one tool today. If the Gateway routes
  // an unexpected tool name here, fail loudly rather than answer for the wrong
  // tool. ``undefined`` (local/direct invoke) is treated as the sole tool.
  if (toolName !== undefined && toolName !== TOOL_REPO_CONFIG) {
    throw new Error(`Unknown tool '${toolName}' routed to the repo-config target.`);
  }

  const repo = parseRepoArg(event);
  const { onboarded, config } = await lookupRepo(repo);

  // Non-onboarded is a normal, informative answer — not an error. The agent may
  // legitimately ask about a repo that was never registered with a Blueprint.
  if (!onboarded || !config) {
    return { repo, onboarded: false };
  }

  return {
    repo: config.repo,
    onboarded: true,
    compute_type: config.compute_type,
    model_id: config.model_id,
    max_turns: config.max_turns,
    build_command: config.build_command,
    lint_command: config.lint_command,
  };
}
