from __future__ import annotations

import pytest

import server

_SINKS = {
    "debug": lambda text: server._debug_cw(text, task_id="t-1"),
    "stdout-only": lambda text: server._aws_silent_log(text, tag="build-hook"),
    "warn": lambda text: server._warn_cw(text, task_id="t-1"),
}


@pytest.fixture(autouse=True)
def _no_log_group(monkeypatch):
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)


@pytest.mark.parametrize("sink", sorted(_SINKS))
class TestServerLogLinesAreRedacted:
    @pytest.mark.parametrize(
        "name",
        [
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "LINEAR_API_TOKEN",
            "JIRA_API_TOKEN",
            "JIRA_APP_ACTOR_SHARED_SECRET",
        ],
    )
    def test_value_of_a_credential_the_process_holds(self, monkeypatch, capfd, sink, name):
        monkeypatch.setenv(name, "made-up-value-0123456789")

        _SINKS[sink]("clone failed: made-up-value-0123456789 was refused")

        out = capfd.readouterr().out
        assert "made-up-value-0123456789" not in out
        assert "clone failed: " in out
        assert " was refused" in out

    def test_github_token_the_process_does_not_hold(self, capfd, sink):
        _SINKS[sink]("remote: ghu_abc123XYZ rejected")

        assert "remote: *** rejected" in capfd.readouterr().out
