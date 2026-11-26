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

import { emitWebhookScreeningFailedMetric } from '../../../src/handlers/shared/webhook-screening-metric';

describe('emitWebhookScreeningFailedMetric', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('writes one embedded-metric document: a metric per source and a total without dimensions', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const now = Date.parse('2026-11-19T12:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);

    emitWebhookScreeningFailedMetric('linear-docs');

    expect(stdout).toHaveBeenCalledTimes(1);
    const line = String(stdout.mock.calls[0][0]);
    // CloudWatch Logs extracts metrics from a log event that is one JSON object and nothing else.
    expect(line).toMatch(/^\{.*\}\n$/);
    expect(JSON.parse(line)).toEqual({
      _aws: {
        Timestamp: now,
        CloudWatchMetrics: [{
          Namespace: 'ABCA/Webhooks',
          // One metric per DimensionSet: without the empty set CloudWatch holds only the per-source metrics.
          Dimensions: [['source'], []],
          Metrics: [{ Name: 'WebhookScreeningFailed', Unit: 'Count' }],
        }],
      },
      WebhookScreeningFailed: 1,
      source: 'linear-docs',
    });
  });
});
