from __future__ import annotations

import asyncio
import gzip
import json
import subprocess
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import claude_agent_sdk as sdk
import pytest

import runner
from clarification_tool import CLARIFICATION_SERVER_NAME, CLARIFICATION_TOOL_NAME
from gateway_tools import GATEWAY_SERVER_NAME
from models import AgentResult, TaskConfig, TokenUsage
from runner import (
    _CLAUDE_VERSION_PROBE_TIMEOUT_S,
    _DISALLOWED_TOOLS,
    _FULL_TOOL_SURFACE,
    _initialize_policy_engine_and_hooks,
    _log_claude_cli_version,
    _register_gateway_server,
    _resolve_allowed_tools,
    _resolve_setting_sources,
    _setup_agent_env,
    _setup_bedrock_cost_attribution,
)
from telemetry import _TrajectoryWriter
from workflow import load_workflow


def _config(**overrides: Any) -> TaskConfig:
    base: dict[str, Any] = {
        "repo_url": "owner/repo",
        "github_token": "ghp_test",
        "aws_region": "us-east-1",
        "task_id": "t-runner-1",
    }
    base.update(overrides)
    return TaskConfig(**base)


class TestBlueprintCedarPolicyBootstrap:
    @pytest.mark.parametrize(
        "annotation",
        [
            '@tier ( "soft" )',
            '// Previously used @tier("hard").\n@tier("soft")',
        ],
    )
    @patch("hooks.build_hook_matchers")
    def test_cedar_recognizes_the_tier_despite_formatting_or_comments(
        self, _mock_build_hooks, annotation
    ):
        policy = (
            f'{annotation}\n@rule_id("review_report")\n'
            'forbid (principal, action == Agent::Action::"execute_bash", resource)\n'
            '  when { context.command == "echo report" };'
        )
        engine, _ = _initialize_policy_engine_and_hooks(
            config=_config(cedar_policies=[policy]), trajectory=None, progress=MagicMock()
        )
        decision = engine.evaluate_tool_use("Bash", {"command": "echo report"})
        assert decision.outcome == "require_approval"
        assert decision.matching_rule_ids == ("review_report",)


class TestClaudeSessionOwnership:
    @pytest.mark.parametrize("microvm", [False, True])
    @pytest.mark.parametrize(
        "failure", [None, "connect", "query", "receive", "cancel", "hook-denied"]
    )
    def test_broker_selection_and_cleanup_on_every_session_exit(
        self, monkeypatch, microvm, failure
    ):
        import claude_agent_sdk

        import microvm_credentials
        import microvm_lifecycle

        config = _config()
        context = microvm_lifecycle.register_task(config.task_id, "vm") if microvm else None
        client = MagicMock()
        client.connect = AsyncMock()
        client.query = AsyncMock()
        client.disconnect = AsyncMock()
        if failure in {"connect", "query"}:
            getattr(client, failure).side_effect = RuntimeError("synthetic failure")

        async def messages():
            if failure == "receive":
                raise RuntimeError("synthetic receive failure")
            if failure == "cancel":
                raise asyncio.CancelledError
            if failure == "hook-denied":
                if context is not None:
                    await context.tool_started("denied-call")
                    await context.tool_started("other-active-call")
                yield claude_agent_sdk.UserMessage(
                    content=[
                        claude_agent_sdk.ToolResultBlock(
                            tool_use_id="denied-call",
                            content="Project hook denied",
                            is_error=True,
                        ),
                    ]
                )
                if context is not None:
                    assert context.diagnostic_snapshot()["active_tools"] == 1
                    assert "other-active-call" in context._tools
            yield claude_agent_sdk.ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=0,
                session_id="synthetic",
                total_cost_usd=0,
                usage={},
            )

        client.receive_response = messages
        make_client = MagicMock(return_value=client)
        monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", make_client)
        broker = MagicMock()
        broker.environment = {"ABCA_MICROVM_CREDENTIAL_BROKER": "1"}
        make_broker = MagicMock(return_value=broker)
        monkeypatch.setattr(microvm_credentials, "ScopedCredentialBroker", make_broker)
        monkeypatch.setattr(runner, "_setup_agent_env", lambda _config: None)
        monkeypatch.setattr(runner, "_log_claude_cli_version", lambda: None)
        monkeypatch.setattr(runner, "_initialize_policy_engine_and_hooks", lambda **_kw: (None, {}))
        monkeypatch.setattr(runner, "_register_gateway_server", lambda _servers: None)
        monkeypatch.setattr(runner, "build_clarification_server", lambda: None)
        monkeypatch.setattr(runner, "_ProgressWriter", MagicMock())
        monkeypatch.setattr(runner, "log_error_cw", MagicMock())
        try:
            if failure == "cancel":
                with pytest.raises(asyncio.CancelledError):
                    asyncio.run(runner.run_agent("probe", "probe", config, trajectory=MagicMock()))
            else:
                result = asyncio.run(
                    runner.run_agent("probe", "probe", config, trajectory=MagicMock())
                )
                expected = "error" if failure not in {None, "hook-denied"} else "success"
                assert result.status == expected
            options = make_client.call_args.kwargs["options"]
            if microvm:
                make_broker.assert_called_once_with(context)
                assert options.env == broker.environment
                broker.close.assert_called_once()
            else:
                make_broker.assert_not_called()
                assert options.env == {}
            client.disconnect.assert_awaited_once()
        finally:
            if context is not None:
                microvm_lifecycle.unregister_task(context)


