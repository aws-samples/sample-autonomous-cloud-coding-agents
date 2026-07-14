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
 * Event governance types (issue #230). Keep in sync with cli/src/types.ts.
 */

export type EventRuleAction =
  | 'require_approval'
  | 'notify'
  | 'escalate'
  | 'cancel_task'
  | 'inject_nudge'
  | 'observe_only';

export type EventRuleMode = 'observe_only' | 'enforce';
export type EventRuleEvaluation = 'sync' | 'async';
export type ApprovalSource = 'tool' | 'event';

export type NotificationChannelWithWebhook = 'slack' | 'email' | 'github' | 'linear' | 'webhook';

export interface EventRuleWhen {
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly aggregate?: {
    readonly cost_usd_gte?: number;
    readonly turn_count_gte?: number;
  };
}

export interface EventRule {
  readonly id: string;
  readonly on: string;
  readonly when?: EventRuleWhen;
  readonly action: EventRuleAction;
  readonly mode: EventRuleMode;
  readonly evaluation: EventRuleEvaluation;
  readonly reason?: string;
  readonly severity?: 'low' | 'medium' | 'high';
  readonly timeout_s?: number;
  readonly notify_channels?: readonly NotificationChannelWithWebhook[];
  readonly rule_pack_id?: string;
}

export interface EventRulePackRef {
  readonly id: string;
  readonly version: string;
}

export interface PolicyDecisionMetadata {
  readonly decision: 'allow' | 'deny' | 'require_approval' | 'observe';
  readonly source: 'cedar_tool' | 'event_rule' | 'submission';
  readonly enforcement_mode: EventRuleMode;
  readonly rule_id?: string;
  readonly rule_pack_id?: string;
  readonly trigger_event_type?: string;
  readonly trigger_milestone?: string;
  readonly checkpoint?: string;
  readonly correlation_id?: string;
  readonly matching_rule_ids?: readonly string[];
  readonly reason?: string;
  readonly severity?: string;
  readonly timeout_s?: number;
  readonly action?: string;
  readonly would_block?: boolean;
}
