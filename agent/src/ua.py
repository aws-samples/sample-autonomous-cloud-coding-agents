from __future__ import annotations

import string
from typing import Any

SOLUTION_ID = "uksb-wt64nei4u6"

COMPONENT = "agent"

# RFC 7230 token characters, without '#'.
_ALLOWED = frozenset(string.ascii_letters + string.digits + "!$%&'*+-.^_`|~")


def sanitize_ua_value(raw: str) -> str:
    """Replace every non-UA-token char (incl. non-ASCII) with ``-``."""
    return "".join(c if c in _ALLOWED else "-" for c in raw)


def static_user_agent_extra() -> str:
    """The static ``md/`` segment: always ``md/{SOLUTION_ID}#{COMPONENT}``.

    botocore adds the ``app/`` segment itself, from ``AWS_SDK_UA_APP_ID``.
    """
    return f"md/{SOLUTION_ID}#{sanitize_ua_value(COMPONENT)}"


def client_config() -> Any:
    """``botocore.config.Config`` carrying the static ``md/`` segment.

    Callers that already pass a ``Config`` should use ``.merge(...)``.
    """
    from botocore.config import Config

    return Config(user_agent_extra=static_user_agent_extra())
