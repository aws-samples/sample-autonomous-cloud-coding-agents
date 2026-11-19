"""Regression guards for the session-wide AWS isolation in ``conftest.py``.

Neither half can be shown by an ordinary test:

* the credential scrub — wherever this suite normally runs there is nothing to
  scrub, so deleting it would change nothing. The first test hands a fresh
  interpreter every credential source botocore knows and asks botocore what it
  finds once ``tests.conftest`` is imported;
* the send guard — it only acts when a request is attempted, so the other tests
  each attempt one and check what the guard does with it.

Every credential here is an obvious fake, and the requests this module attempts
on purpose are aimed at a closed local port, so they cannot reach AWS even if the
guard under test is broken.
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import boto3
import pytest

from tests import conftest

AGENT_DIR = Path(__file__).resolve().parent.parent
FAKE_KEY = "AKIAFAKEFAKEFAKEFAKE"
CLOSED_PORT = "http://127.0.0.1:9"

_PROBE = """
import json, os, sys

import tests.conftest  # the import under test: it must leave botocore nothing to find
import botocore.session

try:
    credentials = botocore.session.get_session().get_credentials()
    found = credentials.method if credentials else None
except Exception as exc:  # a lookup that had to be refused, or that tripped over a leftover
    found = f"{type(exc).__name__}: {exc}"
