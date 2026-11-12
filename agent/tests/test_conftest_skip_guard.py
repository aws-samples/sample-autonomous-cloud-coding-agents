"""Regression guard for the CI skip guard in ``conftest.py``.

This suite has no skipped test, so nothing in an ordinary run shows that the
guard works, or that it still understands the reports pytest hands it. These
tests run pytest on a throwaway module that skips in every way pytest offers,
with ``conftest.py`` loaded as it is for the real suite, and check the exit
status and what the run says.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent

_SKIPPING_TESTS = """
import pytest


def test_runs():
    assert True


@pytest.mark.skip(reason="skipped by a marker")
def test_marker():
    raise AssertionError("never runs")


def test_inside():
    pytest.skip("skipped from inside the test")


def test_inside_a_deleted_directory(tmp_path, monkeypatch):
    gone = tmp_path / "gone"
    gone.mkdir()
    monkeypatch.chdir(gone)
    gone.rmdir()
    pytest.skip("skipped where the working directory is gone")


@pytest.mark.xfail(reason="an expected failure is not a skip")
def test_expected_failure():
    raise AssertionError("fails, as expected")


@pytest.mark.xfail(run=False, reason="an expected failure that never runs is a skip")
def test_expected_failure_never_run():
    raise AssertionError("never runs")
"""

_SKIPPED_MODULE = """
import pytest

pytest.importorskip("a_module_that_is_not_installed")


def test_never_collected():
    assert True
"""


def _run_pytest(tmp_path: Path, *, ci: str | None) -> subprocess.CompletedProcess[str]:
    (tmp_path / "test_skipping.py").write_text(_SKIPPING_TESTS)
    (tmp_path / "test_skipped_module.py").write_text(_SKIPPED_MODULE)
    env = {name: value for name, value in os.environ.items() if name != "CI"}
    if ci is not None:
        env["CI"] = ci
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-c",
            "pyproject.toml",  # the suite's own settings, so `src` is importable
            "-p",
            "tests.conftest",  # the guard under test, for files outside tests/
            "-p",
            "no:cacheprovider",
            str(tmp_path),
        ],
        cwd=str(AGENT_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=110,
        check=False,
    )


def test_a_skip_fails_the_run_in_ci_and_is_named(tmp_path):
    proc = _run_pytest(tmp_path, ci="true")
    out = proc.stdout

    assert "1 passed, 4 skipped, 2 xfailed" in out, out + proc.stderr
    assert proc.returncode == 1, "every test passed or was skipped, yet the run must fail in CI"
    assert "Skip guard" in out
    # Each skip is listed with where it is and why, so that it can be acted on.
    where_and_why = r"test_skipping\.py:\d+: Skipped: skipped by a marker"
    assert re.search(rf"test_skipping\.py::test_marker — .*{where_and_why}", out), out
    assert "test_skipping.py::test_inside — " in out
    # Listing a skip must not need the working directory: the test may have deleted it.
    assert "test_skipping.py::test_inside_a_deleted_directory — " in out
    assert "test_skipped_module.py — " in out
    assert "could not import 'a_module_that_is_not_installed'" in out
    # An expected failure is an expectation, not a skip (and a stale one already fails) ...
    assert "test_expected_failure — " not in out
    # ... unless pytest is told not to run it: that test can never be found stale.
    assert "test_skipping.py::test_expected_failure_never_run — [NOTRUN] " in out


def test_outside_ci_a_skip_stays_a_skip(tmp_path):
    proc = _run_pytest(tmp_path, ci=None)

    assert "1 passed, 4 skipped, 2 xfailed" in proc.stdout, proc.stdout + proc.stderr
    assert proc.returncode == 0
    assert "Skip guard" not in proc.stdout
