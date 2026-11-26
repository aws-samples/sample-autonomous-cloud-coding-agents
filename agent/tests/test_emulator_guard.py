"""``tests_emulator/conftest.py`` installs an audit hook on import, and Python cannot
remove an audit hook: every case imports it in a fresh interpreter, never in this process.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent
WRAPPER_ENVIRONMENT = {
    "AWS_ENDPOINT_URL": "https://127.0.0.1:1",
    "AWS_SHARED_CREDENTIALS_FILE": "/nonexistent/emulator_credentials",
    "AWS_CONFIG_FILE": "/nonexistent/config",
    "AWS_CA_BUNDLE": "/nonexistent/ca.pem",
    "AWS_EC2_METADATA_DISABLED": "true",
    "AWS_DISABLE_HOST_PREFIX_INJECTION": "true",
    "AWS_REGION": "us-east-1",
    "AWS_DEFAULT_REGION": "us-east-1",
}
REFUSED_ENDPOINTS = [
    "http://127.0.0.1:1",
    "https://localhost:1",
    "https://127.0.0.2:1",
    "https://127.0.0.1:1@outside.invalid",
    "https://outside.invalid/https://127.0.0.1:1",
]
REFUSED_STRAYS = [
    "AWS_PROFILE",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_SDK_UA_APP_ID",
]

_NUMERIC_ONLY = """
import socket, sys

_getaddrinfo = socket.getaddrinfo


def _numeric_only(host, port, family=0, type=0, proto=0, flags=0):
    return _getaddrinfo(host, port, family, type, proto, flags | socket.AI_NUMERICHOST)


socket.getaddrinfo = _numeric_only
"""

_PROBE = """
import json, os

import tests_emulator.conftest as guard  # the import under test: it installs the audit hook


def reason(variables):
    for name in [name for name in os.environ if name.startswith("AWS_")]:
        del os.environ[name]
    os.environ.update(variables)
    return guard._why_not_an_emulator()


def outcome(attempt):
    try:
        attempt()
    except PermissionError as exc:
        return f"refused: {exc}"
    except OSError as exc:
        return f"not refused ({type(exc).__name__})"
    return "not refused"


def connect(address):
    with socket.socket() as tcp:
        tcp.settimeout(1)
        tcp.connect(address)


OTHER = ("127.0.0.2", 9)
with socket.socket() as listener, socket.socket(type=socket.SOCK_DGRAM) as udp:
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    print(json.dumps({
        "reasons": [reason(variables) for variables in json.loads(sys.argv[1])],
        "getaddrinfo": outcome(lambda: socket.getaddrinfo("outside.invalid", 443)),
        "gethostbyname": outcome(lambda: socket.gethostbyname(OTHER[0])),
        "connect": outcome(lambda: connect(OTHER)),
        "sendto": outcome(lambda: udp.sendto(b"x", OTHER)),
        "sendmsg": outcome(lambda: udp.sendmsg([b"x"], [], 0, OTHER)),
        "loopback": outcome(lambda: connect(listener.getsockname())),
    }))
"""

_PYTEST = """
import pytest

sys.exit(pytest.main(sys.argv[1:]))
"""

_NO_AUDIT_HOOK = """
sys.addaudithook = lambda hook: None
"""


def _run(
    code: str, args: list[str], home: Path, variables: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", _NUMERIC_ONLY + code, *args],
        cwd=str(AGENT_DIR),
        env={"HOME": str(home), **variables},
        capture_output=True,
        text=True,
        timeout=100,
        check=False,
    )


def test_the_environment_check_and_the_audit_hook_refuse(tmp_path):
    refused = [
        ({}, "(it is '')"),
        *(({"AWS_ENDPOINT_URL": url}, f"(it is {url!r})") for url in REFUSED_ENDPOINTS),
        *(({**WRAPPER_ENVIRONMENT, name: "x"}, f"environment: {name}") for name in REFUSED_STRAYS),
    ]
    environments = [WRAPPER_ENVIRONMENT, *(variables for variables, _ in refused)]

    proc = _run(_PROBE, [json.dumps(environments)], tmp_path, {})

    assert proc.returncode == 0, proc.stderr
    seen = json.loads(proc.stdout.splitlines()[-1])
    accepted, *reasons = seen["reasons"]
    assert accepted is None, "the wrapper's own environment must be accepted"
    for reason, (variables, expected) in zip(reasons, refused, strict=True):
        assert expected in (reason or ""), f"must refuse {variables}"
    leaves = "must not open a connection that leaves this machine, and this one tried to reach"
    assert f"{leaves} 'outside.invalid'" in seen["getaddrinfo"]
    for attempt in ("gethostbyname", "connect", "sendto", "sendmsg"):
        assert f"{leaves} '127.0.0.2'" in seen[attempt], attempt
    assert seen["loopback"] == "not refused"


def test_no_emulator_test_runs_in_a_shell_without_the_emulator_environment(tmp_path):
    args = ["--no-cov", "-p", "no:cacheprovider", "-q", "tests_emulator"]

    proc = _run(_PYTEST, args, tmp_path, {})

    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "must be https://127.0.0.1:<port> (it is '')" in proc.stdout, proc.stdout
    summary = proc.stdout.splitlines()[-1]
    assert not re.search(r" (passed|skipped|failed)", summary), summary


def _run_a_test_that_asks_for_no_fixture(home: Path, code: str) -> subprocess.CompletedProcess[str]:
    (home / "test_asks_for_nothing.py").write_text("def test_asks_for_nothing():\n    pass\n")
    args = ["-c", "pyproject.toml", "-p", "tests_emulator.conftest", "-p", "no:cacheprovider", "-q"]
    return _run(code, [*args, "--noconftest", str(home)], home, WRAPPER_ENVIRONMENT)


def test_a_test_that_asks_for_no_fixture_is_stopped_when_the_emulator_does_not_answer(tmp_path):
    proc = _run_a_test_that_asks_for_no_fixture(tmp_path, _PYTEST)

    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "https://127.0.0.1:1 is set but did not answer STS" in proc.stdout, proc.stdout


def test_a_test_that_asks_for_no_fixture_is_stopped_when_the_audit_hook_is_not_in_force(tmp_path):
    proc = _run_a_test_that_asks_for_no_fixture(tmp_path, _NO_AUDIT_HOOK + _PYTEST)

    assert proc.returncode == 1, proc.stdout + proc.stderr
    refusal = "the loopback-only audit hook did not refuse a name lookup"
    assert f"\n{refusal}\n" in proc.stdout, proc.stdout
