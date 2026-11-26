"""In-process ``request_clarification`` SDK tool (clarify-before-spend, UX #4).

Defines the tool as an in-process SDK MCP server. The tool just acknowledges the
call: the runner registers the server and captures the question from the
``ToolUseBlock``, and the pipeline treats a captured question as a hold-and-ask
(no build, no PR).
"""

from __future__ import annotations

from typing import Any

CLARIFICATION_SERVER_NAME = "abca"
# The SDK exposes each tool of an MCP server as ``mcp__<server>__<tool>``.
CLARIFICATION_TOOL_NAME = f"mcp__{CLARIFICATION_SERVER_NAME}__request_clarification"


def build_clarification_server() -> Any:
    """Build the in-process SDK MCP server exposing ``request_clarification``.

    Returns the SDK server config dict for ``ClaudeAgentOptions(mcp_servers=...)``.
    """
    from claude_agent_sdk import create_sdk_mcp_server, tool

    @tool(
        "request_clarification",
        (
            "Ask the requester ONE clarifying question and STOP, instead of guessing, "
            "when the task is too underspecified to implement without picking among "
            "materially different interpretations (e.g. 'make it faster' with no target "
            "or slow path named). Calling this opens NO pull request and charges nothing "
            "for a guess — the platform surfaces your question to the requester. Only "
            "call it for genuinely ambiguous goal-without-substance requests; a task that "
            "names what to change is actionable, so just do it."
        ),
        {"question": str},
    )
    async def request_clarification(args: dict[str, Any]) -> dict[str, Any]:
        question = str(args.get("question", "")).strip()
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Clarifying question recorded and will be posted to the requester. "
                        "Do not make code changes or open a PR — end your turn now."
                        + (f" (question: {question})" if question else "")
                    ),
                }
            ]
        }

    return create_sdk_mcp_server(name=CLARIFICATION_SERVER_NAME, tools=[request_clarification])
