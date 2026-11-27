# Agent runtime — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You maintain the **Python agent runtime** bundled into the CDK-deployed image: pipeline, runner, hooks, prompts, policy, and progress events.

## Commands (run these)

```bash
mise //agent:quality         # lint, format, type-check, dead code, pytest
mise //agent:security        # agent-scoped security checks
mise //agent:testf -- -v     # pytest without coverage: the whole suite, verbose
mise //agent:testf -- tests/test_progress_writer.py -v
```

Root `mise run build` includes `//agent:quality` in parallel with `//cdk:build`. Its test step (`mise //agent:test`) writes a JUnit report to `agent/test-reports/junit.xml`, which git and the image build ignore; `build.yml` uploads it when the build job fails.

The lint step of `//agent:quality` (`lint:fix`) applies ruff's automatic fixes and then fails, listing each one (`Fixed 2 errors: …`). When its summary line says `0 remaining`, the files are already corrected: look at the change, keep it, and run the task again. The format step (`format`) likewise fails once it has rewritten a file (`1 file reformatted`): `git diff` shows the change; keep it and run the task again.

## Testing

- **Full quality gate:** `mise //agent:quality`
- **Verbose pytest:** `mise //agent:testf -- -v`
- **Single file:** `mise //agent:testf -- tests/test_hooks.py -k test_name`
- **With coverage:** see `agent/mise.toml` / `pyproject.toml` for project defaults

| Code | Test location |
|------|---------------|
| `progress_writer.py` | `agent/tests/test_progress_writer.py` |
| `hooks.py`, `policy.py` | `agent/tests/test_hooks.py`, `test_policy.py` |
| `policies/*.cedar` (built-in rules) | `agent/tests/test_policy_builtin_rules.py` — a table of the calls each rule must catch (per pattern at least two that give each `*` different text: where a call can leave the `*` empty, the bare call and the call inside a longer command or path; file rules through `Write` and `Edit`, each evaluated for every task type, `Bash` calls in read-only tasks as well) and one call it must leave alone; a new rule or pattern needs its rows |
| `pipeline.py`, `runner.py` | `agent/tests/test_pipeline.py`, etc. |
| `microvm_lifecycle.py`, `microvm_checkpoint.py` | `test_microvm_lifecycle.py`, `test_microvm_checkpoint.py`; checkpoint transaction tests require `ABCA_DDB_LOCAL_ENDPOINT` in CI |

Use `@pytest.fixture(autouse=True)` to reset shared module state between tests when handlers use circuit breakers or caches.

pytest runs in strict mode (`strict = true` in `pyproject.toml`). These fail the run instead of warning: a marker that is not registered under `markers`, a key `[tool.pytest.ini_options]` does not know, an `xfail` test that passes, two parameter sets with the same id, and a `parametrize` over an empty list. When the `CI` variable is set, a skipped test or module fails the run as well (`Skip guard` section at the end of the output): give the test what it needs in CI or delete it. An `xfail` marked `run=False` counts as skipped there, because it never runs: leave `run=False` out, so that the test runs and fails the run once it passes.

Warnings are errors (`filterwarnings = ["error", …]`): a deprecation, a coroutine that is never awaited or a file left open fails the test that caused it. Fix the cause. Only for a warning from a dependency that cannot be fixed here, add an `ignore:` line for that one message below `"error"` in `pyproject.toml`, with the reason and when it can go.

Unit tests cannot reach AWS through botocore. `tests/conftest.py` removes the credential sources botocore reads (variables, profiles, the config and credentials files, container and instance metadata) for the whole session and refuses any request botocore tries to send; a refused request fails the run even when every test passes (see the `AWS send guard` section at the end of the output). Stub the client (`boto3.client`, or the `aws_session` seam the code calls) and join any thread the test starts. A request sent with another HTTP client (`httpx2`, `requests`, `urllib`) is not refused: stub that client as well.

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `agent/src/pipeline.py`, `runner.py` | WRITE | Task execution loop |
| `agent/src/config.py`, `hooks.py`, `policy.py` | WRITE | Runtime config and gates |
| `agent/src/prompts/` | WRITE | System prompts per workflow |
| `agent/src/progress_writer.py` | WRITE | TaskEvents emission |
| `agent/tests/` | WRITE | pytest suite |
| `agent/tests_emulator/` | WRITE | Emulator-backed tests: real agent code against a local AWS Emulator. The unit run does not collect them: `mise run test:integration` from the repository root (needs Docker). Rules and known differences from AWS: [scripts/aws-emulator/README.md](../scripts/aws-emulator/README.md). |
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

**Unused arguments** — ruff `ARG` fails the lint on a parameter the body never reads (in `src/` and `scripts/`). Delete it and update the callers. If a caller you do not control fixes the signature (an SDK callback, a retry hook), prefix the name with `_`; on a method that overrides a base-class method, add `@typing.override`.

**Complexity** — ruff `C901` fails the lint on a function with a cyclomatic complexity above 15 (`max-complexity` in `pyproject.toml`). Split the function: pull a branch out into a helper, return early, or replace an `if` chain with a table. Nine functions that were above the ceiling when it was set carry `# noqa: C901` with the value they had then (in some comments after a newer value): do not add branches to them, do not add the comment to new code, and do not raise the ceiling. `uv run ruff check --ignore-noqa --select C901` prints the current values.

