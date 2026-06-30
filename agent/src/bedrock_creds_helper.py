#!/usr/bin/env python3
"""Credential helper for Claude Code's Bedrock calls (#215, cost attribution).

Claude Code (``CLAUDE_CODE_USE_BEDROCK=1``) makes every ``InvokeModel`` call —
not the agent's boto3 — so the per-task tenant-data SessionRole in
``aws_session.py`` cannot tag those calls. Instead Claude Code's
``awsCredentialExport`` setting (in the image's managed-settings layer) runs
this script, captures its JSON stdout, and signs Bedrock requests with the
returned credentials. With a real ``Expiration`` it re-runs ~5 min before
expiry, so an 8 h task survives the 1 h role-chaining cap.

Goal: assume the per-task SessionRole with ``{user_id, repo, task_id}`` STS
session tags so Bedrock spend is attributable per user/repo in AWS Cost
Explorer / CUR 2.0 (``iamPrincipal/*`` dimensions, after the operator activates
the cost-allocation tags). The same role already carries the tenant-data grants;
Track-1 only adds ``bedrock:InvokeModel*`` to it (see ``agent-session-role.ts``).

**Fails OPEN.** Bedrock attribution is a billing/observability control, not a
tenant-isolation one (contrast ``aws_session.py``, which fails closed). If the
attribution config is absent or the assume-role fails, this helper emits the
**ambient** compute-role credentials so Bedrock keeps working untagged — losing
chargeback granularity is not a security incident, and the compute role retains
``InvokeModel`` precisely so this fallback works.

The role ARN and tag values are read from a 0600 JSON file the agent writes at
startup (``write_attribution_file``), not from the environment — so the tenant
identifiers are not inherited by the untrusted repo subprocesses the agent
spawns, matching the discipline in ``aws_session.py``.

Output shape (consumed by Claude Code's awsCredentialExport):

    {"Credentials": {"AccessKeyId": "...", "SecretAccessKey": "...",
                     "SessionToken": "...", "Expiration": "<ISO8601>"}}
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

# Fixed path the agent writes (0600) and this helper reads. A fixed path is
# required because the managed-settings ``awsCredentialExport`` command is
# static (baked into the image) and cannot carry per-task arguments.
ATTRIBUTION_FILE_ENV = "BEDROCK_ATTRIBUTION_FILE"
DEFAULT_ATTRIBUTION_FILE = "/home/agent/.bedrock-attribution.json"

# Role chaining caps the assumed session at 1 hour; request the max the cap
# allows. Claude Code refreshes ~5 min before the returned Expiration.
_CHAINED_SESSION_DURATION_S = 3600


def attribution_file_path() -> str:
    return os.environ.get(ATTRIBUTION_FILE_ENV, "").strip() or DEFAULT_ATTRIBUTION_FILE


def write_attribution_file(
    role_arn: str, tags: list[dict[str, str]], path: str | None = None
) -> str:
    """Persist the SessionRole ARN + STS tags for the helper to read.

    Written 0600 and owned by the agent user. Returns the path written. Called
    by the agent at startup (see ``runner._setup_agent_env``) only when a
    SessionRole is configured; absence is the fail-open signal.
    """
    target = path or attribution_file_path()
    payload = json.dumps({"role_arn": role_arn, "tags": tags})
    # Create with 0600 from the start (os.open + O_CREAT honors mode, modulo
    # umask) so the secret-adjacent file is never briefly world-readable.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(payload)
    return target


def _warn(message: str) -> None:
    """Emit a diagnostic to stderr.

    This process's **stdout is the credential channel** — Claude Code parses it
    as the ``awsCredentialExport`` JSON result — so diagnostics MUST go to
    stderr or they would corrupt the credential envelope. (This is also why
    ``shell.log``, which writes to fd 1, is unusable here.) Every fail-open path
    logs through here so a silent, weeks-long loss of cost attribution is
    instead a visible, correlatable signal — the fallback stays open, but it is
    never invisible.
    """
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
    """Frozen ambient (compute-role) credentials — the fail-open fallback."""
    import botocore.session

    creds = botocore.session.get_session().get_credentials()
    if creds is None:
        # No resolvable credentials at all — the deepest degradation. Emit an
        # empty object; Claude Code then falls back to its own default-chain
        # resolution. Surface it: if that fallback also fails, this stderr line
        # is the only breadcrumb.
        _warn(
            "no resolvable AWS credentials; emitting empty envelope, "
            "Claude Code will use its default chain"
        )
        return {}
    return _frozen_to_creds(creds.get_frozen_credentials(), None)


def resolve_credentials() -> dict[str, str]:
    """Return tagged assumed-role creds, or ambient creds on any failure."""
    path = attribution_file_path()
    try:
        with open(path) as fh:
            cfg = json.load(fh)
        role_arn = cfg["role_arn"]
        tags = cfg.get("tags", [])
    except FileNotFoundError:
        # Attribution not configured (local/dev, or pre-provisioning). Expected
        # and benign — debug-level signal only.
        _warn("attribution file absent; not configured — using ambient creds")
        return _ambient_credentials()
    except (OSError, ValueError, KeyError) as exc:
        # File present but unreadable/malformed/schema-drifted. This is NOT the
        # benign "not configured" case — it points at a write_attribution_file
        # bug or a partial write, so it warrants a louder signal.
        _warn(
            f"attribution file present but unreadable ({type(exc).__name__}: {exc}); "
            "using ambient creds"
        )
        return _ambient_credentials()

    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as exc:
        # boto3 missing/broken in the image is a packaging defect, not the
        # expected assume-role failure — name it explicitly so it can't hide.
        _warn(f"boto3 unavailable ({exc}); using ambient creds — fix the image")
        return _ambient_credentials()

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    task_id = next((t["Value"] for t in tags if t.get("Key") == "task_id"), "")
    session_name = f"abca-bedrock-{task_id}"[:64] or "abca-bedrock"
    try:
        resp = boto3.client("sts", region_name=region).assume_role(
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
        # Expected assume failure: role not yet provisioned, AccessDenied,
        # transient STS error. Fail open so Bedrock keeps working on the
        # compute role; spend for this task is untagged.
        _warn(
            f"assume_role failed ({type(exc).__name__}: {exc}); using ambient creds "
            "— Bedrock spend will be UNTAGGED"
        )
        return _ambient_credentials()
    except Exception as exc:
        # Anything else (unexpected STS response shape, a logic bug here) is NOT
        # the expected fallback. Still fail open — this is a billing control, not
        # isolation — but flag it distinctly so it isn't mistaken for AccessDenied.
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