class TestInitializePolicyEngineAndHooks:
    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_initial_approval_gate_count_threaded_to_engine(
        self, mock_policy_engine, _mock_build_hooks
    ):
        config = _config(initial_approval_gate_count=17)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        assert mock_policy_engine.called
        kwargs = mock_policy_engine.call_args.kwargs
        assert kwargs["initial_approval_gate_count"] == 17

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_zero_initial_approval_gate_count_omits_kwarg(
        self, mock_policy_engine, _mock_build_hooks
    ):
        config = _config(initial_approval_gate_count=0)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert "initial_approval_gate_count" not in kwargs

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_initial_approvals_and_timeout_threaded(self, mock_policy_engine, _mock_build_hooks):
        config = _config(
            initial_approvals=["tool_type:Read", "rule:force_push_any"],
            approval_timeout_s=600,
        )
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert kwargs["initial_approvals"] == ["tool_type:Read", "rule:force_push_any"]
        assert kwargs["task_default_timeout_s"] == 600

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_read_only_threaded_to_engine(self, mock_policy_engine, _mock_build_hooks):
        config = _config(read_only=True)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        assert mock_policy_engine.call_args.kwargs["read_only"] is True

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_writeable_read_only_false_threaded_to_engine(
        self, mock_policy_engine, _mock_build_hooks
    ):
        config = _config(read_only=False)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        assert mock_policy_engine.call_args.kwargs["read_only"] is False

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_pre_approvals_loaded_emitted_with_initial_scopes(
        self, _mock_policy_engine, _mock_build_hooks
    ):
        config = _config(initial_approvals=["tool_type:Read", "all_session"])
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        progress.write_approval_pre_approvals_loaded.assert_called_once_with(
            count=2, scopes=["tool_type:Read", "all_session"]
        )

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_pre_approvals_loaded_emitted_with_zero_count_when_empty(
        self, _mock_policy_engine, _mock_build_hooks
    ):
        config = _config()
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        progress.write_approval_pre_approvals_loaded.assert_called_once_with(count=0, scopes=[])

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_user_id_threaded_to_hook_matchers(self, _mock_policy_engine, mock_build_hooks):
        config = _config(user_id="cog-sub-0123")
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_build_hooks.call_args.kwargs
        assert kwargs["user_id"] == "cog-sub-0123"

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_helper_returns_engine_and_hooks(self, mock_policy_engine, mock_build_hooks):
        engine_instance = MagicMock()
        hooks_instance = [MagicMock()]
        mock_policy_engine.return_value = engine_instance
        mock_build_hooks.return_value = hooks_instance

        engine, hooks = _initialize_policy_engine_and_hooks(
            config=_config(), trajectory=None, progress=MagicMock()
        )

        assert engine is engine_instance
        assert hooks is hooks_instance

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_approval_gate_cap_threaded_to_engine_when_set(
        self, mock_policy_engine, _mock_build_hooks
    ):
        config = _config(approval_gate_cap=200)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert kwargs["approval_gate_cap"] == 200

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_approval_gate_cap_omitted_when_none(self, mock_policy_engine, _mock_build_hooks):
        config = _config(approval_gate_cap=None)
        progress = MagicMock()

        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=progress)

        kwargs = mock_policy_engine.call_args.kwargs
        assert "approval_gate_cap" not in kwargs

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_init_log_includes_cap_and_threaded_source(
        self, _mock_policy_engine, _mock_build_hooks, capfd
    ):
        config = _config(approval_gate_cap=200)
        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=MagicMock())

        captured = capfd.readouterr()
        assert "Cedar policy engine initialized" in captured.out
        assert "approval_gate_cap=200" in captured.out
        assert "approval_gate_cap_source=threaded" in captured.out

    @patch("hooks.build_hook_matchers")
    @patch("policy.PolicyEngine")
    def test_init_log_marks_engine_default_when_cap_none(
        self, _mock_policy_engine, _mock_build_hooks, capfd
    ):
        config = _config(approval_gate_cap=None)
        _initialize_policy_engine_and_hooks(config=config, trajectory=None, progress=MagicMock())

        captured = capfd.readouterr()
        assert "approval_gate_cap_source=engine_default" in captured.out
        assert "approval_gate_cap=unset" in captured.out


class TestResolveAllowedTools:
    def test_workflow_tool_list_passed_through_verbatim(self):
        config = _config(allowed_tools=["Bash", "Read", "Write", "Edit"], read_only=False)
        assert _resolve_allowed_tools(config) == ["Bash", "Read", "Write", "Edit"]

    def test_empty_list_falls_back_to_full_surface(self):
        config = _config(allowed_tools=[], read_only=False)
        resolved = _resolve_allowed_tools(config)
        assert resolved == _FULL_TOOL_SURFACE
        assert resolved is not _FULL_TOOL_SURFACE

    def test_read_only_drops_write_and_edit_from_full_surface(self):
        config = _config(allowed_tools=[], read_only=True)
        resolved = _resolve_allowed_tools(config)
        assert "Write" not in resolved
        assert "Edit" not in resolved
        assert resolved == ["Bash", "Read", "Glob", "Grep", "WebFetch"]

    def test_read_only_drops_write_and_edit_from_workflow_list(self):
        config = _config(allowed_tools=["Bash", "Read", "Write", "Edit"], read_only=True)
        assert _resolve_allowed_tools(config) == ["Bash", "Read"]

    def test_read_leaning_default_lane_keeps_its_restricted_list(self):
        restricted = ["Read", "Glob", "Grep", "WebFetch"]
        config = _config(allowed_tools=list(restricted), read_only=False)
        assert _resolve_allowed_tools(config) == restricted
        assert "Bash" not in _resolve_allowed_tools(config)
        assert "Write" not in _resolve_allowed_tools(config)


