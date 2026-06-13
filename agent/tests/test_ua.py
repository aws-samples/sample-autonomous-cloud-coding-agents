# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for the outbound SDK User-Agent solution tracking (ua)."""

from __future__ import annotations

import threading

import pytest

from ua import (
    COMPONENT,
    SOLUTION_ID,
    STACK_NAME_ENV,
    client_config,
    get_trace,
    register_trace_appender,
    sanitize_ua_value,
    set_trace,
    static_user_agent_extra,
)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    """Clear trace state and the stack-name env var between tests."""
    monkeypatch.delenv(STACK_NAME_ENV, raising=False)
    set_trace(None)
    yield
    set_trace(None)


class TestSanitizeUaValue:
    def test_passthrough_for_token_safe_chars(self):
        assert sanitize_ua_value("backgroundagent-dev") == "backgroundagent-dev"
        assert sanitize_ua_value("A1!$%&'*+-.^_`|~z") == "A1!$%&'*+-.^_`|~z"

    def test_structural_separators_replaced(self):
        # '/' and '#' are the structural separators of the UA scheme and are
        # NOT in the UA token charset — both must become '-'.
        assert sanitize_ua_value("a/b#c") == "a-b-c"

    def test_non_ascii_replaced(self):
        assert sanitize_ua_value("stäck") == "st-ck"
        assert sanitize_ua_value("名前") == "--"

    def test_whitespace_and_controls_replaced(self):
        assert sanitize_ua_value("a b\tc\nd") == "a-b-c-d"

    def test_empty(self):
        assert sanitize_ua_value("") == ""


class TestStaticUserAgentExtra:
    def test_without_stack_name_omits_app_segment(self):
        extra = static_user_agent_extra()
        assert extra == f"md/{SOLUTION_ID}#{COMPONENT}"
        assert "app/" not in extra

    def test_with_stack_name(self, monkeypatch):
        monkeypatch.setenv(STACK_NAME_ENV, "backgroundagent-dev")
        extra = static_user_agent_extra()
        assert extra == (f"app/{SOLUTION_ID}/backgroundagent-dev md/{SOLUTION_ID}#{COMPONENT}")

    def test_stack_name_sanitized_then_clipped(self, monkeypatch):
        # Sanitize FIRST, then clip to 34 — a multi-byte char near the cut
        # must already be '-' before clipping.
        hostile = "my/stack#nämé" + "x" * 40
        monkeypatch.setenv(STACK_NAME_ENV, hostile)
        extra = static_user_agent_extra()
        app_value = extra.split(" ")[0].removeprefix("app/")
        assert app_value.startswith(f"{SOLUTION_ID}/my-stack-n-m-")
        # uksb-wt64nei4u6/ (16) + clipped stack (<=34) <= 50.
        assert len(app_value) <= 50
        stack_part = app_value.removeprefix(f"{SOLUTION_ID}/")
        assert len(stack_part) == 34
        assert "/" not in stack_part and "#" not in stack_part

    def test_longest_realistic_stack_name_within_budget(self, monkeypatch):
        # CloudFormation stack names max out at 128 chars [A-Za-z0-9-].
        monkeypatch.setenv(STACK_NAME_ENV, "a" * 128)
        app_value = static_user_agent_extra().split(" ")[0].removeprefix("app/")
        assert len(app_value) == 50

    def test_blank_stack_name_omits_app_segment(self, monkeypatch):
        monkeypatch.setenv(STACK_NAME_ENV, "   ")
        assert static_user_agent_extra() == f"md/{SOLUTION_ID}#{COMPONENT}"


