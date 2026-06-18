#!/usr/bin/env python3
#
#  MIT No Attribution — Copyright Amazon.com, Inc. or its affiliates.
#
# Linear epic harness for #247 orchestration stress testing (Mode A).
#
# Creates a parent "epic" issue plus a DAG of child sub-issues wired with
# "blocked by" relations, then (optionally) applies the trigger label to
# fire the orchestration. Also inspects + tears down test epics. Kept as a
# real .py file so the GraphQL payloads don't fight shell quoting.
#
# Auth: reads the Linear PAT from $LINEAR_PAT or /tmp/linear_pat (never
# echoed). All workspace ids are ABCA-demo defaults but overridable by flag.
#
# Usage:
#   linear_epic.py create-epic   --spec <spec.json>            # build + wire a DAG (no trigger)
#   linear_epic.py trigger       --issue <uuid|identifier>      # add trigger label → orchestrate
#   linear_epic.py inspect       --issue <uuid|identifier>      # parent + children + deps + state
#   linear_epic.py teardown      --issue <uuid|identifier>      # archive parent + all children
#
# A DAG spec is JSON: {"title": "...", "nodes": [{"key":"A","title":"...",
#   "description":"...","depends_on":["B",...]}, ...]}. Node "key" is a local
# alias used only to express edges; real Linear ids are resolved after create.

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

LINEAR_URL = "https://api.linear.app/graphql"
TEAM_ID = "8ab50246-938f-4b85-aff8-3df416787075"        # ABCA
PROJECT_ID = "f369205b-2c33-4b1b-ac5f-52c640c3243e"     # abca-demo → isadeks/vercel-abca-linear
TRIGGER_LABEL = "abca"


def pat():
    p = os.environ.get("LINEAR_PAT")
    if not p:
        try:
            with open("/tmp/linear_pat") as f:
                p = f.read().strip()
        except OSError:
            pass
    if not p:
        sys.exit("No Linear PAT in $LINEAR_PAT or /tmp/linear_pat")
    return p


def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        LINEAR_URL, data=body,
        headers={"Authorization": pat(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()[:400]}")
    if "errors" in out:
        sys.exit("GraphQL errors: " + json.dumps(out["errors"])[:600])
    return out["data"]


def label_id(name):
    d = gql(
        'query($t:String!){ team(id:$t){ labels(first:50){ nodes{ id name } } } }',
        {"t": TEAM_ID},
    )
    for n in d["team"]["labels"]["nodes"]:
        if n["name"] == name:
            return n["id"]
    sys.exit(f"Label {name!r} not found on team")


def resolve_issue_id(ref):
    """Accept a UUID or an identifier like ABCA-123 → return the UUID."""
    if "-" in ref and ref.split("-")[0].isalpha():
        d = gql('query($id:String!){ issue(id:$id){ id } }', {"id": ref})
        return d["issue"]["id"]
    return ref


def create_issue(title, description, parent_id=None):
    inp = {
        "teamId": TEAM_ID,
        "projectId": PROJECT_ID,
        "title": title,
        "description": description,
    }
    if parent_id:
        inp["parentId"] = parent_id
    d = gql(
        'mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ id identifier } } }',
        {"i": inp},
    )
    iss = d["issueCreate"]["issue"]
    return iss["id"], iss["identifier"]


def create_blocks(blocker_id, blocked_id):
    """blocker_id BLOCKS blocked_id → blocked_id depends_on blocker_id."""
    gql(
        'mutation($i:IssueRelationCreateInput!){ issueRelationCreate(input:$i){ success } }',
        {"i": {"issueId": blocker_id, "relatedIssueId": blocked_id, "type": "blocks"}},
    )


def add_label(issue_id, lbl_id):
    gql(
        'mutation($id:String!,$l:[String!]){ issueUpdate(id:$id, input:{addedLabelIds:$l}){ success } }',
        {"id": issue_id, "l": [lbl_id]},
    )


def cmd_create_epic(args):
    spec = json.load(open(args.spec))
    parent_id, parent_ident = create_issue(
        spec["title"], spec.get("description", "Orchestration stress-test epic."),
    )
    print(f"PARENT {parent_ident} {parent_id}  {spec['title']}")
    key_to_id = {}
    for node in spec["nodes"]:
        cid, cident = create_issue(
            node["title"], node.get("description", ""), parent_id=parent_id,
        )
        key_to_id[node["key"]] = cid
        print(f"  CHILD {cident} {cid}  key={node['key']}  {node['title']}")
    # Wire edges: for child C depends_on P, P BLOCKS C.
    for node in spec["nodes"]:
        for dep in node.get("depends_on", []):
            create_blocks(key_to_id[dep], key_to_id[node["key"]])
            print(f"  EDGE  {dep} blocks {node['key']}")
    print(f"\nReady. Trigger with: scripts/linear_epic.py trigger --issue {parent_ident}")
    print(json.dumps({"parent_id": parent_id, "parent_identifier": parent_ident,
                      "children": key_to_id}))


def cmd_trigger(args):
    iid = resolve_issue_id(args.issue)
    add_label(iid, label_id(TRIGGER_LABEL))
    print(f"Trigger label {TRIGGER_LABEL!r} applied to {args.issue} → orchestration firing.")


def cmd_inspect(args):
    iid = resolve_issue_id(args.issue)
    d = gql(
        '''query($id:String!){ issue(id:$id){ identifier title
            state{ name type } labels{ nodes{ name } }
            children(first:50){ nodes{ identifier title state{ name type }
              inverseRelations(first:20){ nodes{ type issue{ identifier } } } } } } }''',
        {"id": iid},
    )
    i = d["issue"]
    print(f"PARENT {i['identifier']}  [{i['state']['name']}]  {i['title']}")
    print(f"  labels: {[l['name'] for l in i['labels']['nodes']]}")
    for c in i["children"]["nodes"]:
        deps = [r["issue"]["identifier"] for r in c["inverseRelations"]["nodes"]
                if r["type"] == "blocks"]
        print(f"  {c['identifier']:10} [{c['state']['name']:11}] blocked_by={deps}  {c['title'][:46]}")


def cmd_teardown(args):
    iid = resolve_issue_id(args.issue)
    d = gql(
        'query($id:String!){ issue(id:$id){ identifier children(first:50){ nodes{ id identifier } } } }',
        {"id": iid},
    )
    i = d["issue"]
    for c in i["children"]["nodes"]:
        gql('mutation($id:String!){ issueArchive(id:$id){ success } }', {"id": c["id"]})
        print(f"  archived child {c['identifier']}")
    gql('mutation($id:String!){ issueArchive(id:$id){ success } }', {"id": iid})
    print(f"archived parent {i['identifier']}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("create-epic"); p.add_argument("--spec", required=True); p.set_defaults(fn=cmd_create_epic)
    p = sub.add_parser("trigger"); p.add_argument("--issue", required=True); p.set_defaults(fn=cmd_trigger)
    p = sub.add_parser("inspect"); p.add_argument("--issue", required=True); p.set_defaults(fn=cmd_inspect)
    p = sub.add_parser("teardown"); p.add_argument("--issue", required=True); p.set_defaults(fn=cmd_teardown)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
