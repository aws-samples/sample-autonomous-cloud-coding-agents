#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Isolated MicroVM transport probe; never import into the application runtime.

Serve the six lifecycle hooks using only Python's standard library. Logs contain
request boundaries, listener health and a disposable marker's hash, without AWS
calls or credentials. The explicit ``close_listener`` mode is a failure control.
Use only in an owned diagnostic image with no ingress and a bounded VM lifetime.
"""

from __future__ import annotations

import argparse
import faulthandler
import hashlib
import json
import os
import signal
import socket
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PREFIX = "/aws/lambda-microvms/runtime/v1/"
HOOKS = {"ready", "validate", "run", "suspend", "resume", "terminate"}
MAX_BODY_BYTES = 16_384
MAX_CASE_ID_LENGTH = 100


def emit(event: str, **fields: object) -> None:
    """One short stdout write, independent of AWS clients and logging threads."""
    record = {
        "event": event,
        "wall_s": time.time(),
        "monotonic_s": time.monotonic(),
        "pid": os.getpid(),
        **fields,
    }
    os.write(1, (json.dumps(record, sort_keys=True) + "\n").encode())


class ProbeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str, port: int) -> None:
        self.lock = threading.RLock()
        self.case_id = ""
        self.mode = "normal"
        self.phase = "image"
        self.suspends = 0
        self.resumes = 0
        self.marker_hash = ""
        self.marker = Path(tempfile.gettempdir()) / f"abca-listener-probe-{os.getpid()}"
        super().__init__((host, port), ProbeHandler)

    def health(self) -> dict[str, object]:
        try:
            listening: object = bool(
                self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN)
            )
        except OSError as exc:
            listening = type(exc).__name__
        return {
            "listening": listening,
            "threads": threading.active_count(),
            "case_id": self.case_id,
            "phase": self.phase,
            "suspends": self.suspends,
            "resumes": self.resumes,
            "marker_hash": self.marker_hash,
        }


class ProbeHandler(BaseHTTPRequestHandler):
    server: ProbeServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        # Request headers and service payloads are deliberately not logged.
        return

    def do_POST(self) -> None:
        hook = self.path.removeprefix(PREFIX)
        if not self.path.startswith(PREFIX) or hook not in HOOKS:
            self.respond(404, {"code": "UNKNOWN_HOOK"})
            return
        emit("hook_enter", hook=hook, **self.server.health())
        try:
            self.connection.settimeout(2)
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= MAX_BODY_BYTES:
                raise ValueError("Invalid body length")
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("Truncated body")
            envelope = json.loads(body) if body else {}
            if not isinstance(envelope, dict):
                raise ValueError("Expected object")
            self.transition(hook, envelope)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            emit("hook_error", hook=hook, error_type=type(exc).__name__)
            self.respond(409, {"code": "PROBE_REJECTED"})

    def transition(self, hook: str, envelope: dict) -> None:
        server = self.server
        close_listener = False
        with server.lock:
            if hook == "run":
                payload = json.loads(envelope["runHookPayload"])
                case_id, mode = payload["case_id"], payload.get("mode", "normal")
                if (
                    not isinstance(case_id, str)
                    or not 1 <= len(case_id) <= MAX_CASE_ID_LENGTH
                    or mode not in {"normal", "close_listener"}
                ):
                    raise ValueError("Invalid probe configuration")
                if server.case_id and (server.case_id != case_id or server.mode != mode):
                    raise ValueError("Conflicting run")
                if not server.case_id:
                    server.case_id, server.mode = case_id, mode
                    marker = os.urandom(32)
                    server.marker.write_bytes(marker)
                    server.marker_hash = hashlib.sha256(marker).hexdigest()
                    server.phase = "running"
            elif hook == "suspend":
                if server.phase == "running":
                    server.phase = "suspended"
                    server.suspends += 1
                    close_listener = server.mode == "close_listener"
                elif server.phase != "suspended":
                    raise ValueError("No running probe")
            elif hook == "resume":
                if server.phase == "suspended":
                    if hashlib.sha256(server.marker.read_bytes()).hexdigest() != server.marker_hash:
                        raise ValueError("Marker changed")
                    server.resumes += 1
                    server.phase = "running"
                elif server.phase != "running":
                    raise ValueError("No suspended probe")
            elif hook == "terminate":
                server.phase = "terminating"

        if close_listener:
            # Close only the listening socket; this accepted /suspend connection
            # can still send its response. The process stays alive for diagnostics.
            server.shutdown()
            server.server_close()
            emit("listener_closed_intentionally", **server.health())
        result = {"status": "acknowledged", "hook": hook, **server.health()}
        emit("hook_ack", **result)
        self.respond(200, result)

    def respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Make every service hook establish a connection to the listener.
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        self.close_connection = True


def observe(server: ProbeServer) -> None:
    previous_wall, previous_monotonic = time.time(), time.monotonic()
    tick = 0
    while True:
        time.sleep(0.25)
        wall, monotonic = time.time(), time.monotonic()
        wall_gap, monotonic_gap = wall - previous_wall, monotonic - previous_monotonic
        tick += 1
        if wall_gap > 1 or monotonic_gap > 1 or tick % 20 == 0:
            emit(
                "listener_observation",
                wall_gap_s=wall_gap,
                monotonic_gap_s=monotonic_gap,
                **server.health(),
            )
        previous_wall, previous_monotonic = wall, monotonic


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    faulthandler.enable()

    def stop(signum: int, _frame: object) -> None:
        emit("process_signal", signal=signum)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server = ProbeServer(args.host, args.port)
    threading.Thread(target=observe, args=(server,), daemon=True).start()
    emit("listener_started", port=server.server_port, **server.health())
    try:
        server.serve_forever(poll_interval=0.05)
        # The negative control intentionally stops acceptance, not the process.
        threading.Event().wait()
    finally:
        server.server_close()
        server.marker.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
