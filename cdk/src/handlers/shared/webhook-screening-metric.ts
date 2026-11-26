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

/** Namespace of the webhook intake metrics. */
export const WEBHOOK_METRIC_NAMESPACE = 'ABCA/Webhooks';

/** Counts the screening calls that failed, each of which dropped the content it was screening. */
export const WEBHOOK_SCREENING_FAILED_METRIC = 'WebhookScreeningFailed';

type WebhookScreeningSource = 'jira-comments' | 'linear-docs' | 'linear-comments' | 'linear-session-context';

/**
 * Count one block of advisory third-party content (comments, project documents or the
 * context of a Linear agent session) that a webhook processor dropped because the guardrail
 * call that screens it failed (#794). Content that the guardrail blocked is not counted.
 *
 * Written as an embedded-metric log line, which CloudWatch Logs turns into the metric.
 */
export function emitWebhookScreeningFailedMetric(source: WebhookScreeningSource): void {
  process.stdout.write(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: WEBHOOK_METRIC_NAMESPACE,
        // The set without dimensions is for the alarm, because CloudWatch does not add a
        // custom metric up over the values of a dimension.
        Dimensions: [['source'], []],
        Metrics: [{ Name: WEBHOOK_SCREENING_FAILED_METRIC, Unit: 'Count' }],
      }],
    },
    [WEBHOOK_SCREENING_FAILED_METRIC]: 1,
    source,
  }) + '\n');
}
