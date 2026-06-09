#!/usr/bin/env python3
#
#  MIT No Attribution — Copyright Amazon.com, Inc. or its affiliates.
#
# Pretty-printer for Linear orchestration state (issue #247, Mode A).
# Reads DynamoDB JSON from stdin. Modes: "list" (meta rows) or "rows"
# (one orchestration's full DAG). Kept as a real .py file (not an inline
# heredoc) so the f-strings don't fight shell quoting.

import sys
import json

STAT = {
    "ready": "ready",
    "blocked": "blocked",
    "released": "released",
    "succeeded": "succeeded",
    "failed": "FAILED",
    "skipped": "skipped",
}


def s(item, key, default=""):
    return item.get(key, {}).get("S", default)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "rows"
    data = json.load(sys.stdin)
    items = data.get("Items", [])

    if mode == "list":
        if not items:
            print("  (none — no orchestration has been triggered yet)")
            return
        for m in items:
            n = m.get("child_count", {}).get("N", "?")
            print(f"  {s(m, 'orchestration_id')}  issue={s(m, 'parent_linear_issue_id')}  repo={s(m, 'repo')}  children={n}")
        print("\nInspect one with: scripts/orchestration-debug.sh <orchestration_id>")
        return

    # rows mode: meta first, then children sorted by identifier
    if not items:
        print("  (no rows for this orchestration_id)")
        return
    meta = [i for i in items if s(i, "sub_issue_id") == "#meta"]
    kids = [i for i in items if s(i, "sub_issue_id") != "#meta"]

    for m in meta:
        n = m.get("child_count", {}).get("N", "?")
        has_oauth = "yes" if m.get("linear_oauth_secret_arn") else "no"
        print(f"  PARENT  issue={s(m, 'parent_linear_issue_id')}  repo={s(m, 'repo')}  children={n}")
        print(f"          release_ctx: user={s(m, 'platform_user_id')}  oauth={has_oauth}")

    for k in sorted(kids, key=lambda i: s(i, "linear_identifier")):
        st = s(k, "child_status")
        deps = [x.get("S", "") for x in k.get("depends_on", {}).get("L", [])]
        tid = s(k, "child_task_id") or "-"
        label = s(k, "linear_identifier") or s(k, "sub_issue_id")[:8]
        print(f"  {label:10} {STAT.get(st, st):11} deps={deps or '[]'}  task={tid}")


if __name__ == "__main__":
    main()