class TestBedrockCostAttribution:
    def test_writes_attribution_file_and_sets_metadata_header_when_role_set(self, monkeypatch):
        monkeypatch.setenv("AGENT_SESSION_ROLE_ARN", "arn:aws:iam::1:role/SR")
        monkeypatch.delenv("ANTHROPIC_CUSTOM_HEADERS", raising=False)
        config = _config(user_id="alice", repo_url="owner/repo", task_id="t-9")

        with patch("bedrock_creds_helper.write_attribution_file") as mock_write:
            _setup_bedrock_cost_attribution(config)

        role_arn, tags = mock_write.call_args.args
        assert role_arn == "arn:aws:iam::1:role/SR"
        assert {"Key": "user_id", "Value": "alice"} in tags

        header = __import__("os").environ["ANTHROPIC_CUSTOM_HEADERS"]
        name, _, value = header.partition(": ")
        assert name == "X-Amzn-Bedrock-Request-Metadata"
        import json as _json

        assert _json.loads(value) == {
            "user_id": "alice",
            "repo": "owner/repo",
            "task_id": "t-9",
        }

    def test_no_attribution_file_when_role_unset_but_header_still_set(self, monkeypatch):
        monkeypatch.delenv("AGENT_SESSION_ROLE_ARN", raising=False)
        config = _config(user_id="bob", repo_url="o/r", task_id="t-1")
        with patch("bedrock_creds_helper.write_attribution_file") as mock_write:
            _setup_bedrock_cost_attribution(config)
        mock_write.assert_not_called()
        assert "X-Amzn-Bedrock-Request-Metadata" in __import__("os").environ.get(
            "ANTHROPIC_CUSTOM_HEADERS", ""
        )


class TestToolSurfaceHardening:
    def test_workflow_task_agent_are_disallowed(self):
        assert "Workflow" in _DISALLOWED_TOOLS
        assert "Task" in _DISALLOWED_TOOLS
        assert "Agent" in _DISALLOWED_TOOLS

    def test_disallowed_tool_set_is_pinned(self):
        assert set(_DISALLOWED_TOOLS) == {
            "Workflow",
            "Task",
            "Agent",
            "Monitor",
            "SendMessage",
            "CronCreate",
            "CronDelete",
            "CronList",
            "ScheduleWakeup",
        }

    def test_repo_less_loads_no_setting_sources(self):
        config = _config(requires_repo=False, repo_url="", github_token="")
        assert _resolve_setting_sources(config) == []

    def test_repo_bound_loads_project_settings(self):
        config = _config(requires_repo=True)
        assert _resolve_setting_sources(config) == ["project"]

    def test_repo_optional_with_repo_loads_project_settings(self):
        config = _config(requires_repo=False, repo_url="owner/repo")
        assert _resolve_setting_sources(config) == ["project"]


class TestSetupAgentEnv:
    def test_haiku_model_env_is_set_from_config(self, monkeypatch):
        import os

        monkeypatch.setenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "")
        monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "")
        monkeypatch.setenv("CLAUDE_CODE_MODEL_CATALOG", "")

        config = _config(haiku_model="us.anthropic.claude-haiku-4-5-20251001-v1:0")
        _setup_agent_env(config)
        assert (
            os.environ["ANTHROPIC_DEFAULT_HAIKU_MODEL"]
            == "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        )

    def test_model_catalog_is_switched_off(self, monkeypatch):
        import os

        monkeypatch.setenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "")
        monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "")
        monkeypatch.setenv("CLAUDE_CODE_MODEL_CATALOG", "on")

        _setup_agent_env(_config())
        assert os.environ["CLAUDE_CODE_MODEL_CATALOG"] == "off"

    def test_instrumentation_variables_are_removed_from_the_process(self, monkeypatch):
        import os

        for name in (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_MODEL_CATALOG",
        ):
            monkeypatch.setenv(name, "")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
        monkeypatch.setenv("OTEL_PYTHON_DISTRO", "aws_distro")
        instrumentation = "/opt/venv/lib/opentelemetry/instrumentation/auto_instrumentation"
        monkeypatch.setenv("PYTHONPATH", os.pathsep.join((instrumentation, "/repo/src")))

        _setup_agent_env(_config())

        assert [name for name in os.environ if name.startswith("OTEL_")] == []
        assert os.environ["PYTHONPATH"] == "/repo/src"

    def test_python_path_of_instrumentation_only_is_removed(self, monkeypatch):
        import os

        for name in (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_MODEL_CATALOG",
        ):
            monkeypatch.setenv(name, "")
        monkeypatch.setenv("PYTHONPATH", "/opt/venv/lib/opentelemetry/instrumentation")

        _setup_agent_env(_config())

        assert "PYTHONPATH" not in os.environ

    def test_config_default_haiku_model_is_an_inference_profile(self):
        # Claude 4.x cannot be invoked on-demand by bare id.
        geos = ("global.", "us.", "us-gov.", "eu.", "apac.", "jp.", "au.")
        assert _config().haiku_model.startswith(geos)


