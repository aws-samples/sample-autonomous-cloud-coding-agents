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

// SPDX-License-Identifier: MIT-0

/** Shared by the two runtimes that run server.py's periodic heartbeat worker. */
export const AGENT_HEARTBEAT_GRACE_SEC = 120;
export const AGENT_HEARTBEAT_STALE_SEC = 240;

export function evaluateAgentHeartbeat(
  startedAtMs: number | undefined, heartbeatAtMs: number | undefined, nowMs: number,
): 'stale' | 'missing' | undefined {
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs)) return undefined;
  const age = (nowMs - startedAtMs) / 1000;
  if (heartbeatAtMs !== undefined) {
    return age > AGENT_HEARTBEAT_GRACE_SEC
      && (nowMs - heartbeatAtMs) / 1000 > AGENT_HEARTBEAT_STALE_SEC ? 'stale' : undefined;
  }
  return age > AGENT_HEARTBEAT_GRACE_SEC + AGENT_HEARTBEAT_STALE_SEC ? 'missing' : undefined;
}