class TestTraceState:
    def test_default_none(self):
        assert get_trace() is None

    def test_set_and_get(self):
        set_trace("01KTVYABCDEF")
        assert get_trace() == "01KTVYABCDEF"

    def test_sanitized_on_read(self):
        set_trace("trace/with#bad chars")
        assert get_trace() == "trace-with-bad-chars"

    def test_none_and_empty_clear(self):
        set_trace("x")
        set_trace(None)
        assert get_trace() is None
        set_trace("y")
        set_trace("")
        assert get_trace() is None

    def test_thread_safe_set(self):
        # Smoke test: concurrent set_trace calls must not corrupt state.
        def _spin(val: str):
            for _ in range(200):
                set_trace(val)

        threads = [threading.Thread(target=_spin, args=(f"t{i}",)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert get_trace() in {"t0", "t1", "t2", "t3"}


class TestClientConfig:
    def test_config_carries_static_extra(self, monkeypatch):
        monkeypatch.setenv(STACK_NAME_ENV, "mystack")
        cfg = client_config()
        assert cfg.user_agent_extra == static_user_agent_extra()


class TestWireCapture:
    """Capture the actual outbound User-Agent header at the wire layer.

    Uses a real botocore client with fake credentials and a registered
    ``before-send`` stub that short-circuits the HTTP send by returning a
    canned AWSResponse — no network, no moto.
    """

    @pytest.fixture()
    def capture(self, monkeypatch):
        import boto3
        from botocore.awsrequest import AWSResponse

        monkeypatch.setenv(STACK_NAME_ENV, "backgroundagent-dev")

        session = boto3.Session(
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
            region_name="us-east-1",
        )
        client = session.client("sts", config=client_config())
        register_trace_appender(client.meta.events)

        captured: list[str] = []

        def _short_circuit(request, **kwargs):
            # At the before-send stage the prepared request's header values
            # can be bytes; normalize so assertions read naturally.
            value = request.headers["User-Agent"]
            captured.append(value.decode("ascii") if isinstance(value, bytes) else value)
            body = (
                b"<GetCallerIdentityResponse "
                b'xmlns="https://sts.amazonaws.com/doc/2011-06-15/">'
                b"<GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/t</Arn>"
                b"<UserId>AIDA</UserId><Account>123456789012</Account>"
                b"</GetCallerIdentityResult></GetCallerIdentityResponse>"
            )
            return AWSResponse(url=request.url, status_code=200, headers={}, raw=_FakeRaw(body))

        # register_last so it runs AFTER the trace appender (register order
        # within the same event is what guarantees we see the final header).
        client.meta.events.register_last("before-send.sts.GetCallerIdentity", _short_circuit)
        return client, captured

    def test_both_segments_intact_no_trace(self, capture):
        client, captured = capture
        client.get_caller_identity()
        ua_header = captured[0]
        # Literal '/' in the app segment survived (raw path, NOT app-id field).
        assert f"app/{SOLUTION_ID}/backgroundagent-dev" in ua_header
        # Trace-absent: md segment ends exactly at the component label.
        assert ua_header.endswith(f"md/{SOLUTION_ID}#{COMPONENT}")
        assert not ua_header.endswith("#")

    def test_trace_appended_per_request_same_client(self, capture):
        client, captured = capture
        set_trace("01KTVYTRACE1")
        client.get_caller_identity()
        set_trace("01KTVYTRACE2")
        client.get_caller_identity()
        set_trace(None)
        client.get_caller_identity()
        assert captured[0].endswith(f"md/{SOLUTION_ID}#{COMPONENT}#01KTVYTRACE1")
        assert captured[1].endswith(f"md/{SOLUTION_ID}#{COMPONENT}#01KTVYTRACE2")
        assert captured[2].endswith(f"md/{SOLUTION_ID}#{COMPONENT}")

    def test_trace_sanitized_at_wire(self, capture):
        client, captured = capture
        set_trace("evil/trace#☃ value")
        client.get_caller_identity()
        assert captured[0].endswith(f"md/{SOLUTION_ID}#{COMPONENT}#evil-trace---value")


class _FakeRaw:
    """Minimal raw-body shim for AWSResponse."""

    def __init__(self, data: bytes):
        self._data = data

    def read(self, *args, **kwargs):
        data, self._data = self._data, b""
        return data

    def stream(self, *args, **kwargs):  # pragma: no cover - botocore fallback
        yield self.read()
