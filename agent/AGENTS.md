# Agent runtime — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You maintain the **Python agent runtime** bundled into the CDK-deployed image: pipeline, runner, hooks, prompts, policy, and progress events.

## Commands (run these)

```bash
mise //agent:quality         # lint, type-check, pytest
mise //agent:security        # agent-scoped security checks
cd agent && uv run pytest -v # verbose single run
cd agent && uv run pytest tests/test_progress_writer.py -v
```

Root `mise run build` includes `//agent:quality` in parallel with `//cdk:build`.

## Testing

- **Full quality gate:** `mise //agent:quality`
- **Verbose pytest:** `cd agent && uv run pytest -v`
- **Single file:** `cd agent && uv run pytest tests/test_hooks.py -k test_name`
- **With coverage:** see `agent/mise.toml` / `pyproject.toml` for project defaults

| Code | Test location |
|------|---------------|
| `progress_writer.py` | `agent/tests/test_progress_writer.py` |
| `hooks.py`, `policy.py` | `agent/tests/test_hooks.py`, `test_policy.py` |
| `pipeline.py`, `runner.py` | `agent/tests/test_pipeline.py`, etc. |

Use `@pytest.fixture(autouse=True)` to reset shared module state between tests when handlers use circuit breakers or caches.

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `agent/src/pipeline.py`, `runner.py` | WRITE | Task execution loop |
| `agent/src/config.py`, `hooks.py`, `policy.py` | WRITE | Runtime config and gates |
| `agent/src/prompts/` | WRITE | System prompts per workflow |
| `agent/src/progress_writer.py` | WRITE | TaskEvents emission |
| `agent/tests/` | WRITE | pytest suite |
| `agent/README.md` | WRITE | Env vars, PAT notes |
| `cli/src/commands/watch.ts` | WRITE (if event schema changes) | Event consumer |

## Code style

**Progress events** — use `_ProgressWriter`; do not write DynamoDB directly from random call sites:

```python
# ✅ Good — typed writer method (table from TASK_EVENTS_TABLE_NAME env)
from progress_writer import _ProgressWriter

writer = _ProgressWriter(task_id=task_id)
writer.write_agent_milestone("clone_complete", "Repository cloned")

# ❌ Bad — raw boto3, no circuit breaker, ad-hoc shape
dynamodb.put_item(TableName=table, Item={"event_type": {"S": "done"}})
```

**Tests** — pytest classes, explicit fixtures for shared state:

```python
# ✅ Good
@pytest.fixture(autouse=True)
def _reset_shared_circuit_breaker_state():
    _reset_circuit_breakers()
    yield
    _reset_circuit_breakers()

class TestGenerateUlid:
    def test_length_is_26(self):
        assert len(_generate_ulid()) == 26

# ❌ Bad — no isolation, test order dependency
def test_a():
    _ProgressWriter._circuit_open = True  # poisons test_b
```

**Silent failures** — do not `except: pass` or return empty defaults without justification; semgrep `AI004` blocks masking (use `nosemgrep` with reason if intentional).

## Boundaries

- ✅ **Always:** Add tests under `agent/tests/` for behavior changes; update `agent/README.md` for new env vars; emit structured progress events for operator-visible milestones
- ⚠️ **Ask first:** Changes to agent–orchestrator contract, Dockerfile base image, new system dependencies in `pyproject.toml`
- 🚫 **Never:** Bump `cedarpy` without bumping `@cedar-policy/cedar-wasm` and refreshing `contracts/cedar-parity/` fixtures; edit only `agent/` and skip `mise //agent:quality` before PR

## Common mistakes

- **Cedar parity** — `cedarpy==4.8.4` (agent) and `@cedar-policy/cedar-wasm` 4.8.2 (cdk) must move together. See [cdk/AGENTS.md](../cdk/AGENTS.md) and `docs/design/CEDAR_HITL_GATES.md` §15.6.
- **Forgotten consumer** — Progress event schema changes need `cli/src/commands/watch.ts` and `test_progress_writer.py` updates.
- **Image bundle** — CDK deploys this tree; root `mise run build` always runs agent quality.
