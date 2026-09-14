"""UA wire-capture check for the AGENT (Python) tier — #319 / PR #345.

Counterpart to ``cdk/scripts/ua-wire-check.ts`` (the Lambda/Node tier). Proves the
agent runtime's outbound boto3 ``User-Agent`` carries both solution-attribution
segments WITHOUT relying on CloudTrail (this account blocks DynamoDB data
events, so the wire is the only place to observe them):

    app/uksb-wt64nei4u6#{AWS_SDK_UA_APP_ID}   <- botocore reads the env var natively
    md/uksb-wt64nei4u6#agent                  <- from the REAL agent helper (ua.py)

It imports the agent's actual helper (``agent/src/ua.py``) — no mirror — builds
clients exactly like ``aws_session.platform_client`` (spreading ``client_config()``),
registers a botocore ``before-send`` handler to capture the fully-assembled
request headers, and makes one cheap read-only call per service. ``before-send``
fires with the signed request in hand; the UA is captured before the response,
so a perms failure still prints the header.

Run (from repo root, with the agent venv that has boto3):

    AWS_PROFILE=admin AWS_REGION=us-east-1 \
    AWS_SDK_UA_APP_ID='uksb-wt64nei4u6#integ-1910531' \
    agent/.venv/bin/python agent/scripts/diagnostics/ua_wire_check.py

Set AWS_SDK_UA_APP_ID='' to confirm the app/ segment drops (customer opt-out).
The md/ component is hard-wired to ``agent`` in ua.py (this surface IS the
agent), unlike the Node tier where ABCA_COMPONENT selects api/orchestr/webhook.

See docs/verification/319-ua-wire-runbook.md for the full runbook.
"""

from __future__ import annotations

import os
import sys

import boto3
from botocore.exceptions import BotoCoreError, ClientError

# Make ``agent/src`` importable when run as a standalone script (no pytest
# pythonpath here). This file lives at agent/scripts/diagnostics/, so agent/src
# is two directories up.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

# The REAL agent helper — the thing under test, not a copy.
from ua import COMPONENT, SOLUTION_ID, client_config


def _make_capture(label: str):
    """Return a botocore ``before-send`` handler that prints the wire UA."""

    def _capture(request, **_kwargs):
        ua = request.headers.get("User-Agent") or request.headers.get("user-agent") or "(none)"
        if isinstance(ua, (bytes, bytearray)):
            ua = ua.decode("utf-8", "replace")
        want = f"md/{SOLUTION_ID}"
        print(f"\n[{label}]")
        print(f"  User-Agent: {ua}")
        print(f"  contains {want}#... ? {'YES' if want in ua else 'NO'}")
        return None  # don't short-circuit; let the real request proceed

    return _capture


def _client(service: str, label: str):
    """boto3 client built like aws_session.platform_client + a UA capture hook."""
    client = boto3.client(service, config=client_config())
    # 'before-send.<service>' fires once the request is fully built & signed.
    client.meta.events.register("before-send", _make_capture(label))
    return client


def main() -> None:
    app_id = os.environ.get("AWS_SDK_UA_APP_ID")
    print("=== UA wire-capture: AGENT tier (#345) ===")
    print(f"AWS_SDK_UA_APP_ID = {app_id if app_id is not None else '(unset -> no app/ segment)'}")
    print(f"Expecting md/{SOLUTION_ID}#{COMPONENT} on every call.")

    calls = [
        ("STS GetCallerIdentity", "sts", lambda c: c.get_caller_identity()),
        ("DynamoDB ListTables", "dynamodb", lambda c: c.list_tables(Limit=1)),
        ("S3 ListBuckets", "s3", lambda c: c.list_buckets()),
        ("SecretsManager ListSecrets", "secretsmanager", lambda c: c.list_secrets(MaxResults=1)),
    ]

    for label, service, op in calls:
        client = _client(service, label)
        try:
            op(client)
        except (ClientError, BotoCoreError) as err:
            # UA already printed by the before-send hook; note the call outcome.
            print(f"  ({service} call errored after UA capture: {type(err).__name__})")


if __name__ == "__main__":
    main()
