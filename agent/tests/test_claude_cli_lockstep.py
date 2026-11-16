"""Lockstep: the image installs the Claude Code CLI version that the SDK bundles.

The agent has Claude Code twice. ``claude-agent-sdk`` (pinned in
``pyproject.toml``) ships a CLI inside its wheel and records that CLI's version;
``Dockerfile`` installs ``@anthropic-ai/claude-code`` from npm onto PATH. The SDK
drives the CLI over a control protocol, so both must be the same version (#215).
The two pins live in different ecosystems and a dependency update moves one of
them alone. This test is what holds them together: before it, the lockstep was a
comment beside each pin.

It reads the Dockerfile as text. It sees every command that names the package,
with a version or without, but not what the command does with it, and not a CLI
that reaches the image some other way.
"""

import re
from importlib.metadata import version
from pathlib import Path

# Hard import: if a later SDK stops recording its bundled CLI version in this
# module, read the version from where that SDK records it. Do not drop the test.
from claude_agent_sdk._cli_version import __cli_version__ as bundled_cli_version

_DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"
# The package as a command argument, with its version when that is a literal one.
# Inside a path ("$(npm root -g)/@anthropic-ai/claude-code") it is not an argument.
_CLI_PACKAGE = re.compile(r"(?<![\w/])@anthropic-ai/claude-code(?![\w/-])(?:@([\w.+-]+))?")


def test_dockerfile_installs_the_cli_version_the_sdk_bundles() -> None:
    named = [
        (number, mention.group(1))
        for number, line in enumerate(_DOCKERFILE.read_text(encoding="utf-8").splitlines(), 1)
        if not line.lstrip().startswith("#")
        for mention in _CLI_PACKAGE.finditer(line)
    ]
    assert len(named) == 1 and named[0][1], (
        "agent/Dockerfile must name the Claude Code CLI package as a command argument exactly "
        "once, and at a literal version (`npm install -g @anthropic-ai/claude-code@<version>`), "
        "so that the version can be compared with the CLI that claude-agent-sdk bundles "
        f"({bundled_cli_version}). Found outside comments, as (line, version): {named}. None "
        "stands for a command that names the package without a literal version: it installs "
        "or updates to whatever npm serves that day. If the image now gets the CLI another "
        "way, change this test to read the version from there."
    )
    line, installed = named[0]
    assert installed == bundled_cli_version, (
        f"agent/Dockerfile:{line} installs @anthropic-ai/claude-code@{installed}, but "
        f"claude-agent-sdk {version('claude-agent-sdk')} (pinned in agent/pyproject.toml) "
        f"bundles Claude Code CLI {bundled_cli_version}. The two must be the same version: "
        "the SDK drives the CLI over a control protocol (#215). Change the Dockerfile line to "
        f"@anthropic-ai/claude-code@{bundled_cli_version}, or pin the claude-agent-sdk release "
        f"that bundles {installed}, and correct the version in the comment beside each pin."
    )
