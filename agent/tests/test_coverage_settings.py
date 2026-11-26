"""
By default coverage.py leaves out every line that carries ``# pragma: no cover``,
with the block it opens, and excuses every branch marked ``# pragma: no branch``.
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
    # coverage.py creates its data file for an analysis, even with no run recorded.
    settings = coverage.Coverage(config_file=str(_PYPROJECT), data_file=str(tmp_path / "data"))

    _, statements, excluded, _, _ = settings.analysis2(str(sample))

    assert excluded == [3, 4, 10]
    assert {13, 14, 17, 18, 21, 22} <= set(statements)
    assert settings.get_option("report:partial_branches") == []
