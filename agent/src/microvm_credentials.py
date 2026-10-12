# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Runtime-only scoped credential endpoint for the MicroVM Claude subprocess.

AWS's container provider waits for replacement keys before signing after expiry.
The managed export helper deliberately returns no keys in this mode. The child
has no alternate AWS provider; the parent's runtime credential chain is untouched.
This protects provider selection, not isolation from code running as the same OS
user. Never start this server during image warm-up or snapshot validation.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TYPE_CHECKING

from aws_session import export_microvm_credentials

if TYPE_CHECKING:
    from collections.abc import Callable

    from microvm_lifecycle import MicrovmLifecycle


class ScopedCredentialBroker:
    """One task's loopback endpoint, owned and closed by its Claude session."""

    def __init__(
        self,
        lifecycle: MicrovmLifecycle,
        *,
        provider: Callable[[], dict[str, str]] | None = None,
    ) -> None:
        self._closed = threading.Event()
        token = secrets.token_urlsafe(32)
        resolve = provider or (lambda: export_microvm_credentials(lifecycle.task_id))
        closed = self._closed

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                # Authorization headers and response bodies contain credentials.
                del format, args

            def do_GET(self):
                if self.path != "/credentials":
                    self.send_error(404)
                    return
                if not hmac.compare_digest(self.headers.get("Authorization", ""), token):
                    self.send_error(403)
                    return
                try:
                    # Count the entire response in the suspend drain. Paused or
                    # failed lifecycle controllers reject before consulting AWS.
                    with lifecycle.activity():
                        if closed.is_set():
                            raise RuntimeError("Credential broker is closed")
                        body = json.dumps(resolve()).encode()
                        if closed.is_set():
                            raise RuntimeError("Credential broker closed during renewal")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                except Exception:
                    # Deliberately omit provider exception text/credentials.
                    # The caller fails closed; no ambient fallback is available.
                    self.send_error(503, "Scoped credentials unavailable")

        class Server(HTTPServer):
            def get_request(self):
                connection, address = super().get_request()
                connection.settimeout(2)
                return connection, address

            def handle_error(self, request, client_address):
                # A disconnected client may interrupt the generic 503 response.
                # No request/exception dumping from this credential endpoint.
                del request, client_address

        self._server = Server(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": 0.05},
            name="microvm-scoped-credentials",
            daemon=True,
        )
        # ClaudeAgentOptions.env overlays the parent environment; empty strings
        # suppress inherited providers. Controlled empty files also suppress
        # ~/.aws profile/SSO/process credentials without changing HOME.
        self.environment = {
            key: ""
            for key in os.environ
            if key.startswith("AWS_")
            and key not in {"AWS_REGION", "AWS_DEFAULT_REGION", "AWS_SDK_UA_APP_ID"}
        }
        self.environment.update(
            {
                "AWS_ACCESS_KEY_ID": "",
                "AWS_SECRET_ACCESS_KEY": "",
                "AWS_SESSION_TOKEN": "",
                "AWS_PROFILE": "",
                "AWS_DEFAULT_PROFILE": "",
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
                "AWS_WEB_IDENTITY_TOKEN_FILE": "",
                "AWS_ROLE_ARN": "",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI": (
                    f"http://127.0.0.1:{self._server.server_port}/credentials"
                ),
                "AWS_CONTAINER_AUTHORIZATION_TOKEN": token,
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "",
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_BEARER_TOKEN_BEDROCK": "",
                "ANTHROPIC_API_KEY": "",
                "ANTHROPIC_AUTH_TOKEN": "",
                "ABCA_MICROVM_CREDENTIAL_BROKER": "1",
            }
        )
        self._thread.start()

    def close(self) -> None:
        """Stop serving keys, then stop the loop before the task is torn down."""
        if self._closed.is_set():
            return
        self._closed.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
