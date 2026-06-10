"""CI gate: every committed first-party workflow file must validate.

Walks ``agent/workflows/**/*.yaml`` (excluding the schema dir) and runs each
through the loader + cross-field validator. A workflow file that ships in the
image but fails validation would be a latent runtime failure; this test is the
synth/CI gate WORKFLOWS.md §"Validation rules" calls for, enforced in the agent
test suite.

When no first-party workflows exist yet (early Phase 1), the test passes
vacuously but logs the count, so it starts guarding automatically as soon as
``coding/new-task-v1.yaml`` and friends land.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

from workflow import validate_workflow

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


@pytest.mark.skipif(not _FILES, reason="no first-party workflow files yet (early Phase 1)")
@pytest.mark.parametrize("path", _FILES, ids=[str(p.name) for p in _FILES])
def test_first_party_workflow_validates(path: Path) -> None:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    violations = validate_workflow(data)
    assert violations == [], f"committed workflow {path} fails validation: {violations}"


@pytest.mark.skipif(not _FILES, reason="no first-party workflow files yet (early Phase 1)")
def test_first_party_workflow_path_matches_id() -> None:
    """A workflow at <domain>/<name>-vN.yaml must declare id '<domain>/<name>-vN'."""
    for path in _FILES:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        rel = path.relative_to(_WORKFLOWS_ROOT).with_suffix("")
        assert data.get("id") == str(rel), (
            f"{path}: declared id {data.get('id')!r} does not match path-derived id {str(rel)!r}"
        )
