"""Outbound AWS SDK User-Agent solution attribution (#319).

Every AWS API call made by the agent carries two ABCA solution-attribution
segments in the ``User-Agent`` header:

    app/uksb-wt64nei4u6#{STACKNAME}      <- native AWS_SDK_UA_APP_ID env (no code here)
    md/uksb-wt64nei4u6#agent             <- static, baked once at construction

**The ``app/`` segment is emitted by the SDK itself.** Both botocore and the
JS v3 SDK read the ``AWS_SDK_UA_APP_ID`` environment variable natively and
render it as ``app/{value}`` (botocore ``configprovider.py`` maps it to the
``user_agent_appid`` config; the value charset *includes* ``#``, so the
``uksb-wt64nei4u6#{stack}`` form survives verbatim). CDK sets that env var on
every Lambda / AgentCore runtime / ECS container, so this module contributes
**nothing** to ``app/`` — and a customer can suppress it by setting the env
var to the empty string. (This is the key simplification over the original
``/``-separated design, which had to bypass the native field because ``/`` is
not a legal app-id character. Using ``#`` keeps it native.)

This module owns only the **static ``md/`` segment** — a stable
per-component label baked once via ``user_agent_extra`` at session/client
construction. There is intentionally no per-request trace handle and no
event/middleware machinery: connection pools are never re-pinned, and
request correlation is owned by X-Ray / structured-log request ids (#245),
not the User-Agent.

The TypeScript counterparts are ``cdk/src/handlers/shared/ua.ts`` and
``cli/src/ua.ts`` — the solution id, wire format, and sanitization rules
must stay identical across all three.
"""

from __future__ import annotations

import string
from typing import Any

# AWS solution-attribution id for ABCA. Also appears (deploy-time
# counterpart, #292) in the CloudFormation stack description in
# ``cdk/src/main.ts`` and in the TS mirrors of this module. Per-surface
# literal by design.
SOLUTION_ID = "uksb-wt64nei4u6"

# Stable per-component label: this surface IS the Python agent runtime.
COMPONENT = "agent"

# RFC 7230 token charset (the UA product-token alphabet). '#' is the
# scheme's structural separator and is deliberately NOT here, so a hostile
# component/label value cannot inject extra segments.
_ALLOWED = frozenset(string.ascii_letters + string.digits + "!$%&'*+-.^_`|~")


def sanitize_ua_value(raw: str) -> str:
    """Replace every non-UA-token char (incl. non-ASCII) with ``-``."""
    return "".join(c if c in _ALLOWED else "-" for c in raw)


def static_user_agent_extra() -> str:
    """The static ``md/`` segment baked at client/session construction.

    Always ``md/{SOLUTION_ID}#{COMPONENT}`` — the ``app/`` segment is
    contributed separately by the SDK from ``AWS_SDK_UA_APP_ID`` and is not
    this module's concern.
    """
    return f"md/{SOLUTION_ID}#{sanitize_ua_value(COMPONENT)}"


def client_config() -> Any:
    """``botocore.config.Config`` carrying the static ``md/`` segment.

    For direct ``boto3.client(...)`` call sites that don't go through a
    shared session (see ``aws_session.platform_client``). Merge-friendly:
    callers that already pass a ``Config`` should use ``.merge(...)``.
    """
    from botocore.config import Config

    return Config(user_agent_extra=static_user_agent_extra())
