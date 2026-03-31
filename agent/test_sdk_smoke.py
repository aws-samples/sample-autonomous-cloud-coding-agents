"""Minimal SDK smoke test — run inside the deployed container.

Tests the actual claude-agent-sdk → Claude Code CLI → Bedrock pipeline
with a trivial prompt, outside the web server / background thread context.
If this yields 0 messages, the issue is SDK/CLI/Bedrock — not threading.

Usage (inside the running container via ECS Exec or docker exec):

    python /app/test_sdk_smoke.py

Requires the same env vars as the agent:
    CLAUDE_CODE_USE_BEDROCK=1
    AWS_REGION=<region>
    ANTHROPIC_MODEL=<model>

Or set them manually before running.
"""

import asyncio
import os
import sys
import time


async def smoke_test():
    # Ensure required env vars
    os.environ.setdefault("CLAUDE_CODE_USE_BEDROCK", "1")
    region = os.environ.get("AWS_REGION", "")
    model = os.environ.get("ANTHROPIC_MODEL", "us.anthropic.claude-sonnet-4-6")

    if not region:
        print("ERROR: AWS_REGION not set", file=sys.stderr)
        sys.exit(1)

    print(f"Region:  {region}")
    print(f"Model:   {model}")
    print(f"Python:  {sys.version}")
    print()

    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ResultMessage,
        SystemMessage,
    )

    counts = {"system": 0, "assistant": 0, "result": 0, "other": 0}
    errors: list[str] = []

    def on_stderr(line: str):
        line = line.rstrip()
        if line:
            print(f"  [CLI stderr] {line}", flush=True)

    options = ClaudeAgentOptions(
        model=model,
        system_prompt="You are a helpful assistant. Respond in one short sentence.",
        allowed_tools=[],
        permission_mode="bypassPermissions",
        cwd="/tmp",  # noqa: S108
        max_turns=1,
        stderr=on_stderr,
    )

    prompt = "Say exactly: Hello world"

    print(f"Sending prompt: {prompt!r}")
    print("Max turns: 1")
    print()

    client = ClaudeSDKClient(options=options)
    start = time.time()
    try:
        print("  Connecting to Claude Code CLI...")
        await client.connect()
        print(f"  Connected ({time.time() - start:.1f}s). Sending prompt...")
        await client.query(prompt=prompt)
        print("  Prompt sent. Receiving messages...")
        async for message in client.receive_response():
            elapsed = time.time() - start
            if isinstance(message, SystemMessage):
                counts["system"] += 1
                print(f"  [{elapsed:.1f}s] SystemMessage: {message.subtype}")
            elif isinstance(message, AssistantMessage):
                counts["assistant"] += 1
                # Print first text block
                for block in message.content:
                    if hasattr(block, "text"):
                        text = block.text if isinstance(block.text, str) else str(block.text)
                        print(f"  [{elapsed:.1f}s] AssistantMessage: {text[:200]}")
                        break
            elif isinstance(message, ResultMessage):
                counts["result"] += 1
                print(
                    f"  [{elapsed:.1f}s] ResultMessage: status={message.subtype} "
                    f"turns={message.num_turns} cost=${message.total_cost_usd or 0:.4f}"
                )
            else:
                counts["other"] += 1
                print(f"  [{elapsed:.1f}s] {type(message).__name__}: {str(message)[:200]}")
    except Exception as e:
        errors.append(f"{type(e).__name__}: {e}")
        print(f"\n  EXCEPTION: {type(e).__name__}: {e}")

    elapsed = time.time() - start
    print()
    print(f"Duration: {elapsed:.1f}s")
    print(f"Counts:   {counts}")

    if counts["assistant"] > 0 and counts["result"] > 0:
        print("\nPASS — SDK yields messages. Issue is specific to the")
        print("       server threading context, not SDK/CLI/Bedrock.")
    elif counts["system"] > 0 and counts["assistant"] == 0:
        print("\nFAIL — Got init but zero AssistantMessages.")
        print("       Same symptom as production. Issue is SDK/CLI level,")
        print("       NOT threading. Check:")
        print("         1. CLI stderr output above for errors")
        print("         2. Bedrock model availability / permissions")
        print("         3. SDK ↔ CLI version compatibility")
        print("         SDK: claude-agent-sdk==0.1.43")
        try:
            import importlib.metadata

            cli_info = importlib.metadata.metadata("claude-agent-sdk")
            print(f"         SDK metadata: {cli_info.get('Version', 'unknown')}")
        except Exception:  # noqa: S110
            pass
    elif counts["system"] == 0:
        print("\nFAIL — Zero messages at all. CLI subprocess may not start.")
        print("       Check: is claude-code installed? Run: claude --version")
    if errors:
        print(f"\nErrors: {errors}")


if __name__ == "__main__":
    asyncio.run(smoke_test())
