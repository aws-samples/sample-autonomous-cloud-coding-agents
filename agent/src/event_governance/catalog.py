"""Load the normative event catalog from contracts/."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


def _catalog_path() -> Path:
    here = Path(__file__).resolve()
    for base in (here.parents[2], here.parents[1]):
        candidate = base / "contracts" / "event-catalog" / "v1.json"
        if candidate.is_file():
            return candidate
    deployed = Path("/app/contracts/event-catalog/v1.json")
    if deployed.is_file():
        return deployed
    raise FileNotFoundError("event catalog v1.json not found")


@lru_cache(maxsize=1)
def load_catalog() -> dict[str, Any]:
    """Return the parsed event catalog (cached)."""
    with _catalog_path().open(encoding="utf-8") as fh:
        return json.load(fh)


def is_known_event(name: str) -> bool:
    """Return True when ``name`` appears in the catalog."""
    cat = load_catalog()
    return (
        name in cat.get("top_level_event_types", [])
        or name in cat.get("agent_milestones", [])
        or name in cat.get("checkpoints", [])
    )