class TestClaudeCliVersionProbe:
    def test_the_version_probe_bound_is_loose_enough_for_a_cold_start(self):
        assert _CLAUDE_VERSION_PROBE_TIMEOUT_S >= 60

    def test_the_probe_passes_that_timeout_to_the_version_call_only(self, monkeypatch):
        calls: list[tuple[list[str], float]] = []

        def fake_run(argv, **kwargs):
            calls.append((list(argv), kwargs["timeout"]))
            return MagicMock(returncode=0, stdout="/usr/bin/claude\n")

        monkeypatch.setattr(runner.subprocess, "run", fake_run)
        _log_claude_cli_version()

        assert calls[0][0] == ["which", "claude"]
        assert calls[1][0] == ["claude", "--version"]
        assert calls[1][1] == _CLAUDE_VERSION_PROBE_TIMEOUT_S
        assert calls[0][1] < calls[1][1]

    def test_a_missing_cli_warns_and_skips_the_version_call(self, monkeypatch):
        calls: list[list[str]] = []

        def fake_run(argv, **_kwargs):
            calls.append(list(argv))
            return MagicMock(returncode=1, stdout="")

        monkeypatch.setattr(runner.subprocess, "run", fake_run)
        _log_claude_cli_version()
        assert calls == [["which", "claude"]]

    @pytest.mark.parametrize(
        "error",
        [
            subprocess.TimeoutExpired(["claude", "--version"], 60),
            FileNotFoundError(2, "No such file or directory", "claude"),
            PermissionError(13, "Permission denied", "claude"),
        ],
        ids=["timeout", "missing-binary", "not-executable"],
    )
    def test_a_failing_version_call_warns_instead_of_killing_the_task(
        self, monkeypatch, capfd, error
    ):
        def fake_run(argv, **_kwargs):
            if argv[0] == "which":
                return MagicMock(returncode=0, stdout="/usr/bin/claude\n")
            raise error

        monkeypatch.setattr(runner.subprocess, "run", fake_run)

        _log_claude_cli_version()

        out = capfd.readouterr().out
        assert "claude CLI version probe failed (non-fatal)" in out
        assert type(error).__name__ in out
        assert "claude CLI:" not in out

    def test_a_failing_path_lookup_also_only_warns(self, monkeypatch, capfd):
        def fake_run(_argv, **_kwargs):
            raise FileNotFoundError(2, "No such file or directory", "which")

        monkeypatch.setattr(runner.subprocess, "run", fake_run)

        _log_claude_cli_version()

        assert "claude CLI version probe failed (non-fatal)" in capfd.readouterr().out

    def test_run_agent_invokes_the_cli_version_probe(self):
        sentinel = RuntimeError("stop after version probe")
        with (
            patch.object(runner, "_setup_agent_env"),
            patch.object(runner, "_log_claude_cli_version", side_effect=sentinel) as probe,
        ):
            try:
                asyncio.run(runner.run_agent("prompt", "system", _config()))
            except RuntimeError as error:
                assert error is sentinel
            else:
                raise AssertionError("run_agent continued past the version probe")

        probe.assert_called_once_with()


class TestRegisterGatewayServer:
    def test_registers_built_server_under_gateway_name(self):
        sentinel = object()
        with patch("runner.build_gateway_server", return_value=sentinel) as mock_build:
            mcp_servers: dict[str, Any] = {}
            _register_gateway_server(mcp_servers)
        mock_build.assert_called_once_with()
        assert mcp_servers == {GATEWAY_SERVER_NAME: sentinel}

    def test_no_registration_when_bridge_disabled(self):
        with patch("runner.build_gateway_server", return_value=None):
            mcp_servers: dict[str, Any] = {}
            _register_gateway_server(mcp_servers)
        assert mcp_servers == {}

    def test_preserves_other_servers_already_registered(self):
        sentinel = object()
        existing = object()
        with patch("runner.build_gateway_server", return_value=sentinel):
            mcp_servers: dict[str, Any] = {"clarification": existing}
            _register_gateway_server(mcp_servers)
        assert mcp_servers == {
            "clarification": existing,
            GATEWAY_SERVER_NAME: sentinel,
        }


