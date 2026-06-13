"""Unit + wire-capture tests for ua.py (#319, simplified app-id design)."""

import contextlib

import boto3
import pytest
from botocore.awsrequest import AWSResponse
from botocore.config import Config

import ua


class TestSanitize:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("agent", "agent"),
            ("a/b", "a-b"),  # '/' is not a UA token char
            ("a#b", "a-b"),  # '#' is the scheme separator — must be stripped
            ("héllo", "h-llo"),  # non-ASCII -> '-'
            ("a b", "a-b"),  # space -> '-'
            ("ok-_.~!", "ok-_.~!"),  # legal token chars pass through
        ],
    )
    def test_sanitize_vectors(self, raw, expected):
        assert ua.sanitize_ua_value(raw) == expected


class TestStaticUserAgentExtra:
    def test_is_static_md_segment_only(self):
        # The app/ segment is the SDK's job (native AWS_SDK_UA_APP_ID); this
        # module emits only the md/ component segment.
        assert ua.static_user_agent_extra() == "md/uksb-wt64nei4u6#agent"

    def test_no_app_segment_built_here(self):
        assert "app/" not in ua.static_user_agent_extra()

    def test_client_config_carries_extra(self):
        cfg = ua.client_config()
        assert cfg.user_agent_extra == "md/uksb-wt64nei4u6#agent"


class TestWireCapture:
    """Capture the real outbound User-Agent header via a before-send stub
    that short-circuits the HTTP send (no network)."""

    def _capture_ua(self, monkeypatch, app_id):
        if app_id is None:
            monkeypatch.delenv("AWS_SDK_UA_APP_ID", raising=False)
        else:
            monkeypatch.setenv("AWS_SDK_UA_APP_ID", app_id)

        client = boto3.client(
            "sts",
            region_name="us-east-1",
            aws_access_key_id="x",
            aws_secret_access_key="y",
            config=Config(user_agent_extra=ua.static_user_agent_extra()),
        )
        captured = {}

        def _grab(request, **_kwargs):
            ua_header = request.headers.get("User-Agent")
            captured["ua"] = (
                ua_header.decode("ascii", "replace")
                if isinstance(ua_header, bytes)
                else ua_header
            )
            return AWSResponse("https://x", 200, {}, b"")

        client.meta.events.register("before-send.sts.*", _grab)
        with contextlib.suppress(Exception):
            # The short-circuit stub returns an empty body, so parsing fails;
            # we only need the header captured by _grab before that.
            client.get_caller_identity()
        return captured["ua"]

    def test_both_segments_present(self, monkeypatch):
        ua_header = self._capture_ua(monkeypatch, "uksb-wt64nei4u6#backgroundagent-dev")
        assert "app/uksb-wt64nei4u6#backgroundagent-dev" in ua_header
        assert "md/uksb-wt64nei4u6#agent" in ua_header

    def test_app_segment_omitted_when_env_unset(self, monkeypatch):
        ua_header = self._capture_ua(monkeypatch, None)
        assert "app/uksb-wt64nei4u6" not in ua_header
        # md/ still present — it does not depend on the env var
        assert "md/uksb-wt64nei4u6#agent" in ua_header

    def test_app_segment_omitted_when_env_empty(self, monkeypatch):
        ua_header = self._capture_ua(monkeypatch, "")
        assert "app/uksb-wt64nei4u6" not in ua_header
        assert "md/uksb-wt64nei4u6#agent" in ua_header