## Boundaries

- ✅ **Always:** Add tests under `agent/tests/` for behavior changes; update `agent/README.md` for new env vars; emit structured progress events for operator-visible milestones
- ⚠️ **Ask first:** Changes to agent–orchestrator contract, Dockerfile base image, new system dependencies in `pyproject.toml`
- 🚫 **Never:** Edit only `agent/` and skip `mise //agent:quality` before PR

## Common mistakes

- **Built-in Cedar rules** — a rule added to `policies/*.cedar` needs a row in `BUILTIN_RULES` of `tests/test_policy_builtin_rules.py` and in the rule table of [`docs/guides/USER_GUIDE.md`](../docs/guides/USER_GUIDE.md#rule-ids); a soft rule also needs an entry in `RULE_ID_ALLOWLIST` of `cdk/src/handlers/shared/approval-metrics.ts`. A `cedarpy` bump is judged by `tests/test_policy_builtin_rules.py`, `tests/test_cedarpy_annotations_contract.py` and `tests/test_policy_three_outcome.py`.
- **Claude Code CLI lockstep (#215)** — `claude-agent-sdk` (`pyproject.toml`) bundles a Claude Code CLI, and `Dockerfile` installs the same CLI from npm; the two must be the same version. Move both pins in one commit: `tests/test_claude_cli_lockstep.py` fails when they differ and names the version to use.
- **Image instrumentation list** — `Dockerfile` sets `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS` to the list the pinned `aws-opentelemetry-distro` applies in its agent observability mode, with `requests` and `urllib3` always in it (they would copy trace context and baggage into requests to Linear and Atlassian). An update of the distro can change that list: `tests/test_image_instrumentation.py` fails then and prints the instruction to write.
- **Contract-owned constant** — a constant that `contracts/constants.json` owns (the names in `OWNED_PYTHON_NAMES` in `scripts/check-constants-sync.ts`) may only be assigned a plain read of its contract key, optionally inside one conversion such as `int(...)`, in any file under `src/`. A literal, arithmetic on the value or another key fails `mise run check:constants-sync`. A new owned constant also needs a row in `_OWNED` in `tests/test_constants_parity.py`; the check fails until it has one. Details: [`contracts/constants.md`](../contracts/constants.md).
- **Coverage-ignore comment** — `# pragma: no cover` and `# pragma: no branch` have no effect in the agent: `[tool.coverage.report]` in `pyproject.toml` sets `exclude_lines` and `partial_branches`, which replace the default lists of coverage.py that honour those comments, so such a comment takes nothing out of what the coverage floor measures. The table is pinned in `contracts/coverage-thresholds.json` (`mise run check:coverage-thresholds-sync` fails when the two differ), and `tests/test_coverage_settings.py` checks that a function behind such a comment is still counted. Test the code, or leave it counted as uncovered and say why in a plain comment.
- **Deprecated call** — the type check (`mise //agent:typecheck`, part of `mise //agent:quality`) fails on a call of a function or method that the standard library, a dependency or this package marks as deprecated: `ty` reports `warning[deprecated]` with the name of the function and the deprecation's own message (for `datetime.utcnow()`: call `.now(datetime.timezone.utc)`), and exits 1. Replace the call; `pyproject.toml` has no package-wide exemption for this rule.
- **Forgotten consumer** — Progress event schema changes need `cli/src/commands/watch.ts` and `test_progress_writer.py` updates.
- **Image bundle** — CDK deploys this tree; root `mise run build` always runs agent quality.
- **Un-attributed AWS SDK client (#319)** — build clients via `aws_session.tenant_client`/`tenant_resource` (tenant-scoped) or `aws_session.platform_client` (unscoped, still attributed); a naked `boto3.client(...)` silently drops solution attribution. ruff `TID251` fails the lint on `boto3.client`, `boto3.resource` and any boto3 or botocore session in `src/` and `scripts/` outside `src/aws_session.py` (the list is `banned-api` in `pyproject.toml`).
- **Importing a process entrypoint (#254)** — `server.py` (uvicorn loads it) and `entrypoint.py` (batch mode runs it; it is otherwise a re-export shim kept for tests) are started, not imported: importing `server` builds the FastAPI app and runs its start-up checks, and importing `entrypoint` reloads `config`. ruff `TID251` fails the lint on any import of `server` or `entrypoint` in `src/` and `scripts/` (the same `banned-api` table); tests are exempt, and so is `src/aws_session.py`, whose file-wide `TID251` exemption for boto3 covers this ban too. Import the name from the module that defines it, or move what both need into a module both can import.
- **Git in tests (#855)** — `tests/conftest.py` removes the repository variables git hands to hooks (`GIT_DIR`, `GIT_INDEX_FILE`, …) and switches off user and system git config for the whole session. Build test repositories under `tmp_path` (`git -C` / `cwd=`) and give their commits an identity in that repository's own config or via `GIT_AUTHOR_*` / `GIT_COMMITTER_*`; no git configuration is inherited from the host. Other host state still reaches git, such as an exported `GIT_AUTHOR_NAME` or the user's global ignore file, so a test must not count on its absence. A git command run in a directory that is not a repository fails instead of adopting the checkout or a repository around the temp directory.
