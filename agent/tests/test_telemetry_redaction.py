"""Tests for ``telemetry._metrics_payload_for_logging``.

The old implementation blanket-substituted ``[redacted]`` on every value
under ``_METRICS_REDACT_KEYS`` (just ``error``). That swallowed
legitimate structural-error strings like ``missing built-in hard-deny
policies: /app/policies/hard_deny.cedar`` whose diagnostic value is
high and secret-risk is zero — see E2E 2026-05-11 T2.2.

The new implementation routes ``error`` values through
``output_scanner.scan_tool_output`` and only substitutes
``[REDACTED-<LABEL>]`` on a real secret-pattern match.
"""

from __future__ import annotations

from telemetry import _metrics_payload_for_logging


class TestErrorScanning:
    def test_structural_error_passes_through(self) -> None:
        # The canonical case from T2.2: a file-not-found style error that
        # has no secrets in it. Under the old code this turned into
        # ``"[redacted]"``; under the new code it survives verbatim.
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
        # Assemble the literal from fragments so git-defender doesn't
        # block this test fixture (per the project's
        # ``feedback_code_defender_secret_fixtures`` rule).
        leaked = "AKIA" + "IOSFODNN7EXAMPLE"
        err = f"HTTP 403 with key {leaked} in request"
        out = _metrics_payload_for_logging({"error": err})
        assert leaked not in out["error"]
        assert "[REDACTED-AWS_KEY]" in out["error"]

    def test_bearer_token_redacted(self) -> None:
        err = "401 Unauthorized: Bearer abcdefghijklmnop1234567890"
        out = _metrics_payload_for_logging({"error": err})
        assert "abcdefghijklmnop1234567890" not in out["error"]
        assert "[REDACTED-BEARER_TOKEN]" in out["error"]

    def test_connection_string_redacted(self) -> None:
        err = "connect error: postgres://app_user:s3cretPW@db.example.com/prod"
        out = _metrics_payload_for_logging({"error": err})
        assert "s3cretPW" not in out["error"]
        assert "[REDACTED-CONNECTION_STRING]" in out["error"]


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
        # Some agent paths write exit codes into ``error``. Scanner is
        # string-only; numeric values bypass the scanner and preserve
        # type so downstream log queries can still filter on them.
        out = _metrics_payload_for_logging({"error": 127})
        assert out["error"] == 127
