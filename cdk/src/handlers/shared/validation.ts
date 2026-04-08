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

import type { CreateTaskRequest } from './types';
import { TaskStatus } from '../../constructs/task-status';

/** Default maximum agent turns per task. */
export const DEFAULT_MAX_TURNS = 100;
/** Minimum allowed value for max_turns. */
export const MIN_MAX_TURNS = 1;
/** Maximum allowed value for max_turns. */
export const MAX_MAX_TURNS = 500;
/** Maximum allowed length for task_description. */
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
/** Minimum allowed value for max_budget_usd (1 cent). */
export const MIN_MAX_BUDGET_USD = 0.01;
/** Maximum allowed value for max_budget_usd ($100). */
export const MAX_MAX_BUDGET_USD = 100;

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const WEBHOOK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}[a-zA-Z0-9]$/;
const ALL_STATUSES = new Set(Object.values(TaskStatus));

/**
 * Parse a JSON request body. Returns null if the body is missing or not valid JSON.
 * @param body - the raw request body string.
 * @returns the parsed object, or null on failure.
 */
export function parseBody<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Validate GitHub repository format (`owner/repo`).
 * @param repo - the repository string to validate.
 * @returns true if the format is valid.
 */
export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

/**
 * Validate that a create task request has at least one task specification.
 * @param req - the parsed create task request.
 * @returns true if issue_number or task_description is provided.
 */
export function hasTaskSpec(req: CreateTaskRequest): boolean {
  if (req.task_type === 'pr_iteration' && req.pr_number !== undefined && req.pr_number !== null) {
    return true;
  }
  return (req.issue_number !== undefined && req.issue_number !== null) ||
    (req.task_description !== undefined && req.task_description !== null && req.task_description.trim().length > 0);
}

/**
 * Validate an idempotency key format (alphanumeric, dashes, underscores, max 128 chars).
 * @param key - the idempotency key to validate.
 * @returns true if the format is valid.
 */
export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Parse and validate a status filter query parameter.
 * Accepts a single status or comma-separated list.
 * @param statusParam - the raw status query parameter.
 * @returns array of valid status strings, or null if any status is invalid.
 */
export function parseStatusFilter(statusParam: string | undefined): string[] | null {
  if (!statusParam) return null;
  const statuses = statusParam.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (statuses.length === 0) return null;
  for (const s of statuses) {
    if (!ALL_STATUSES.has(s as never)) return null;
  }
  return statuses;
}

/**
 * Parse and clamp a pagination limit query parameter.
 * @param limitParam - the raw limit query parameter.
 * @param defaultLimit - the default limit if not specified.
 * @param maxLimit - the maximum allowed limit.
 * @returns the clamped limit value.
 */
export function parseLimit(limitParam: string | undefined, defaultLimit: number, maxLimit: number): number {
  if (!limitParam) return defaultLimit;
  const parsed = parseInt(limitParam, 10);
  if (isNaN(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

/**
 * Decode a base64-encoded pagination token to a DynamoDB ExclusiveStartKey.
 * @param token - the base64 pagination token.
 * @returns the decoded key object, or undefined if token is absent or invalid.
 */
export function decodePaginationToken(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Encode a DynamoDB LastEvaluatedKey as a base64 pagination token.
 * @param lastKey - the DynamoDB LastEvaluatedKey.
 * @returns the encoded token string, or null if there is no next page.
 */
export function encodePaginationToken(lastKey: Record<string, unknown> | undefined): string | null {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey)).toString('base64');
}

/**
 * Validate a webhook name (2-64 characters, alphanumeric, spaces, hyphens, underscores).
 * Must start and end with an alphanumeric character.
 * @param name - the webhook name to validate.
 * @returns true if the name is valid.
 */
export function isValidWebhookName(name: string): boolean {
  if (name.length === 1) return /^[a-zA-Z0-9]$/.test(name);
  return WEBHOOK_NAME_PATTERN.test(name);
}

/**
 * Validate a max_turns value from a request body.
 * @param value - the raw value from the request.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent (use default).
 */
export function validateMaxTurns(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  if (value < MIN_MAX_TURNS || value > MAX_MAX_TURNS) return null;
  return value;
}

/**
 * Validate a max_budget_usd value from a request body.
 * @param value - the raw value from the request.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent (use default).
 */
export function validateMaxBudgetUsd(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (value < MIN_MAX_BUDGET_USD || value > MAX_MAX_BUDGET_USD) return null;
  return value;
}

/**
 * Validate a task_description length.
 * @param description - the task description to validate.
 * @returns true if within the allowed length, false if too long.
 */
export function isValidTaskDescriptionLength(description: string): boolean {
  return description.length <= MAX_TASK_DESCRIPTION_LENGTH;
}

/**
 * Compute a TTL epoch (seconds since Unix epoch) for DynamoDB TTL.
 * @param retentionDays - number of days from now until expiry.
 * @returns the TTL epoch value.
 */
export function computeTtlEpoch(retentionDays: number): number {
  return Math.floor(Date.now() / 1000) + retentionDays * 86400;
}

/** Valid task type values. */
export const VALID_TASK_TYPES = new Set<string>(['new_task', 'pr_iteration']);

/**
 * Validate a task_type value from a request body.
 * @param value - the raw value from the request.
 * @returns true if the value is a valid task type or undefined/null (defaults to 'new_task').
 */
export function isValidTaskType(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  return VALID_TASK_TYPES.has(value);
}

/**
 * Validate a pr_number value from a request body.
 * @param value - the raw value from the request.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent.
 */
export function validatePrNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  if (value < 1) return null;
  return value;
}
