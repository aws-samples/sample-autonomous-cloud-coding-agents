"""Load cross-language constants shared by the agent runtime."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _load_shared_constants() -> dict[str, Any]:
    """Read the contract in deployed and local repository layouts."""
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "contracts" / "constants.json",
        here.parent.parent.parent / "contracts" / "constants.json",
    ]
    for path in candidates:
        if path.is_file():
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                raise ValueError(f"{path} must contain a JSON object")
            return value
    raise FileNotFoundError(
        "contracts/constants.json not found; checked: "
        + ", ".join(str(path) for path in candidates),
    )


SHARED_CONSTANTS = _load_shared_constants()
