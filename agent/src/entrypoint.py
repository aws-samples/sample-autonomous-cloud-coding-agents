"""Re-export shim for backward compatibility.

Existing callers (tests) that import from ``entrypoint`` continue
to work. New code should import from the specific module directly.
"""

import importlib as _importlib

# Reload config so that ``importlib.reload(entrypoint)`` picks up env changes
# (e.g. AGENT_WORKSPACE) — needed for backward-compatible test patterns.
import config as _config

_importlib.reload(_config)

from config import (  # noqa: F401
    AGENT_WORKSPACE,
    PR_TASK_TYPES,
    build_config,
    get_config,
    resolve_github_token,
)
from context import assemble_prompt, fetch_github_issue  # noqa: F401
from models import (  # noqa: F401
    AgentResult,
    GitHubIssue,
    HydratedContext,
    IssueComment,
    MemoryContext,
    RepoSetup,
    TaskConfig,
    TaskResult,
    TaskType,
    TokenUsage,
)
from pipeline import main, run_task  # noqa: F401
from post_hooks import (  # noqa: F401
    ensure_committed,
    ensure_pr,
    ensure_pushed,
    verify_build,
    verify_lint,
)
from prompt_builder import build_system_prompt as _build_system_prompt  # noqa: F401
from prompt_builder import discover_project_config as _discover_project_config  # noqa: F401
from runner import run_agent  # noqa: F401
from shell import log, redact_secrets, run_cmd, slugify, truncate  # noqa: F401
from telemetry import format_bytes, get_disk_usage, print_metrics  # noqa: F401

if __name__ == "__main__":
    main()
