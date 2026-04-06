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

import { errorResponse, ErrorCode, paginatedResponse, successResponse } from '../../../src/handlers/shared/response';

describe('successResponse', () => {
  test('produces correct envelope structure', () => {
    const result = successResponse(200, { id: '123' }, 'req-1');
    const body = JSON.parse(result.body);
    expect(result.statusCode).toBe(200);
    expect(body).toEqual({ data: { id: '123' } });
  });

  test('includes X-Request-Id header', () => {
    const result = successResponse(201, {}, 'req-abc');
    expect(result.headers?.['X-Request-Id']).toBe('req-abc');
  });

  test('includes Content-Type header', () => {
    const result = successResponse(200, {}, 'req-1');
    expect(result.headers?.['Content-Type']).toBe('application/json');
  });
});

describe('paginatedResponse', () => {
  test('produces correct envelope with pagination', () => {
    const result = paginatedResponse([{ id: '1' }, { id: '2' }], 'next-token', 'req-1');
    const body = JSON.parse(result.body);
    expect(result.statusCode).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toEqual({ next_token: 'next-token', has_more: true });
  });

  test('sets has_more to false when next_token is null', () => {
    const result = paginatedResponse([], null, 'req-1');
    const body = JSON.parse(result.body);
    expect(body.pagination).toEqual({ next_token: null, has_more: false });
  });

  test('includes X-Request-Id header', () => {
    const result = paginatedResponse([], null, 'req-xyz');
    expect(result.headers?.['X-Request-Id']).toBe('req-xyz');
  });
});

describe('errorResponse', () => {
  test('produces correct error envelope', () => {
    const result = errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task abc not found.', 'req-1');
    const body = JSON.parse(result.body);
    expect(result.statusCode).toBe(404);
    expect(body).toEqual({
      error: {
        code: 'TASK_NOT_FOUND',
        message: 'Task abc not found.',
        request_id: 'req-1',
      },
    });
  });

  test('includes X-Request-Id header', () => {
    const result = errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Oops', 'req-err');
    expect(result.headers?.['X-Request-Id']).toBe('req-err');
  });

  test('includes Content-Type header', () => {
    const result = errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Bad', 'req-1');
    expect(result.headers?.['Content-Type']).toBe('application/json');
  });
});

describe('ErrorCode', () => {
  test('contains all expected error codes', () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.TASK_NOT_FOUND).toBe('TASK_NOT_FOUND');
    expect(ErrorCode.DUPLICATE_TASK).toBe('DUPLICATE_TASK');
    expect(ErrorCode.TASK_ALREADY_TERMINAL).toBe('TASK_ALREADY_TERMINAL');
    expect(ErrorCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });
});
