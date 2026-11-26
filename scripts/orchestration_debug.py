#!/usr/bin/env python3
#
#  MIT No Attribution — Copyright Amazon.com, Inc. or its affiliates.
#
# Pretty-printer for Linear parent/sub-issue orchestration state.
# Reads DynamoDB JSON from stdin. Modes: "list" (meta rows) or "rows"
# (one orchestration's full DAG).

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


def renamed(item, current, legacy, default=""):
    """Read an attribute that has both a neutral and an older name."""
    return s(item, current) or s(item, legacy, default)


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
            issue = renamed(m, "parent_issue_ref", "parent_linear_issue_id")
            print(f"  {s(m, 'orchestration_id')}  issue={issue}  repo={s(m, 'repo')}  children={n}")
        print("\nInspect one with: scripts/orchestration-debug.sh <orchestration_id>")
        return

    if not items:
        print("  (no rows for this orchestration_id)")
        return
    meta = [i for i in items if s(i, "sub_issue_id") == "#meta"]
    kids = [i for i in items if s(i, "sub_issue_id") != "#meta"]

    for m in meta:
        n = m.get("child_count", {}).get("N", "?")
        # CodeQL's py/clear-text-logging-sensitive-data flags the prints below: it taints the
        # whole stdin-derived meta dict. False positive: they print ids and a yes/no flag.
        has_oauth = "yes" if "linear_oauth_secret_arn" in m else "no"
        issue = renamed(m, "parent_issue_ref", "parent_linear_issue_id")
        print(f"  PARENT  issue={issue}  repo={s(m, 'repo')}  children={n}")
        print(f"          release_ctx: user={s(m, 'platform_user_id')}  oauth={has_oauth}")

    for k in sorted(kids, key=lambda i: renamed(i, "display_id", "linear_identifier")):
        st = s(k, "child_status")
        deps = [x.get("S", "") for x in k.get("depends_on", {}).get("L", [])]
        tid = s(k, "child_task_id") or "-"
        label = renamed(k, "display_id", "linear_identifier") or s(k, "sub_issue_id")[:8]
        print(f"  {label:10} {STAT.get(st, st):11} deps={deps or '[]'}  task={tid}")


if __name__ == "__main__":
    main()
