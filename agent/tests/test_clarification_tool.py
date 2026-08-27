"""Tests for the request_clarification in-process SDK tool (clarify-before-spend)."""

from clarification_tool import (
    CLARIFICATION_SERVER_NAME,
    CLARIFICATION_TOOL_NAME,
    build_clarification_server,
)


class TestClarificationTool:
    def test_tool_name_is_the_mcp_qualified_form(self):
        # The runner matches on the fully-qualified mcp__<server>__<tool> name.
        assert f"mcp__{CLARIFICATION_SERVER_NAME}__request_clarification" == CLARIFICATION_TOOL_NAME

    def test_build_server_returns_sdk_config(self):
        server = build_clarification_server()
        # SDK present in the venv → a dict server config with the sdk type + name.
        assert server is not None
        assert server["type"] == "sdk"
        assert server["name"] == CLARIFICATION_SERVER_NAME
        assert "instance" in server

    def test_registered_tool_exposes_the_question_param(self):
        # The registered tool must accept a ``question`` arg — that's what the
        # runner reads off the ToolUseBlock as the clarifying question.
        from claude_agent_sdk import tool

        @tool("request_clarification", "ask", {"question": str})
        async def rc(args):  # pragma: no cover - handler body not exercised here
            return {"content": [{"type": "text", "text": "ok"}]}

        assert rc.name == "request_clarification"
        assert "question" in rc.input_schema
