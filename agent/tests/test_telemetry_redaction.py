from __future__ import annotations

from telemetry import _metrics_payload_for_logging


class TestErrorScanning:
    def test_structural_error_passes_through(self) -> None:
        err = "missing built-in hard-deny policies: /app/policies/hard_deny.cedar"
        out = _metrics_payload_for_logging({"error": err, "status": "error"})
        assert out["error"] == err
        assert out["status"] == "error"

    def test_benign_short_error_passes_through(self) -> None:
        out = _metrics_payload_for_logging({"error": "ECONNREFUSED"})
        assert out["error"] == "ECONNREFUSED"

    def test_empty_string_error_passes_through(self) -> None:
        out = _metrics_payload_for_logging({"error": ""})
        assert out["error"] == ""

    def test_none_error_stays_none(self) -> None:
        out = _metrics_payload_for_logging({"error": None})
        assert out["error"] is None

    def test_aws_access_key_redacted(self) -> None:
        leaked = "AKIA" + "IOSFODNN7EXAMPLE"
        err = f"HTTP 403 with key {leaked} in request"
        out = _metrics_payload_for_logging({"error": err})
        assert out["error"] == "HTTP 403 with key [REDACTED-AWS_KEY] in request"

    def test_bearer_token_redacted(self) -> None:
        err = "401 Unauthorized: Bearer abcdefghijklmnop1234567890"
        out = _metrics_payload_for_logging({"error": err})
        assert out["error"] == "401 Unauthorized: [REDACTED-BEARER_TOKEN]"

    def test_connection_string_redacted(self) -> None:
        err = "connect error: postgres://app_user:s3cretPW@db.example.com/prod"
        out = _metrics_payload_for_logging({"error": err})
        assert out["error"] == "connect error: [REDACTED-CONNECTION_STRING]"


class TestNonErrorFieldsUntouched:
    def test_primitives_preserved(self) -> None:
        out = _metrics_payload_for_logging(
            {
                "cost_usd": 0.12,
                "turns": 5,
                "build_ok": True,
                "duration_s": None,
            }
        )
        assert out == {"cost_usd": 0.12, "turns": 5, "build_ok": True, "duration_s": None}

    def test_non_primitive_stringified(self) -> None:
        out = _metrics_payload_for_logging({"tags": ["a", "b"]})
        assert out["tags"] == "['a', 'b']"

    def test_numeric_error_passes_through_unscanned(self) -> None:
        out = _metrics_payload_for_logging({"error": 127})
        assert out["error"] == 127
