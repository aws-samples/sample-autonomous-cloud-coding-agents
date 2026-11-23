"""What the coverage floor measures: no comment takes code out of it.

By default coverage.py leaves out every line that carries ``# pragma: no cover``,
with the block it opens, and excuses every branch marked ``# pragma: no branch``.
One comment on a ``def`` line took a function out of what ``fail_under`` measures,
with no gate to refuse it. ``[tool.coverage.report]`` in ``pyproject.toml``
replaces both lists. This reads a sample through coverage.py with that table, the
way the report of the test task reads ``src/``.
"""

from pathlib import Path

import coverage

_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"

_SAMPLE = '''\
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable


class Reader(Protocol):
    def read(self) -> str:
        """Return the text."""
        ...


def marked():  # pragma: no cover
    return 1


def disguised():  # if TYPE_CHECKING:
    return 2


def dotted():  # ...
    return 3
'''


def test_only_code_that_cannot_run_is_left_out_of_the_measurement(tmp_path):
    sample = tmp_path / "sample.py"
    sample.write_text(_SAMPLE, encoding="utf-8")
    # No run is recorded here. coverage.py still wants a data file for an analysis.
    settings = coverage.Coverage(config_file=str(_PYPROJECT), data_file=str(tmp_path / "data"))

    _, statements, excluded, _, _ = settings.analysis2(str(sample))

    # Left out: the type-only import (lines 3 and 4) and the body of the stub (line 10).
    assert excluded == [3, 4, 10]
    # Counted: the function behind the pragma (13, 14), the one behind a comment that
    # imitates the type-only import (17, 18) and the one behind a comment that
    # imitates a stub body (21, 22).
    assert {13, 14, 17, 18, 21, 22} <= set(statements)
    assert settings.get_option("report:partial_branches") == []
