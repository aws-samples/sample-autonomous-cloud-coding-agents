import asyncio

import claude_agent_sdk

from clarification_tool import (
    CLARIFICATION_SERVER_NAME,
    CLARIFICATION_TOOL_NAME,
    build_clarification_server,
)


class TestClarificationTool:
    def test_tool_name_is_the_mcp_qualified_form(self):
        assert f"mcp__{CLARIFICATION_SERVER_NAME}__request_clarification" == CLARIFICATION_TOOL_NAME

    def test_build_server_returns_sdk_config(self):
        server = build_clarification_server()
        assert server is not None
        assert server["type"] == "sdk"
        assert server["name"] == CLARIFICATION_SERVER_NAME
        assert "instance" in server

    def test_registered_tool_is_the_one_the_runner_reads(self, monkeypatch):
        registered = {}

        def capture(name, tools):
            registered["server"] = name
            (registered["tool"],) = tools

        monkeypatch.setattr(claude_agent_sdk, "create_sdk_mcp_server", capture)
        build_clarification_server()

        tool = registered["tool"]
        assert f"mcp__{registered['server']}__{tool.name}" == CLARIFICATION_TOOL_NAME
        assert tool.input_schema == {"question": str}
        reply = asyncio.run(tool.handler({"question": " Which page is slow? "}))
        (block,) = reply["content"]
        assert "end your turn" in block["text"]
        assert "(question: Which page is slow?)" in block["text"]
