"""The diagnostics under ``scripts/diagnostics``: the exit status follows the verdict.

Both scripts are run by hand when a deployed agent yields no messages, and what
they answer decides where the search goes next. Each test runs a script the way
the shell does, as ``__main__``, with the one thing it reaches outside the process
replaced: the SDK client that would start the Claude Code CLI, or the child
process whose output it reads. No CLI is started and nothing is sent to Bedrock.
"""

import asyncio
import runpy
import shutil
from pathlib import Path

import claude_agent_sdk
import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock

_DIAGNOSTICS = Path(__file__).resolve().parents[1] / "scripts" / "diagnostics"

# What the CLI reports when the account may not invoke the model.
_REFUSAL = (
    'API Error: 403 {"message":"You don\'t have access to the model with the specified model ID."}'
)


def _exit_status(script: str) -> int:
    """Run a diagnostic as ``python <script>`` would and return its exit status."""
    try:
        runpy.run_path(str(_DIAGNOSTICS / script), run_name="__main__")
    except SystemExit as exit_:
        return int(exit_.code or 0)
    return 0


def _sdk_smoke(monkeypatch, *messages) -> int:
    """Exit status of the SDK smoke test when the CLI yields ``messages``."""

    class Client:
        def __init__(self, options):
            pass

        async def connect(self):
            pass

        async def query(self, prompt):
            pass

        async def receive_response(self):
            for message in messages:
                yield message

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("ANTHROPIC_MODEL", "global.anthropic.claude-opus-5-5")
    # The script sets this itself when it is missing; set here, it is removed again.
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    return _exit_status("test_sdk_smoke.py")


def _result(**fields) -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=1200,
        duration_api_ms=900,
        num_turns=1,
        session_id="session",
        **fields,
    )


def test_sdk_smoke_passes_when_the_model_answers(monkeypatch, capsys):
    status = _sdk_smoke(
        monkeypatch,
        SystemMessage(subtype="init", data={}),
        AssistantMessage(content=[TextBlock(text="Hello world")], model="claude-opus-5-5"),
        _result(is_error=False, result="Hello world"),
    )

    assert "PASS" in capsys.readouterr().out
    assert status == 0


def test_sdk_smoke_fails_when_the_model_call_is_rejected(monkeypatch, capsys):
    # The CLI does not raise: it hands the refusal over as an assistant message and
    # ends the run with a result of subtype "success" that is marked is_error.
    status = _sdk_smoke(
        monkeypatch,
        SystemMessage(subtype="init", data={}),
        AssistantMessage(
            content=[TextBlock(text=_REFUSAL)], model="<synthetic>", error="invalid_request"
        ),
        _result(is_error=True, result=_REFUSAL, api_error_status=403),
    )

    out = capsys.readouterr().out
    assert "PASS" not in out
    assert "FAIL" in out
    assert status == 1


class _Child:
    """In place of the child process: ``count`` JSON lines on stdout, then end of file."""

    def __init__(self, count: int) -> None:
        self._lines = [b'{"index": %d}\n' % index for index in range(count)]
        self.stdout = self

    async def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""

    async def wait(self) -> int:
        return 0


@pytest.mark.parametrize(
    ("read_in_thread", "expected_status"),
    [pytest.param(7, 0, id="complete"), pytest.param(3, 1, id="messages dropped")],
)
def test_subprocess_threading_exit_status_follows_the_threaded_read(
    monkeypatch, capsys, read_in_thread, expected_status
):
    # The script reads its child three times: in the main thread (the baseline), in a
    # background thread under asyncio.run(), and in one under run_coroutine_threadsafe().
    # The child writes seven messages.
    reads = iter([7, read_in_thread, 7])

    async def spawn(*_command, **_pipes):
        return _Child(next(reads))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(shutil, "which", lambda _name: None)  # leaves the Node.js half out

    status = _exit_status("test_subprocess_threading.py")

    out = capsys.readouterr().out
    assert f"{read_in_thread}/7" in out
    assert ("[FAIL]" in out) == (expected_status == 1)
    assert status == expected_status