def _run_agent(
    monkeypatch, *messages: Any, config: TaskConfig | None = None, **run_agent_kwargs: Any
) -> SimpleNamespace:
    seen: dict[str, Any] = {}
    hooks: dict[str, Any] = {}

    class Client:
        def __init__(self, options):
            seen["options"] = options

        async def connect(self):
            pass

        async def query(self, prompt):
            pass

        async def receive_response(self):
            for message in messages:
                if isinstance(message, Exception):
                    raise message
                yield message

        async def disconnect(self):
            pass

    progress = MagicMock()
    monkeypatch.setattr(sdk, "ClaudeSDKClient", Client)
    monkeypatch.setattr(runner, "_setup_agent_env", lambda _config: None)
    monkeypatch.setattr(runner, "_log_claude_cli_version", lambda: None)
    monkeypatch.setattr(runner, "_initialize_policy_engine_and_hooks", lambda **_kw: (None, hooks))
    monkeypatch.setattr(runner, "_register_gateway_server", lambda _servers: None)
    monkeypatch.setattr(runner, "_ProgressWriter", MagicMock(return_value=progress))
    result: AgentResult = asyncio.run(
        runner.run_agent("prompt", "system", config or _config(), **run_agent_kwargs)
    )
    return SimpleNamespace(result=result, progress=progress, options=seen["options"], hooks=hooks)


def _result(**fields: Any) -> sdk.ResultMessage:
    base: dict[str, Any] = {
        "subtype": "success",
        "duration_ms": 1200,
        "duration_api_ms": 900,
        "is_error": False,
        "num_turns": 1,
        "session_id": "session",
    }
    base.update(fields)
    return sdk.ResultMessage(**base)


class TestClarificationToolIsOfferedPerWorkflow:
    @staticmethod
    def _offered(monkeypatch, workflow_id: str) -> bool:
        config = _config(resolved_workflow={"id": workflow_id, "version": "1.0.0"})
        options = _run_agent(monkeypatch, _result(), config=config).options
        return (
            CLARIFICATION_SERVER_NAME in options.mcp_servers
            and CLARIFICATION_TOOL_NAME in options.allowed_tools
        )

    def test_new_task_workflow_is_offered_the_tool(self, monkeypatch):
        assert self._offered(monkeypatch, "coding/new-task-v1") is True

    @pytest.mark.parametrize("workflow_id", sorted(runner._NO_CLARIFICATION_WORKFLOW_IDS))
    def test_excluded_workflow_is_one_that_ships_and_is_not_offered_the_tool(
        self, monkeypatch, workflow_id
    ):
        assert load_workflow(workflow_id).id == workflow_id
        assert self._offered(monkeypatch, workflow_id) is False

    def test_research_workflow_is_not_offered_the_tool(self, monkeypatch):
        assert self._offered(monkeypatch, "knowledge/web-research-v1") is False


class TestOptionsOfTheSdkClient:
    def test_session_gets_the_tool_lock_the_hooks_and_the_limits_of_the_task(self, monkeypatch):
        config = _config(max_turns=7, max_budget_usd=1.5)
        run = _run_agent(monkeypatch, _result(), config=config, cwd="/w")

        options = run.options
        # Under bypassPermissions ``allowed_tools`` restricts nothing.
        assert options.disallowed_tools == _DISALLOWED_TOOLS
        assert options.hooks is run.hooks
        assert options.permission_mode == "bypassPermissions"
        assert options.setting_sources == ["project"]
        assert options.system_prompt == "system"
        assert options.cwd == "/w"
        assert options.max_turns == 7
        assert options.max_budget_usd == 1.5

    def test_read_only_task_gets_neither_a_write_tool_nor_the_clarification_tool(self, monkeypatch):
        config = _config(read_only=True, allowed_tools=["Bash", "Read", "Write", "Edit"])
        options = _run_agent(monkeypatch, _result(), config=config).options

        assert options.allowed_tools == ["Bash", "Read"]
        assert options.mcp_servers == {}


class TestCleanResult:
    def test_status_final_text_cost_and_usage_are_recorded(self, monkeypatch):
        run = _run_agent(
            monkeypatch,
            _result(
                result="The cache is never invalidated.",
                total_cost_usd=0.42,
                usage={"input_tokens": 1200, "output_tokens": 340},
            ),
        )

        assert run.result.status == "success"
        assert run.result.result_text == "The cache is never invalidated."
        assert run.result.cost_usd == 0.42
        assert run.result.session_id == "session"
        assert run.result.usage == TokenUsage(input_tokens=1200, output_tokens=340)


_AWS_KEY_ID = "AKIA" + "IOSFODNN7EXAMPLE"
_GIT_URL_TOKEN = "gh" + "s_" + "a1B2c3D4" * 5
_HEADER_TOKEN = "made-up-" + "0123456789"
_SECRETS = (_AWS_KEY_ID, _GIT_URL_TOKEN, _HEADER_TOKEN)
_AWS_SECRET_KEY = "wJalrXUt" + "nFEMI/K7" + "MDENG/bP" + "xRfiCYEX" + "AMPLEKEY"
_KEY_BEHIND_ITS_NAME = [
    pytest.param(f"aws_secret_access_key='{_AWS_SECRET_KEY}' # \"prod\"", id="quoted"),
    pytest.param(f"aws_secret_access_key\t{_AWS_SECRET_KEY}", id="after a tab"),
    pytest.param(f"aws_secret_access_key:\n{_AWS_SECRET_KEY}", id="on the next line"),
]


def _assert_screened(recorded: str) -> None:
    for secret in _SECRETS:
        assert secret not in recorded
    assert "[REDACTED-AWS_KEY]" in recorded
    assert "Authorization: token ***" in recorded


