import os

import pytest

import hooks
from aws_session import SESSION_ROLE_ARN_ENV, is_scoped

os.environ[SESSION_ROLE_ARN_ENV] = "arn:aws:iam::123456789012:role/leaked-from-parent-env"


def test_conftest_scrubs_session_role_arn():
    assert os.environ.get(SESSION_ROLE_ARN_ENV) is None


def test_session_resolves_unscoped_when_scrubbed():
    assert is_scoped() is False


@pytest.fixture(scope="module")
def _latched_blocker():
    hooks._record_blocker_reason("egress_denied", "left over from an earlier test", "github.com")


def test_conftest_clears_the_blocker_latch(_latched_blocker):
    assert hooks.last_blocker_reason() is None
