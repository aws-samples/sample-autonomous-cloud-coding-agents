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

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './logger';
import { makeClient, makeDocClient } from './ua';

const ddb = makeDocClient();
const lambdaClient = makeClient(LambdaClient);

export function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * The tail of a webhook receiver: claim the delivery in the dedup table, then hand
 * `payload` to the processor Lambda asynchronously. `label` is the surface word of the
 * log texts ('Linear'); `logFields` ride the dedup-hit and invoke-failure lines.
 *
 * @returns 200 for a dispatched delivery and for a redelivery (`deduped: true`), 500 when
 *   the invoke failed. Any other error of the claim is thrown.
 */
export async function dedupAndDispatch(args: {
  label: string;
  dedupTableName: string;
  dedupKey: string;
  ttlSeconds: number;
  processorFunctionName: string;
  payload: unknown;
  logFields?: Record<string, unknown>;
}): Promise<APIGatewayProxyResult> {
  const { label, dedupTableName, dedupKey, ttlSeconds, processorFunctionName, payload, logFields } = args;
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(new PutCommand({
      TableName: dedupTableName,
      Item: {
        dedup_key: dedupKey,
        created_at: new Date().toISOString(),
        ttl: nowSeconds + ttlSeconds,
      },
      ConditionExpression: 'attribute_not_exists(dedup_key)',
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      logger.info(`${label} webhook dedup hit — skipping reprocess`, { dedup_key: dedupKey, ...logFields });
      return jsonResponse(200, { ok: true, deduped: true });
    }
    throw err;
  }

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
  } catch (invokeErr) {
    logger.error(`Failed to invoke ${label} webhook processor`, {
      error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
      ...logFields,
    });
    // Give the claim back so the sender's retry can dispatch: left in place, the row
    // answers every retry as a duplicate until its TTL and the event is lost.
    try {
      await ddb.send(new DeleteCommand({
        TableName: dedupTableName,
        Key: { dedup_key: dedupKey },
      }));
    } catch (cleanupErr) {
      logger.warn(`Failed to roll back ${label} webhook dedup row after invoke failure`, {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        dedup_key: dedupKey,
      });
    }
    return jsonResponse(500, { error: 'Dispatch failed' });
  }

  return jsonResponse(200, { ok: true });
}
