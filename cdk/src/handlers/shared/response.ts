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

import type { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Machine-readable error codes matching the API contract.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  DUPLICATE_TASK: 'DUPLICATE_TASK',
  TASK_ALREADY_TERMINAL: 'TASK_ALREADY_TERMINAL',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  WEBHOOK_NOT_FOUND: 'WEBHOOK_NOT_FOUND',
  WEBHOOK_ALREADY_REVOKED: 'WEBHOOK_ALREADY_REVOKED',
  REPO_NOT_ONBOARDED: 'REPO_NOT_ONBOARDED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/**
 * Build a success response with `{ data: ... }` envelope.
 * @param statusCode - HTTP status code.
 * @param data - the response payload.
 * @param requestId - unique request ID for the X-Request-Id header.
 * @returns the API Gateway proxy result.
 */
export function successResponse(statusCode: number, data: unknown, requestId: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...COMMON_HEADERS, 'X-Request-Id': requestId },
    body: JSON.stringify({ data }),
  };
}

/**
 * Build a paginated list response with `{ data: [...], pagination: { ... } }` envelope.
 * @param data - the list of items.
 * @param nextToken - pagination token for the next page, or null if no more pages.
 * @param requestId - unique request ID for the X-Request-Id header.
 * @returns the API Gateway proxy result.
 */
export function paginatedResponse(
  data: unknown[],
  nextToken: string | null,
  requestId: string,
): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { ...COMMON_HEADERS, 'X-Request-Id': requestId },
    body: JSON.stringify({
      data,
      pagination: {
        next_token: nextToken,
        has_more: nextToken !== null,
      },
    }),
  };
}

/**
 * Build an error response with `{ error: { ... } }` envelope.
 * @param statusCode - HTTP status code.
 * @param code - machine-readable error code.
 * @param message - human-readable error message.
 * @param requestId - unique request ID for the X-Request-Id header.
 * @returns the API Gateway proxy result.
 */
export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...COMMON_HEADERS, 'X-Request-Id': requestId },
    body: JSON.stringify({
      error: {
        code,
        message,
        request_id: requestId,
      },
    }),
  };
}