class TestErrorResult:
    def test_error_subtype_carries_the_reason_the_cli_gave(self, monkeypatch):
        # The error subtypes send no ``result``: their reason is in ``errors``.
        run = _run_agent(
            monkeypatch,
            _result(
                subtype="error_during_execution",
                is_error=True,
                errors=["queryParams builder failed: boom"],
            ),
        )

        assert run.result.status == "error"
        assert run.result.error == (
            "Agent session error (subtype='error_during_execution'): "
            "queryParams builder failed: boom"
        )

    def test_turn_limit_keeps_the_wrapper_the_classifier_reads(self, monkeypatch):
        run = _run_agent(
            monkeypatch,
            _result(
                subtype="error_max_turns",
                is_error=True,
                num_turns=31,
                errors=["Reached maximum number of turns (30)"],
            ),
        )

        assert run.result.error == "Agent session error (subtype='error_max_turns')"

    def test_several_reasons_are_all_kept(self, monkeypatch):
        run = _run_agent(
            monkeypatch,
            _result(subtype="error_during_execution", is_error=True, errors=["first", "second"]),
        )

        assert run.result.error.endswith("): first; second")

    def test_error_subtype_without_a_reason_is_the_wrapper_alone(self, monkeypatch):
        run = _run_agent(monkeypatch, _result(subtype="error_max_budget_usd", is_error=True))

        assert run.result.error == "Agent session error (subtype='error_max_budget_usd')"

    def test_failed_model_call_is_reported_with_its_result_text(self, monkeypatch):
        # A model call that the provider refuses ends the run with subtype
        # "success", ``is_error`` and the refusal as ``result``.
        refusal = "API Error: 403 You don't have access to the model with the specified model ID."
        run = _run_agent(monkeypatch, _result(is_error=True, result=f" {refusal}\n"))

        assert run.result.status == "error"
        assert run.result.error == refusal
        assert run.result.result_text == ""

    def test_reason_is_screened_before_it_is_recorded(self, monkeypatch, capfd):
        run = _run_agent(
            monkeypatch,
            _result(
                subtype="error_during_execution",
                is_error=True,
                errors=[
                    f"git push https://x-access-token:{_GIT_URL_TOKEN}@github.com/o/r failed",
                    f"denied for {_AWS_KEY_ID} with Authorization: token {_HEADER_TOKEN}",
                ],
            ),
        )

        assert run.result.error.startswith(
            "Agent session error (subtype='error_during_execution'): git push https://"
        )
        _assert_screened(run.result.error)
        _assert_screened(capfd.readouterr().out)


def _assistant(*blocks: Any, answer: str | None) -> sdk.AssistantMessage:
    """The CLI sends an answer as one message per content block (thinking, text,
    each tool call), and every one of them carries the id of the answer."""
    return sdk.AssistantMessage(content=list(blocks), model="claude-opus-5-5", message_id=answer)


def _thinking(text: str) -> sdk.ThinkingBlock:
    return sdk.ThinkingBlock(thinking=text, signature="sig")


def _bash(tool_use_id: str, command: str) -> sdk.ToolUseBlock:
    return sdk.ToolUseBlock(id=tool_use_id, name="Bash", input={"command": command})


def _tool_result(tool_use_id: str, content: Any, is_error: bool = False) -> sdk.UserMessage:
    block = sdk.ToolResultBlock(tool_use_id=tool_use_id, content=content, is_error=is_error)
    return sdk.UserMessage(content=[block])


def _turns_of(write: MagicMock) -> list[int]:
    return [call.kwargs["turn"] for call in write.call_args_list]


class TestTurnCount:
    def test_messages_of_one_answer_are_one_turn(self, monkeypatch):
        trajectory = MagicMock()
        run = _run_agent(
            monkeypatch,
            _assistant(_thinking("Look at the tests first."), answer="msg_1"),
            _assistant(_bash("call_1", "npm test"), answer="msg_1"),
            _tool_result("call_1", "12 passing"),
            _assistant(sdk.TextBlock(text="All green."), answer="msg_2"),
            _result(num_turns=2),
            trajectory=trajectory,
        )

        assert run.result.turns == 2
        assert run.result.num_turns == 2
        assert _turns_of(run.progress.write_agent_turn) == [1, 1, 2]
        assert _turns_of(run.progress.write_agent_tool_call) == [1]
        assert _turns_of(run.progress.write_agent_tool_result) == [1]
        assert _turns_of(trajectory.write_turn) == [1, 1, 2]

    def test_result_between_two_calls_of_one_answer_starts_no_turn(self, monkeypatch):
        # The CLI runs a tool while the answer that asked for it is still
        # arriving, so the result of the first call can precede the second call.
        run = _run_agent(
            monkeypatch,
            _assistant(_bash("call_1", "ls src"), answer="msg_1"),
            _tool_result("call_1", "a.py"),
            _assistant(_bash("call_2", "ls tests"), answer="msg_1"),
            _tool_result("call_2", "test_a.py"),
            _assistant(sdk.TextBlock(text="Two files."), answer="msg_2"),
            _result(num_turns=3),
        )

        assert run.result.turns == 2
        assert _turns_of(run.progress.write_agent_turn) == [1, 1, 2]
        assert _turns_of(run.progress.write_agent_tool_result) == [1, 1]

    def test_cost_update_is_numbered_like_the_events_around_it(self, monkeypatch):
        run = _run_agent(
            monkeypatch,
            _assistant(_bash("call_1", "ls src"), answer="msg_1"),
            _tool_result("call_1", "a.py"),
            _assistant(_bash("call_2", "ls tests"), answer="msg_1"),
            _tool_result("call_2", "test_a.py"),
            _assistant(sdk.TextBlock(text="Two files."), answer="msg_2"),
            _result(num_turns=3),
        )

        assert _turns_of(run.progress.write_agent_cost_update) == [2]
        assert run.result.num_turns == 3

    def test_run_without_a_result_reports_the_turns_it_saw(self, monkeypatch):
        run = _run_agent(
            monkeypatch,
            _assistant(_thinking("Look at the tests first."), answer="msg_1"),
            _assistant(_bash("call_1", "npm test"), answer="msg_1"),
            _tool_result("call_1", "12 passing"),
            _assistant(sdk.TextBlock(text="All green."), answer="msg_2"),
        )

        assert run.result.status == "unknown"
        assert run.result.num_turns == 0
        assert run.result.turns == 2

    def test_message_without_an_answer_id_is_a_turn_of_its_own(self, monkeypatch):
        run = _run_agent(
            monkeypatch,
            _assistant(sdk.TextBlock(text="One."), answer=None),
            _assistant(sdk.TextBlock(text="Two."), answer=None),
            _result(num_turns=2),
        )

        assert run.result.turns == 2