inherited = json.loads(sys.argv[1])
print(json.dumps({
    "found": found,
    "inherited": sorted(name for name, value in inherited.items() if os.environ.get(name) == value),
}))
"""


def test_no_credential_source_survives_importing_conftest(tmp_path):
    keys = f"aws_access_key_id = {FAKE_KEY}\naws_secret_access_key = fake\n"
    shared = tmp_path / "shared"
    shared.write_text(f"[default]\n{keys}")
    boto2 = tmp_path / "boto2"
    boto2.write_text(f"[Credentials]\n{keys}")
    legacy = tmp_path / "legacy"
    legacy.write_text(f"AWSAccessKeyId={FAKE_KEY}\nAWSSecretKey=fake\n")
    token = tmp_path / "token"
    token.write_text("not-a-token")
    # The files botocore reads when no variable names another one. A CI runner has
    # no ~/.aws and no ~/.boto, so without a home directory that holds them nothing
    # would show that conftest.py pins the file variables instead of only removing
    # them.
    home = tmp_path / "home"
    (home / ".aws").mkdir(parents=True)
    (home / ".aws" / "credentials").write_text(f"[default]\n{keys}")
    (home / ".aws" / "config").write_text(f"[default]\n{keys}")
    (home / ".boto").write_text(f"[Credentials]\n{keys}")

    sources = {
        "AWS_ACCESS_KEY_ID": FAKE_KEY,
        "AWS_SECRET_ACCESS_KEY": "fake",
        "AWS_SESSION_TOKEN": "fake",
        "AWS_SECURITY_TOKEN": "fake",
        "AWS_BEARER_TOKEN_BEDROCK": "fake",
        "AWS_PROFILE": "default",
        "AWS_DEFAULT_PROFILE": "default",
        "AWS_CONFIG_FILE": str(shared),
        "AWS_SHARED_CREDENTIALS_FILE": str(shared),
        "BOTO_CONFIG": str(boto2),
        "AWS_CREDENTIAL_FILE": str(legacy),
        "AWS_WEB_IDENTITY_TOKEN_FILE": str(token),
        "AWS_ROLE_ARN": "arn:aws:iam::123456789012:role/not-a-role",
        "AWS_ROLE_SESSION_NAME": "not-a-session",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI": f"{CLOSED_PORT}/credentials",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/credentials",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN": "fake",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": str(token),
        "AWS_EC2_METADATA_DISABLED": "false",
    }
    hostile: dict[str, str] = {
        **os.environ,
        **sources,
        "HOME": str(home),
        "PYTHONPATH": str(AGENT_DIR / "src"),
        "AWS_EC2_METADATA_SERVICE_ENDPOINT": CLOSED_PORT,
    }

    proc = subprocess.run(
        [sys.executable, "-c", _PROBE, json.dumps(sources)],
        cwd=str(AGENT_DIR),
        env=hostile,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    seen = json.loads(proc.stdout.splitlines()[-1])

    fix = " — tests/conftest.py must remove or pin it at import; see the AWS isolation block."
    assert seen["inherited"] == [], f"inherited AWS settings survived: {seen['inherited']}" + fix
    assert seen["found"] is None, f"botocore resolved credentials through: {seen['found']}" + fix


def _client_aimed_at_a_closed_port():
    return boto3.client(
        "sts",
        region_name="us-east-1",
        endpoint_url=CLOSED_PORT,
        aws_access_key_id=FAKE_KEY,
        aws_secret_access_key="fake",
    )


def test_a_request_to_aws_is_refused_recorded_and_fails_the_session(monkeypatch):
    # This test attempts a request on purpose: keep it out of the real session's record.
    monkeypatch.setattr(conftest, "_blocked_aws_requests", [])
    client = _client_aimed_at_a_closed_port()

    with pytest.raises(RuntimeError, match="unit tests must not reach AWS"):
        client.get_caller_identity()

    [attempt] = conftest._blocked_aws_requests  # exactly one: refused, not retried
    assert attempt.startswith(f"POST {CLOSED_PORT}/ from ")
    assert f"{Path(__file__).name}:" in attempt, "the report must name the line that sent"
    assert "test_a_request_to_aws_is_refused" in attempt, "…and the test that was running"

    # Code under test usually swallows the refusal and its test stays green, so the
    # attempt has to fail the session through the exit status, and say why.
    monkeypatch.setattr(conftest, "_hang_watchdog", SimpleNamespace(cancel=lambda: None))
    session = SimpleNamespace(exitstatus=pytest.ExitCode.OK)
    conftest.pytest_sessionfinish(session, pytest.ExitCode.OK)
    assert session.exitstatus == pytest.ExitCode.TESTS_FAILED

    report: list[str] = []
    conftest.pytest_terminal_summary(
        SimpleNamespace(section=lambda title, **_markup: report.append(title), line=report.append)
    )
    assert f"  {attempt}" in report


def test_a_request_from_a_deleted_working_directory_is_recorded_too(tmp_path, monkeypatch):
    # A test may delete the directory it works in. The guard must not need that
    # directory to describe an attempt: one it fails to describe is one it does not
    # record, and a session whose code under test swallowed the error would pass.
    recorded: list[str] = []
    monkeypatch.setattr(conftest, "_blocked_aws_requests", recorded)
    client = _client_aimed_at_a_closed_port()
    gone = tmp_path / "gone"
    gone.mkdir()
    monkeypatch.chdir(gone)
    gone.rmdir()

    try:
        with pytest.raises(RuntimeError, match="unit tests must not reach AWS"):
            client.get_caller_identity()
    finally:
        monkeypatch.chdir(tmp_path)  # an existing directory again, before anything is reported

    assert len(recorded) == 1, recorded
    assert f"{Path(__file__).name}:" in recorded[0], "the report must name the line that sent"


def test_only_the_configured_dynamodb_local_origin_is_let_through(monkeypatch):
    # CI names a loopback DynamoDB Local in ABCA_DDB_LOCAL_ENDPOINT for the MicroVM
    # checkpoint transaction tests. That exact origin reaches the real transport;
    # the same host on another port is still refused and recorded.
    recorded: list[str] = []
    monkeypatch.setattr(conftest, "_blocked_aws_requests", recorded)
    sent: list[str] = []
    monkeypatch.setattr(conftest, "_real_send", lambda _self, request: sent.append(request.url))
    monkeypatch.setattr(conftest, "_DYNAMODB_LOCAL_ORIGIN", "http://127.0.0.1:8000")

    allowed = SimpleNamespace(method="POST", url="http://127.0.0.1:8000/")
    conftest._refuse_aws_request(None, allowed)
    assert sent == ["http://127.0.0.1:8000/"]

    for url in ("http://127.0.0.1:8001/", "https://127.0.0.1:8000/", "http://localhost:8000/"):
        with pytest.raises(RuntimeError, match="unit tests must not reach AWS"):
            conftest._refuse_aws_request(None, SimpleNamespace(method="POST", url=url))
    assert len(recorded) == 3, recorded
    assert sent == ["http://127.0.0.1:8000/"]


@pytest.mark.parametrize(
    "endpoint",
    [
        "",
        "http://localhost:8000",
        "https://127.0.0.1:8000",
        "http://127.0.0.1",
        "http://10.0.0.1:8000",
        "http://127.0.0.1:8000/path",
        "http://user@127.0.0.1:8000",
        "http://127.0.0.1:notaport",
    ],
)
def test_no_other_endpoint_value_creates_an_exemption(endpoint):
    assert conftest._loopback_origin(endpoint) is None


def test_the_loopback_dynamodb_local_endpoint_is_recognised():
    assert conftest._loopback_origin("http://127.0.0.1:8000") == "http://127.0.0.1:8000"
    assert conftest._loopback_origin("http://127.0.0.1:32768/") == "http://127.0.0.1:32768"
