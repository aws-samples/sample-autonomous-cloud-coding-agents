from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

from workflow import load_workflow_file, validate_workflow

_WORKFLOWS_ROOT = (Path(os.path.dirname(__file__)) / ".." / "workflows").resolve()


def _workflow_files() -> list[Path]:
    if not _WORKFLOWS_ROOT.is_dir():
        return []
    return sorted(
        p
        for p in _WORKFLOWS_ROOT.rglob("*.yaml")
        if "schema" not in p.relative_to(_WORKFLOWS_ROOT).parts
    )


_FILES = _workflow_files()


@pytest.mark.parametrize("path", _FILES, ids=[str(p.name) for p in _FILES])
def test_first_party_workflow_validates(path: Path) -> None:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    violations = validate_workflow(data)
    assert violations == [], f"committed workflow {path} fails validation: {violations}"
    load_workflow_file(path)


def test_first_party_workflow_path_matches_id() -> None:
    assert _FILES, f"no workflow file found under {_WORKFLOWS_ROOT}: nothing was validated"
    for path in _FILES:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        rel = path.relative_to(_WORKFLOWS_ROOT).with_suffix("")
        assert data.get("id") == str(rel), (
            f"{path}: declared id {data.get('id')!r} does not match path-derived id {str(rel)!r}"
        )
