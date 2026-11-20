"""The DynamoDB Local helpers, run with an ``aws`` stand-in first on PATH.

``mise //agent:local:up`` creates the tables with ``scripts/create-local-tables.sh``
and ``mise //agent:local:events`` reads the progress events back. Both call the AWS
CLI and have to work with either major version of it. ``--no-cli-pager`` is a flag
of v2 that v1 refuses before it sends anything, so the stand-in refuses it too. The
AWS CLI of the machine is not called and nothing has to listen on the endpoint.
"""

import os
import subprocess
import tomllib
from pathlib import Path

import pytest

_AGENT = Path(__file__).resolve().parents[1]

_AWS = """\
#!/usr/bin/env bash
for argument in "$@"; do
  if [ "$argument" = --no-cli-pager ]; then
    echo "Unknown options: --no-cli-pager" >&2
    exit 255
  fi
done
case "$2" in
  describe-table) exit 255 ;; # the table does not exist yet
  create-table) echo "$4" >> "$CREATED" ;; # the name that follows --table-name
  scan) echo "events pager=[${AWS_PAGER-not set}]" ;;
esac
"""


def _run(tmp_path, *command) -> subprocess.CompletedProcess[str]:
    (tmp_path / "aws").write_text(_AWS, encoding="utf-8")
    (tmp_path / "aws").chmod(0o755)
    return subprocess.run(
        command,
        env={
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "CREATED": str(tmp_path / "created"),
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


def test_tables_are_created_by_an_aws_cli_without_the_pager_flag(tmp_path):
    run = _run(tmp_path, "bash", str(_AGENT / "scripts" / "create-local-tables.sh"))

    assert run.returncode == 0, run.stderr
    assert (tmp_path / "created").read_text(encoding="utf-8").split() == [
        "TaskEventsTable",
        "TaskTable",
    ]


@pytest.mark.parametrize("task", ["local:events", "local:events:json"])
def test_events_are_printed_by_an_aws_cli_without_the_pager_flag(tmp_path, task):
    tasks = tomllib.loads((_AGENT / "mise.toml").read_text(encoding="utf-8"))["tasks"]

    run = _run(tmp_path, "sh", "-c", tasks[task]["run"])

    # An empty AWS_PAGER is what keeps AWS CLI v2 from opening a pager; v1 has none.
    assert run.stdout == "events pager=[]\n"
