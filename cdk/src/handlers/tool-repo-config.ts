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
 * When the AgentCore Gateway invokes a Lambda target it passes the tool's input
 * arguments as the raw ``event`` (no envelope) and the routing metadata via the
 * Lambda client context: ``context.clientContext.custom.bedrockAgentCoreToolName``
 * is ``<targetName>___<toolName>`` (three-underscore delimiter). The return value
 * is any JSON-serializable object; the Gateway wraps it as an MCP tool result. A
 * thrown error surfaces as an MCP tool error.
 */

import type { Context } from 'aws-lambda';
import { logger } from './shared/logger';
import { type ComputeType, lookupRepo } from './shared/repo-config';

const TOOL_NAME_DELIMITER = '___';

const TOOL_REPO_CONFIG = 'abca_repo_config';

interface RepoConfigToolInput {
  readonly repo?: unknown;
}

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

function resolveToolName(context: Context): string | undefined {
  // The Node Lambda types expose `custom`; the wire payload has also used `Custom`.
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
 * Gateway surfaces them as MCP tool errors.
 */
export async function handler(event: RepoConfigToolInput, context: Context): Promise<RepoConfigToolResult> {
  const toolName = resolveToolName(context);
  logger.info('abca gateway tool invoked', { toolName });

  if (toolName !== undefined && toolName !== TOOL_REPO_CONFIG) {
    throw new Error(`Unknown tool '${toolName}' routed to the repo-config target.`);
  }

  const repo = parseRepoArg(event);
  const { onboarded, config } = await lookupRepo(repo);

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