class TestClarificationCallIsRecorded:
    @staticmethod
    def _recorded(monkeypatch, tool_input: dict) -> str:
        call = sdk.ToolUseBlock(id="call_1", name=CLARIFICATION_TOOL_NAME, input=tool_input)
        run = _run_agent(monkeypatch, _assistant(call, answer="msg_1"), _result())
        return run.result.clarification_question

    def test_question_is_recorded_without_the_space_around_it(self, monkeypatch):
        recorded = self._recorded(monkeypatch, {"question": " Which page is slow? "})

        assert recorded == "Which page is slow?"

    @pytest.mark.parametrize(
        "tool_input",
        [{"question": ""}, {"question": "  "}, {}],
        ids=["empty", "blank", "missing"],
    )
    def test_call_without_a_question_is_recorded_all_the_same(self, monkeypatch, tool_input):
        recorded = self._recorded(monkeypatch, tool_input)

        assert recorded
        assert recorded.strip() == ""


def _trace(trajectory: _TrajectoryWriter) -> list[dict]:
    artifact = trajectory.dump_gzipped_jsonl()
    assert artifact is not None
    _header, *events = [json.loads(line) for line in gzip.decompress(artifact).splitlines()]
    return events


class TestToolResultsAreRecorded:
    def test_trace_holds_what_the_tool_returned(self, monkeypatch):
        trajectory = _TrajectoryWriter("t-runner-1", accumulate=True)
        _run_agent(
            monkeypatch,
            _assistant(_bash("call_1", "npm test"), answer="msg_1"),
            _tool_result("call_1", "12 passing"),
            _assistant(sdk.TextBlock(text="All green."), answer="msg_2"),
            _result(num_turns=2),
            trajectory=trajectory,
        )

        events = _trace(trajectory)
        assert [event["event"] for event in events] == [
            "TRAJECTORY_TURN",
            "TRAJECTORY_TOOL_RESULT",
            "TRAJECTORY_TURN",
            "TRAJECTORY_RESULT",
        ]
        assert events[0]["tool_calls"] == [{"name": "Bash", "input": {"command": "npm test"}}]
        assert events[1] == {
            "event": "TRAJECTORY_TOOL_RESULT",
            "task_id": "t-runner-1",
            "turn": 1,
            "tool_name": "Bash",
            "is_error": False,
            "content": "12 passing",
        }

    def test_failed_call_is_recorded_as_an_error(self, monkeypatch):
        trajectory = _TrajectoryWriter("t-runner-1", accumulate=True)
        run = _run_agent(
            monkeypatch,
            _assistant(_bash("call_1", "git push --force"), answer="msg_1"),
            _tool_result("call_1", [{"type": "text", "text": "denied by policy"}], is_error=True),
            _result(),
            trajectory=trajectory,
        )

        recorded = _trace(trajectory)[1]
        assert recorded["is_error"] is True
        assert recorded["content"] == "[{'type': 'text', 'text': 'denied by policy'}]"
        run.progress.write_agent_tool_result.assert_called_once_with(
            tool_name="Bash",
            is_error=True,
            content="[{'type': 'text', 'text': 'denied by policy'}]",
            turn=1,
        )

    @pytest.mark.parametrize("text", _KEY_BEHIND_ITS_NAME)
    def test_credentials_in_a_list_of_blocks_are_replaced_as_in_a_string(
        self, monkeypatch, capfd, text
    ):
        recorded = {}
        for shape, content in (("string", text), ("list", [{"type": "text", "text": text}])):
            trajectory = _TrajectoryWriter("t-runner-1", accumulate=True)
            run = _run_agent(
                monkeypatch,
                _assistant(_bash("call_1", "cat config"), answer="msg_1"),
                _tool_result("call_1", content),
                _result(),
                trajectory=trajectory,
            )
            recorded[shape] = (
                _trace(trajectory)[1]["content"]
                + run.progress.write_agent_tool_result.call_args.kwargs["content"]
                + capfd.readouterr().out
            )

        assert _AWS_SECRET_KEY not in recorded["string"]
        assert _AWS_SECRET_KEY not in recorded["list"]

    def test_long_output_is_cut_in_the_trace(self, monkeypatch):
        trajectory = _TrajectoryWriter("t-runner-1", accumulate=True)
        _run_agent(
            monkeypatch,
            _assistant(_bash("call_1", "cat big.log"), answer="msg_1"),
            _tool_result("call_1", "x" * 5000),
            _result(),
            trajectory=trajectory,
        )

        assert _trace(trajectory)[1]["content"] == "x" * 2000 + "... [truncated, 5000 chars total]"

    def test_credentials_in_a_result_are_replaced_before_it_is_recorded(self, monkeypatch, capfd):
        output = (
            f"remote: https://x-access-token:{_GIT_URL_TOKEN}@github.com/o/r\n"
            f"AWS_ACCESS_KEY_ID={_AWS_KEY_ID}\n"
            f"curl -H 'Authorization: token {_HEADER_TOKEN}' https://api.example.com"
        )
        trajectory = _TrajectoryWriter("t-runner-1", accumulate=True)
        run = _run_agent(
            monkeypatch,
            _assistant(_bash("call_1", "git remote -v && env"), answer="msg_1"),
            _tool_result("call_1", output, is_error=True),
            _result(),
            trajectory=trajectory,
        )

        in_trace = _trace(trajectory)[1]["content"]
        in_event = run.progress.write_agent_tool_result.call_args.kwargs["content"]
        assert in_trace.startswith("remote: https://")
        _assert_screened(in_trace)
        assert in_event == in_trace
        _assert_screened(capfd.readouterr().out)


