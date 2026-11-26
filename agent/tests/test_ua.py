import contextlib
import json
from pathlib import Path

import boto3
import pytest
from botocore.awsrequest import AWSResponse
from botocore.config import Config

import ua

_VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "ua-vectors.json").read_text(
        encoding="utf-8"
    )
)


class TestSolutionId:
    def test_matches_contract(self):
        assert _VECTORS["solution_id"] == ua.SOLUTION_ID


class TestSanitize:
    def test_contract_has_vectors(self):
        assert _VECTORS["sanitize"]

    @pytest.mark.parametrize("vector", _VECTORS["sanitize"], ids=lambda vector: vector["note"])
    def test_sanitize_vectors(self, vector):
        assert ua.sanitize_ua_value(vector["input"]) == vector["expected"]


class TestStaticUserAgentExtra:
    def test_is_static_md_segment_only(self):
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
                ua_header.decode("ascii", "replace") if isinstance(ua_header, bytes) else ua_header
            )
            return AWSResponse("https://x", 200, {}, b"")

        client.meta.events.register("before-send.sts.*", _grab)
        with contextlib.suppress(Exception):
            client.get_caller_identity()
        return captured["ua"]

    def test_both_segments_present(self, monkeypatch):
        ua_header = self._capture_ua(monkeypatch, "uksb-wt64nei4u6#backgroundagent-dev")
        assert "app/uksb-wt64nei4u6#backgroundagent-dev" in ua_header
        assert "md/uksb-wt64nei4u6#agent" in ua_header

    def test_app_segment_omitted_when_env_unset(self, monkeypatch):
        ua_header = self._capture_ua(monkeypatch, None)
        assert "app/uksb-wt64nei4u6" not in ua_header
        assert "md/uksb-wt64nei4u6#agent" in ua_header

    def test_app_segment_omitted_when_env_empty(self, monkeypatch):
        ua_header = self._capture_ua(monkeypatch, "")
        assert "app/uksb-wt64nei4u6" not in ua_header
        assert "md/uksb-wt64nei4u6#agent" in ua_header
