"""Regression guards for the refusals of the emulator suite (``tests_emulator/conftest.py``).

The emulator tests make real AWS SDK calls. Three things in their conftest stand
between them and a real account: ``_why_not_an_emulator`` (the environment), the
audit hook ``_refuse_non_loopback`` (anything that would leave the machine) and the
``emulator`` fixture, which every test depends on and which fails the test before
anything is created. A guard that stops refusing lets every emulator test pass, so
the refusals are made to happen here. Two of the fixture's are not: SDK clients that
resolve to another endpoint, and an STS answer from another account. Both need more
than a loopback port that nothing listens on.

That conftest installs its audit hook when it is imported, and an audit hook cannot
be removed again, so it is never imported into this process: every case runs in a
fresh interpreter. Its whole environment is an empty home directory and what the
case names: the shell that started pytest may export a real profile. Nothing here
can leave the machine even if the guard under test is broken: there are no
credentials, the endpoint is a loopback port that nothing listens on, the one other
address is 127.0.0.2, and no resolver is asked about a name (``_NUMERIC_ONLY``).

No emulator is needed, which is why this is part of the unit suite. The accepting
path is exercised by every ``mise run test:integration``.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent
# What scripts/aws-emulator/emulator.sh sets, and the only AWS variables the guard accepts.
# Nothing listens on port 1.
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
    "http://127.0.0.1:1",  # not TLS
    "https://localhost:1",  # a name, not the address
    "https://127.0.0.2:1",  # another address
    "https://127.0.0.1:1@outside.invalid",  # only begins like the emulator's
    "https://outside.invalid/https://127.0.0.1:1",  # only ends like it
]
REFUSED_STRAYS = [
    "AWS_PROFILE",  # a source of credentials
    "AWS_ENDPOINT_URL_DYNAMODB",  # begins like an accepted name, and sends one service elsewhere
    "AWS_SDK_UA_APP_ID",  # harmless in itself: whatever the wrapper does not set is refused
]

# How every child starts: names are resolved numerically only. The audit event the hook
# listens for is raised all the same, but no resolver is asked, whatever the hook does.
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

# In a child that starts with this, the conftest's call installs no audit hook.
_NO_AUDIT_HOOK = """
sys.addaudithook = lambda hook: None
"""


def _run(
    code: str, args: list[str], home: Path, variables: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    """Run ``code`` in a fresh interpreter in ``agent/``, with ``home`` and ``variables`` only."""
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
    # Loopback stays open: that is where the emulator is.
    assert seen["loopback"] == "not refused"


def test_no_emulator_test_runs_in_a_shell_without_the_emulator_environment(tmp_path):
    # As `mise run test:integration` runs the suite; no cache, so that this run leaves no trace.
    args = ["--no-cov", "-p", "no:cacheprovider", "-q", "tests_emulator"]

    proc = _run(_PYTEST, args, tmp_path, {})

    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "must be https://127.0.0.1:<port> (it is '')" in proc.stdout, proc.stdout
    # Errors only: no skip path, and no test that gets as far as its body.
    summary = proc.stdout.splitlines()[-1]
    assert not re.search(r" (passed|skipped|failed)", summary), summary


def _run_a_test_that_asks_for_no_fixture(home: Path, code: str) -> subprocess.CompletedProcess[str]:
    """Run ``code``, which ends in ``_PYTEST``, on one test that asks for no fixture."""
    (home / "test_asks_for_nothing.py").write_text("def test_asks_for_nothing():\n    pass\n")
    # That file is outside tests_emulator/, so the conftest is loaded as a plugin, with the
    # suite's own settings. --noconftest keeps out a conftest.py that happens to sit above
    # the temporary directory.
    args = ["-c", "pyproject.toml", "-p", "tests_emulator.conftest", "-p", "no:cacheprovider", "-q"]
    # What a stopped emulator leaves behind: its variables, but no files and no listener.
    return _run(code, [*args, "--noconftest", str(home)], home, WRAPPER_ENVIRONMENT)


def test_a_test_that_asks_for_no_fixture_is_stopped_when_the_emulator_does_not_answer(tmp_path):
    proc = _run_a_test_that_asks_for_no_fixture(tmp_path, _PYTEST)

    assert proc.returncode == 1, proc.stdout + proc.stderr
    # With the endpoint the conftest filled in: its own source, which pytest prints with an
    # error the fixture did not expect, must not pass for the refusal.
    assert "https://127.0.0.1:1 is set but did not answer STS" in proc.stdout, proc.stdout


def test_a_test_that_asks_for_no_fixture_is_stopped_when_the_audit_hook_is_not_in_force(tmp_path):
    proc = _run_a_test_that_asks_for_no_fixture(tmp_path, _NO_AUDIT_HOOK + _PYTEST)

    assert proc.returncode == 1, proc.stdout + proc.stderr
    # As a line of its own, which is how pytest reports the refusal: the conftest's source,
    # which it prints with an error the fixture did not expect, has the same words.
    refusal = "the loopback-only audit hook did not refuse a name lookup"
    assert f"\n{refusal}\n" in proc.stdout, proc.stdout
