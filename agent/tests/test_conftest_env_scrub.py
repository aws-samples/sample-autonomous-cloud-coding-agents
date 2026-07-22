"""Fixture-free regression guard for the ECS test-hang scrub (#615 / #616 B1).

This module deliberately has NO local autouse fixture. It exists to prove that
conftest's ``_clean_env`` autouse fixture strips ``AGENT_SESSION_ROLE_ARN`` from
the environment before each test — the exact line the #615 fix adds to
``_AGENT_ENV_VARS``.

Why a separate module: ``test_aws_session.py`` has its OWN autouse ``_reset``
fixture that does ``monkeypatch.delenv(SESSION_ROLE_ARN_ENV)``, so a guard placed
there passes even if the conftest scrub is deleted (it asserts what the local
fixture guarantees, not what the fix does — #616 review B1). Here, only conftest's
``_clean_env`` is in play.

Why set the var at MODULE IMPORT time (not in the test body): pytest autouse
fixtures run during test *setup*, before the body executes — so a
``monkeypatch.setenv`` inside the test can't be scrubbed by them. Poisoning the
process env at import time (before any fixture runs) means the conftest scrub is
the only thing that can clear it by the time a test body reads it. Remove the
``AGENT_SESSION_ROLE_ARN`` line from conftest's ``_AGENT_ENV_VARS`` and BOTH tests
below fail — a true bidirectional guard.

The bug this guards: with ``AGENT_SESSION_ROLE_ARN`` set, ``aws_session``
resolves a *scoped* session and ``tenant_client`` returns ``session.client(...)``,
bypassing a ``@patch("boto3.client")`` mock. A mocked test (e.g.
``test_attachments``) then makes a REAL S3 call that hangs forever on the ECS
network (no egress) in a socket read SIGALRM can't interrupt — stalling the whole
``mise run build``.
"""

import os

from aws_session import SESSION_ROLE_ARN_ENV, is_scoped

# Poison the process env at import time — BEFORE any fixture runs. The conftest
# `_clean_env` autouse must scrub this for the assertions below to hold.
os.environ[SESSION_ROLE_ARN_ENV] = "arn:aws:iam::123456789012:role/leaked-from-parent-env"


def test_conftest_scrubs_session_role_arn():
    # If conftest's _clean_env strips AGENT_SESSION_ROLE_ARN, it is gone here even
    # though the module poisoned it at import time. If the scrub line is removed,
    # this fails — the guard the #615 fix actually needs.
    assert os.environ.get(SESSION_ROLE_ARN_ENV) is None


def test_session_resolves_unscoped_when_scrubbed():
    # With the var scrubbed (and the cache reset, both by conftest _clean_env) a
    # bare get_session() must be unscoped — the path where boto3.client mocks
    # intercept, so no real S3 call is made and nothing hangs.
    assert is_scoped() is False
