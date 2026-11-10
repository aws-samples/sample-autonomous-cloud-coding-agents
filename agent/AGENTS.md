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

Unit tests cannot reach AWS. `tests/conftest.py` removes every credential source for the whole session and refuses any request botocore tries to send; a refused request fails the run even when every test passes (see the `AWS send guard` section at the end of the output). Stub the client (`boto3.client`, or the `aws_session` seam the code calls) and join any thread the test starts.

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

- **Cedar parity** — `cedarpy==4.12.2` (agent) and `@cedar-policy/cedar-wasm` 4.12.0 (cdk) must move together. See [cdk/AGENTS.md](../cdk/AGENTS.md) and `docs/design/CEDAR_HITL_GATES.md` §15.6.
- **Forgotten consumer** — Progress event schema changes need `cli/src/commands/watch.ts` and `test_progress_writer.py` updates.
- **Image bundle** — CDK deploys this tree; root `mise run build` always runs agent quality.
- **Un-attributed AWS SDK client (#319)** — build clients via `aws_session.tenant_client`/`tenant_resource` (tenant-scoped) or `aws_session.platform_client` (unscoped, still attributed); a naked `boto3.client(...)` silently drops solution attribution.
- **Git in tests (#855)** — `tests/conftest.py` removes the repository variables git hands to hooks (`GIT_DIR`, `GIT_INDEX_FILE`, …) and switches off user and system git config for the whole session. Build test repositories under `tmp_path` (`git -C` / `cwd=`) and give their commits an identity in that repository's own config or via `GIT_AUTHOR_*` / `GIT_COMMITTER_*`; nothing is inherited from the host. A git command run in a directory that is not a repository fails instead of adopting the checkout or a repository around the temp directory.
