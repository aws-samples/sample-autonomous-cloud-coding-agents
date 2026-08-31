"""Minimal SDK smoke test — run inside the deployed container.

Tests the actual claude-agent-sdk → Claude Code CLI → Bedrock pipeline
with a trivial prompt, outside the web server / background thread context.
If this yields 0 messages, the issue is SDK/CLI/Bedrock — not threading.

Usage (from repo root, with agent venv active):

    python agent/scripts/diagnostics/test_sdk_smoke.py

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
    # No hardcoded fallback: this file drifted to a model and geography the platform
    # no longer defaults to, so the diagnostic silently tested something other than
    # what runs. Require the caller to state it — a diagnostic that quietly probes the
    # wrong model is worse than one that refuses.
    model = os.environ.get("ANTHROPIC_MODEL", "")

    if not region:
        print("ERROR: AWS_REGION not set", file=sys.stderr)
        sys.exit(1)

    if not model:
        print(
            "ERROR: ANTHROPIC_MODEL not set. Pass the geo-prefixed inference-profile "
            "id the deployment uses, e.g. ANTHROPIC_MODEL=global.anthropic.claude-opus-5",
            file=sys.stderr,
        )
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

    ok = counts["assistant"] > 0 and counts["result"] > 0
    if ok:
        print("\nPASS — SDK yields messages for this model in this Region.")
        print("       Rules OUT the SDK/CLI/Bedrock path. It does not identify the")
        print("       cause of any other failure — threading is one candidate, not a")
        print("       conclusion this test can reach.")
    elif counts["system"] > 0 and counts["assistant"] == 0:
        print("\nFAIL — Got init but zero AssistantMessages.")
        print("       Same symptom as production. Issue is SDK/CLI level,")
        print("       NOT threading. Check:")
        print("         1. CLI stderr output above for errors")
        print("         2. Bedrock model availability / permissions")
        print("         3. SDK ↔ CLI version compatibility")
        try:
            import importlib.metadata

            cli_info = importlib.metadata.metadata("claude-agent-sdk")
            print(f"         SDK metadata: {cli_info.get('Version', 'unknown')}")
        except Exception:  # noqa: S110
            pass
    elif counts["system"] == 0:
        print("\nFAIL — Zero messages at all. CLI subprocess may not start.")
        print("       Check: is claude-code installed? Run: claude --version")
    else:
        # Reachable: assistant>0 but result==0 (the model spoke, the run never
        # terminated cleanly). Without this branch the script printed NO verdict at
        # all and still exited 1 — a diagnostic that fails silently is the thing this
        # file exists to rule out.
        print("\nINDETERMINATE — Got AssistantMessages but no ResultMessage.")
        print("       The model responded, so the SDK/CLI/Bedrock path works, but the")
        print("       run did not terminate normally. Treat as a FAILURE of this")
        print("       diagnostic, not evidence about the model. Check the CLI stderr")
        print("       above for a mid-stream error, and whether the run was killed")
        print("       (timeout, OOM, cancelled) before it could emit its result.")
    if errors:
        print(f"\nErrors: {errors}")

    # Exit code must match the verdict. It printed FAIL and exited 0, so any caller
    # that checked the status — CI, a script, a person using `&&` — read a failure as
    # success. A diagnostic that lies in its exit code is worse than no diagnostic.
    return ok


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(smoke_test()) else 1)
