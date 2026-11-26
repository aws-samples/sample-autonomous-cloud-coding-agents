"""Credential helper for Claude Code's Bedrock calls (#215, cost attribution).

Claude Code's ``awsCredentialExport`` setting runs this script, captures its
JSON stdout, and signs Bedrock requests with the returned credentials. With a
real ``Expiration`` it re-runs ~5 min before expiry during active use, and
returns its previous cached value while that refresh runs in the background.

Assumes the per-task SessionRole with ``{user_id, repo, task_id}`` STS session
tags. If the attribution config is absent or the assume-role fails, emits the
**ambient** compute-role credentials instead.

Output shape (consumed by Claude Code's awsCredentialExport):

    {"Credentials": {"AccessKeyId": "...", "SecretAccessKey": "...",
                     "SessionToken": "...", "Expiration": "<ISO8601>"}}
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

MICROVM_CREDENTIAL_BROKER_ENV = "ABCA_MICROVM_CREDENTIAL_BROKER"

ATTRIBUTION_FILE_ENV = "BEDROCK_ATTRIBUTION_FILE"
DEFAULT_ATTRIBUTION_FILE = "/home/agent/.bedrock-attribution.json"

# AWS caps a role-chained session at 1 hour.
_CHAINED_SESSION_DURATION_S = 3600


def attribution_file_path() -> str:
    return os.environ.get(ATTRIBUTION_FILE_ENV, "").strip() or DEFAULT_ATTRIBUTION_FILE


def write_attribution_file(
    role_arn: str, tags: list[dict[str, str]], path: str | None = None
) -> str:
    """Persist the SessionRole ARN + STS tags for the helper to read.

    Written 0600 and owned by the agent user. Returns the path written.
    """
    target = path or attribution_file_path()
    payload = json.dumps({"role_arn": role_arn, "tags": tags})
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(payload)
    return target


def _warn(message: str) -> None:
    print(f"[bedrock-creds] {message}", file=sys.stderr)


def _emit(creds: dict[str, str]) -> None:
    json.dump({"Credentials": creds}, sys.stdout)


def _frozen_to_creds(frozen: Any, expiry_iso: str | None) -> dict[str, str]:
    out = {
        "AccessKeyId": frozen.access_key,
        "SecretAccessKey": frozen.secret_key,
        "SessionToken": frozen.token or "",
    }
    if expiry_iso:
        out["Expiration"] = expiry_iso
    return out


def _ambient_credentials() -> dict[str, str]:
    import botocore.session  # noqa: TID251

    creds = botocore.session.get_session().get_credentials()  # noqa: TID251
    if creds is None:
        _warn(
            "no resolvable AWS credentials; emitting empty envelope, "
            "Claude Code will use its default chain"
        )
        return {}
    return _frozen_to_creds(creds.get_frozen_credentials(), None)


def resolve_credentials() -> dict[str, str]:
    """Use the MicroVM default provider, otherwise retain attribution fallback."""
    if os.environ.get(MICROVM_CREDENTIAL_BROKER_ENV) == "1":
        return {}
    path = attribution_file_path()
    try:
        with open(path) as fh:
            cfg = json.load(fh)
        role_arn = cfg["role_arn"]
        tags = cfg.get("tags", [])
    except FileNotFoundError:
        _warn("attribution file absent; not configured — using ambient creds")
        return _ambient_credentials()
    except (OSError, ValueError, KeyError) as exc:
        _warn(
            f"attribution file present but unreadable ({type(exc).__name__}: {exc}); "
            "using ambient creds"
        )
        return _ambient_credentials()

    try:
        import boto3  # noqa: F401  -- availability probe for the fail-open below
        from botocore.exceptions import BotoCoreError, ClientError

        from aws_session import platform_client
    except ImportError as exc:
        _warn(f"boto3 unavailable ({exc}); using ambient creds — fix the image")
        return _ambient_credentials()

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    task_id = next((t["Value"] for t in tags if t.get("Key") == "task_id"), "")
    session_name = f"abca-bedrock-{task_id}"[:64] or "abca-bedrock"
    try:
        resp = platform_client("sts", region_name=region).assume_role(
            RoleArn=role_arn,
            RoleSessionName=session_name,
            DurationSeconds=_CHAINED_SESSION_DURATION_S,
            Tags=tags,
        )
        c = resp["Credentials"]
        return {
            "AccessKeyId": c["AccessKeyId"],
            "SecretAccessKey": c["SecretAccessKey"],
            "SessionToken": c["SessionToken"],
            "Expiration": c["Expiration"].isoformat(),
        }
    except (ClientError, BotoCoreError) as exc:
        _warn(
            f"assume_role failed ({type(exc).__name__}: {exc}); using ambient creds "
            "— Bedrock spend will be UNTAGGED"
        )
        return _ambient_credentials()
    except Exception as exc:
        _warn(
            f"UNEXPECTED error minting tagged creds ({type(exc).__name__}: {exc}); "
            "using ambient creds"
        )
        return _ambient_credentials()


def main() -> int:
    _emit(resolve_credentials())
    return 0


if __name__ == "__main__":
    sys.exit(main())
