# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for the Bedrock credential helper (#215, cost attribution).

The helper feeds Claude Code's ``awsCredentialExport``: it assumes the per-task
SessionRole with ``{user_id, repo, task_id}`` STS tags so Bedrock spend is
attributable, and **fails open** to ambient credentials when attribution is not
configured or the assume fails — losing chargeback granularity is not a security
incident, unlike the fail-closed tenant-data path in ``aws_session``.
"""

from __future__ import annotations

import datetime
import json
import os
import stat
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import bedrock_creds_helper as helper
from aws_session import build_session_tags


@pytest.fixture
def attr_file(tmp_path, monkeypatch):
    path = str(tmp_path / "attr.json")
    monkeypatch.setenv(helper.ATTRIBUTION_FILE_ENV, path)
    return path


def test_write_attribution_file_is_0600(attr_file):
    tags = build_session_tags("u1", "owner/repo", "task123")
    written = helper.write_attribution_file("arn:aws:iam::1:role/SR", tags, attr_file)
    assert written == attr_file
    mode = stat.S_IMODE(os.stat(attr_file).st_mode)
    assert mode == 0o600, f"attribution file must be 0600, got {oct(mode)}"
    with open(attr_file) as fh:
        saved = json.load(fh)
    assert saved["role_arn"] == "arn:aws:iam::1:role/SR"
    assert {"Key": "task_id", "Value": "task123"} in saved["tags"]


def test_resolve_assumes_role_with_session_tags(attr_file):
    tags = build_session_tags("u1", "owner/repo", "task123")
    helper.write_attribution_file("arn:aws:iam::1:role/SR", tags, attr_file)

    expiry = datetime.datetime(2026, 1, 1, tzinfo=datetime.UTC)
    sts = MagicMock()
    sts.assume_role.return_value = {
        "Credentials": {
            "AccessKeyId": "AK",
            "SecretAccessKey": "SK",
            "SessionToken": "TK",
            "Expiration": expiry,
        }
    }
    with patch("boto3.client", return_value=sts):
        creds = helper.resolve_credentials()

    # The assume carried exactly the tenant tags, and a tagged session name.
    _, kwargs = sts.assume_role.call_args
    assert kwargs["Tags"] == tags
    assert kwargs["RoleArn"] == "arn:aws:iam::1:role/SR"
    assert kwargs["RoleSessionName"].startswith("abca-bedrock-task123")
    assert creds == {
        "AccessKeyId": "AK",
        "SecretAccessKey": "SK",
        "SessionToken": "TK",
        "Expiration": expiry.isoformat(),
    }


def test_resolve_fails_open_when_no_attribution_file(attr_file):
    # File never written → fall back to ambient creds, never raise.
    frozen = SimpleNamespace(access_key="AMB", secret_key="S", token="T")
    ambient = MagicMock()
    ambient.get_credentials.return_value.get_frozen_credentials.return_value = frozen
    with patch("botocore.session.get_session", return_value=ambient):
        creds = helper.resolve_credentials()
    assert creds["AccessKeyId"] == "AMB"
    assert "Expiration" not in creds  # ambient creds are returned unbounded


def _ambient(access_key="AMB"):
    frozen = SimpleNamespace(access_key=access_key, secret_key="S", token="T")
    ambient = MagicMock()
    ambient.get_credentials.return_value.get_frozen_credentials.return_value = frozen
    return ambient


def test_resolve_fails_open_on_expected_assume_error_and_warns(attr_file, capsys):
    from botocore.exceptions import ClientError

    helper.write_attribution_file(
        "arn:aws:iam::1:role/SR", build_session_tags("u", "r", "t"), attr_file
    )
    sts = MagicMock()
    sts.assume_role.side_effect = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "denied"}}, "AssumeRole"
    )
    with (
        patch("boto3.client", return_value=sts),
        patch("botocore.session.get_session", return_value=_ambient()),
    ):
        creds = helper.resolve_credentials()
    assert creds["AccessKeyId"] == "AMB"
    # Fail-open must be observable, and flagged as the expected (not unexpected) case.
    err = capsys.readouterr().err
    assert "assume_role failed" in err and "UNTAGGED" in err
    assert "UNEXPECTED" not in err


def test_resolve_flags_unexpected_error_distinctly(attr_file, capsys):
    # A non-boto error (e.g. a logic bug, bad STS response shape) must still
    # fail open but be labeled UNEXPECTED so it isn't mistaken for AccessDenied.
    helper.write_attribution_file(
        "arn:aws:iam::1:role/SR", build_session_tags("u", "r", "t"), attr_file
    )
    sts = MagicMock()
    sts.assume_role.side_effect = RuntimeError("boom")
    with (
        patch("boto3.client", return_value=sts),
        patch("botocore.session.get_session", return_value=_ambient()),
    ):
        creds = helper.resolve_credentials()
    assert creds["AccessKeyId"] == "AMB"
    assert "UNEXPECTED" in capsys.readouterr().err


def test_resolve_distinguishes_corrupt_config_from_absent(attr_file, capsys):
    # File present but malformed → louder signal than a plain absent file.
    with open(attr_file, "w") as fh:
        fh.write("{not json")
    with patch("botocore.session.get_session", return_value=_ambient()):
        creds = helper.resolve_credentials()
    assert creds["AccessKeyId"] == "AMB"
    assert "present but unreadable" in capsys.readouterr().err


def test_resolve_emits_empty_when_no_credentials_at_all(attr_file, capsys):
    ambient = MagicMock()
    ambient.get_credentials.return_value = None
    with patch("botocore.session.get_session", return_value=ambient):
        creds = helper.resolve_credentials()
    # Empty object → Claude Code falls back to its own default-chain resolution.
    assert creds == {}
    assert "no resolvable AWS credentials" in capsys.readouterr().err


def test_main_emits_credentials_envelope(attr_file, capsys):
    with patch.object(helper, "resolve_credentials", return_value={"AccessKeyId": "X"}):
        rc = helper.main()
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out == {"Credentials": {"AccessKeyId": "X"}}
