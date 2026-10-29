"""Exercise server fixture teardown through a real, isolated pytest run."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path


def test_pipeline_finishes_before_test_mocks_and_environment_are_restored(tmp_path: Path):
    """Force a pipeline to resolve run_task only when fixture teardown joins it."""
    test_file = tmp_path / "test_fixture_order.py"
    test_file.write_text(
        textwrap.dedent(
            """
            import os
            import threading
            from unittest.mock import MagicMock

            import server
            from test_server import env_guard, reset_server_state

            release = threading.Event()
            entered = threading.Event()
            first_run = MagicMock()
            observed_env = []
            pipeline = None
            original_join = None

            def test_first(monkeypatch, env_guard):
                global pipeline, original_join
                os.environ["ABCA_TEST_THREAD_ORIGIN"] = "first-test"
                monkeypatch.setattr(server, "_debug_cw", lambda *a, **kw: None)
                monkeypatch.setattr(server, "run_task", first_run)

                def delayed_lookup(**kwargs):
                    entered.set()
                    if release.wait(timeout=10):
                        observed_env.append(os.environ.get("ABCA_TEST_THREAD_ORIGIN"))
                        server.run_task(**kwargs)

                monkeypatch.setattr(server, "_run_task_background", delayed_lookup)
                pipeline = server._spawn_background({"task_id": "fixture-first"})
                assert entered.wait(timeout=5)
                original_join = pipeline.join

                def join_and_release(timeout=None):
                    release.set()
                    original_join(timeout=timeout)

                # Teardown must use this test's join and run_task before monkeypatch
                # restores either. No timing-dependent sleep is needed.
                monkeypatch.setattr(pipeline, "join", join_and_release)

            def test_second(monkeypatch):
                next_run = MagicMock()
                monkeypatch.setattr(server, "run_task", next_run)
                try:
                    assert not pipeline.is_alive(), "prior test leaked a live pipeline"
                    first_run.assert_called_once_with(task_id="fixture-first")
                    assert observed_env == ["first-test"]
                    assert "ABCA_TEST_THREAD_ORIGIN" not in os.environ
                    assert server._active_threads == []
                finally:
                    # Also reap the deliberately blocked worker when testing the
                    # broken fixture, without ever invoking the real pipeline.
                    release.set()
                    original_join(timeout=5)
                next_run.assert_not_called()
            """
        )
    )
    agent_dir = Path(__file__).resolve().parents[1]
    env: dict[str, str] = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join((str(agent_dir / "src"), str(agent_dir / "tests")))
    env.pop("ABCA_TEST_THREAD_ORIGIN", None)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "--no-cov",
            "-c",
            str(agent_dir / "pyproject.toml"),
            str(test_file),
        ],
        cwd=agent_dir,
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "2 passed" in result.stdout