class TestEventsOfTheRunAreScreened:
    _TEXT = (
        f"git push https://x-access-token:{_GIT_URL_TOKEN}@github.com/o/r "
        f"with AWS_ACCESS_KEY_ID={_AWS_KEY_ID} "
        f"and -H 'Authorization: token {_HEADER_TOKEN}'"
    )

    @staticmethod
    def _recorded_input(monkeypatch, call: sdk.ToolUseBlock) -> str:
        run = _run_agent(monkeypatch, _assistant(call, answer="msg_1"), _result())
        return run.progress.write_agent_tool_call.call_args.kwargs["tool_input"]

    def test_credentials_in_thinking_and_text_are_replaced(self, monkeypatch):
        run = _run_agent(
            monkeypatch,
            _assistant(
                _thinking(f"Plan: {self._TEXT}"),
                sdk.TextBlock(text=f"Running {self._TEXT}"),
                answer="msg_1",
            ),
            _result(),
        )

        recorded = run.progress.write_agent_turn.call_args.kwargs
        assert recorded["thinking"].startswith("Plan: git push https://")
        _assert_screened(recorded["thinking"])
        assert recorded["text"].startswith("Running git push https://")
        _assert_screened(recorded["text"])

    def test_credentials_in_a_tool_input_are_replaced(self, monkeypatch):
        recorded = self._recorded_input(monkeypatch, _bash("call_1", self._TEXT))

        assert recorded.startswith("{'command': ")
        _assert_screened(recorded)

    @pytest.mark.parametrize("command", _KEY_BEHIND_ITS_NAME)
    def test_strings_of_a_tool_input_are_screened_before_its_repr(self, monkeypatch, command):
        recorded = self._recorded_input(monkeypatch, _bash("call_1", command))

        assert _AWS_SECRET_KEY not in recorded

    def test_secret_under_a_key_of_a_tool_input_is_replaced(self, monkeypatch):
        call = sdk.ToolUseBlock(
            id="call_1",
            name="mcp__vault__put",
            input={"aws_secret_access_key": _AWS_SECRET_KEY},
        )

        assert _AWS_SECRET_KEY not in self._recorded_input(monkeypatch, call)

    def test_arguments_after_a_replaced_value_stay_readable(self, monkeypatch):
        command = f'curl https://api.example.com -H "Authorization: token {_HEADER_TOKEN}"'
        call = sdk.ToolUseBlock(
            id="call_1", name="Bash", input={"command": command, "description": "List the items"}
        )

        assert self._recorded_input(monkeypatch, call) == (
            "{'command': 'curl https://api.example.com -H \"Authorization: token ***', "
            "'description': 'List the items'}"
        )

    def test_input_without_a_credential_is_recorded_as_its_repr(self, monkeypatch):
        run = _run_agent(
            monkeypatch, _assistant(_bash("call_1", "npm test"), answer="msg_1"), _result()
        )

        run.progress.write_agent_tool_call.assert_called_once_with(
            tool_name="Bash", tool_input="{'command': 'npm test'}", turn=1
        )

    def test_credentials_in_the_text_of_a_session_error_are_replaced(self, monkeypatch):
        run = _run_agent(monkeypatch, RuntimeError(self._TEXT))

        assert run.result.status == "error"
        recorded = run.progress.write_agent_error.call_args.kwargs
        assert recorded["error_type"] == "RuntimeError"
        assert recorded["message"].startswith("git push https://")
        _assert_screened(recorded["message"])
        assert run.result.error.startswith("Claude session failed: git push https://")
        _assert_screened(run.result.error)
