"""Value parity between ``contracts/constants.json`` and the agent constants it owns.

``scripts/check-constants-sync.ts`` checks how each owned constant is WRITTEN: every
assignment under ``agent/src`` must be a plain read of its contract key. That is a
check of the source text. This test is the other half: the value each constant
actually holds once the module is imported equals the contract, whatever expression
produced it. Modelled on ``cli/test/constants-parity.test.ts``.

Keep ``_OWNED`` in step with ``OWNED_PYTHON_NAMES`` in the script.
"""

import json
from pathlib import Path

import pytest

import config
import jira_reactions
import policy
import server

_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "constants.json").read_text()
)

# (module, constant, path into contracts/constants.json)
_OWNED = [
    (policy, "DEFAULT_APPROVAL_GATE_CAP", ("approval_gate_cap", "default")),
    (policy, "APPROVAL_GATE_CAP_MIN", ("approval_gate_cap", "min")),
    (policy, "APPROVAL_GATE_CAP_MAX", ("approval_gate_cap", "max")),
    (policy, "FLOOR_TIMEOUT_S", ("approval_timeout_s", "min")),
    (policy, "DEFAULT_TASK_TIMEOUT_S", ("approval_timeout_s", "default")),
    (jira_reactions, "APP_ACTOR_MIN_SECRET_LENGTH", ("jira_app_actor", "min_secret_length")),
    (jira_reactions, "FORGE_WEBTRIGGER_SUFFIX", ("jira_app_actor", "forge_webtrigger_suffix")),
    (server, "MICROVM_PLATFORM_CONFIG_ENV_BY_KEY", ("microvm_platform_config", "env_by_key")),
    (server, "MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS", ("microvm_platform_config", "required")),
    (
        server,
        "_READY_WARMUP_TOTAL_BUDGET_SECONDS",
        ("microvm_hook_budgets", "warmup_total_budget_seconds"),
    ),
    (
        server,
        "_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS",
        ("microvm_hook_budgets", "warmup_required_timeout_seconds"),
    ),
    (config, "_LINEAR_VAULT_SCOPES", ("linear_vault", "scopes")),
    (config, "_LINEAR_VAULT_CUSTOM_PARAMS", ("linear_vault", "custom_parameters")),
]


@pytest.mark.parametrize(("module", "name", "path"), _OWNED, ids=[row[1] for row in _OWNED])
def test_constant_holds_the_contract_value(module, name, path):
    expected = _CONTRACT
    for key in path:
        expected = expected[key]
    actual = getattr(module, name)

    if isinstance(actual, (set, frozenset)):
        # JSON has no set: the contract lists the members.
        assert sorted(actual) == sorted(expected)
    else:
        assert actual == expected
