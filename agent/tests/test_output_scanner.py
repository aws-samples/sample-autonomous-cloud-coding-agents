"""Unit tests for output_scanner.py — secret/PII detection and redaction."""

from output_scanner import ScanResult, scan_tool_output


class TestScanResultDefaults:
    def test_clean_result(self):
        r = ScanResult(has_sensitive_content=False, redacted_content="hello")
        assert r.findings == []
        assert r.duration_ms == 0.0


class TestScanToolOutput:
    # ---- AWS keys ----

    def test_detects_aws_access_key(self):
        content = "key=AKIAIOSFODNN7EXAMPLE"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "AWS_KEY detected" in result.findings
        assert "AKIAIOSFODNN7EXAMPLE" not in result.redacted_content
        assert "[REDACTED-AWS_KEY]" in result.redacted_content

    def test_detects_aws_secret_key(self):
        content = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "AWS_SECRET detected" in result.findings
        assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in result.redacted_content

    def test_detects_aws_secret_key_case_insensitive(self):
        content = 'SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "AWS_SECRET detected" in result.findings

    # ---- GitHub tokens ----

    def test_detects_ghp_token(self):
        content = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_TOKEN detected" in result.findings
        assert "ghp_" not in result.redacted_content
        assert "[REDACTED-GITHUB_TOKEN]" in result.redacted_content

    def test_detects_gho_token(self):
        content = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_TOKEN detected" in result.findings

    def test_detects_ghs_token(self):
        content = "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_TOKEN detected" in result.findings

    def test_detects_github_fine_grained_pat(self):
        content = "github_pat_ABCDEFGHIJKLMNOPQRSTUV_12345678901234567890"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "GITHUB_PAT detected" in result.findings
        assert "[REDACTED-GITHUB_PAT]" in result.redacted_content

    # ---- Private keys ----

    def test_detects_rsa_private_key(self):
        content = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEowIBAAKCAQEA0Z3VS5JJcds3xf...\n"
            "-----END RSA PRIVATE KEY-----"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings
        assert "BEGIN RSA PRIVATE KEY" not in result.redacted_content
        assert "[REDACTED-PRIVATE_KEY]" in result.redacted_content

    def test_detects_generic_private_key(self):
        content = (
            "-----BEGIN PRIVATE KEY-----\n"
            "MIIEvQIBADANBgkqhkiG9w0BAQEFA...\n"
            "-----END PRIVATE KEY-----"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings

    def test_detects_ec_private_key(self):
        content = "-----BEGIN EC PRIVATE KEY-----\nMIGkAgEBBDDx...\n-----END EC PRIVATE KEY-----"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings

    def test_detects_openssh_private_key(self):
        content = (
            "-----BEGIN OPENSSH PRIVATE KEY-----\n"
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUA...\n"
            "-----END OPENSSH PRIVATE KEY-----"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "PRIVATE_KEY detected" in result.findings

    # ---- Bearer tokens ----

    def test_detects_bearer_token(self):
        content = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.xyz"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "BEARER_TOKEN detected" in result.findings
        assert "[REDACTED-BEARER_TOKEN]" in result.redacted_content

    def test_detects_bearer_token_case_insensitive(self):
        content = "authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.xyz"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "BEARER_TOKEN detected" in result.findings

    def test_no_false_positive_on_bearer_english(self):
        content = "The bearer of good news arrived early."
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    # ---- Connection strings ----

    def test_detects_connection_string(self):
        content = "DATABASE_URL=postgres://admin:s3cretP4ss@db.example.com:5432/mydb"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "CONNECTION_STRING detected" in result.findings
        assert "s3cretP4ss" not in result.redacted_content

    def test_detects_redis_connection_string(self):
        content = "redis://user:password123@redis.example.com:6379/0"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert "CONNECTION_STRING detected" in result.findings

    def test_connection_string_no_catastrophic_backtracking(self):
        """Protocol-name cap prevents pathological regex time."""
        import time

        content = "a" * 50 + "://" + "b" * 10000 + ":c@d"
        start = time.monotonic()
        scan_tool_output(content)
        elapsed_ms = (time.monotonic() - start) * 1000
        assert elapsed_ms < 1000

    # ---- Multiple findings ----

    def test_detects_multiple_secrets(self):
        content = (
            "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n"
            "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is True
        assert len(result.findings) >= 2
        assert "AKIAIOSFODNN7EXAMPLE" not in result.redacted_content
        assert "ghp_" not in result.redacted_content

    # ---- Surrounding content preserved ----

    def test_preserves_surrounding_content(self):
        content = "before AKIAIOSFODNN7EXAMPLE after"
        result = scan_tool_output(content)
        assert result.redacted_content == "before [REDACTED-AWS_KEY] after"

    # ---- Clean content (no false positives) ----

    def test_clean_code_output(self):
        content = "def hello():\n    return 'world'\n"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False
        assert result.redacted_content == content
        assert result.findings == []

    def test_clean_test_output(self):
        content = "PASSED tests/test_main.py::test_hello - 3 passed in 0.5s"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    def test_clean_git_output(self):
        content = (
            "commit abc123\n"
            "Author: User <user@example.com>\n"
            "Date: Mon Jan 1\n"
            "\n"
            "    feat: add feature"
        )
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    def test_clean_url_without_password(self):
        content = "https://github.com/owner/repo/pull/42"
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False

    # ---- Edge cases ----

    def test_empty_string(self):
        result = scan_tool_output("")
        assert result.has_sensitive_content is False
        assert result.redacted_content == ""
        assert result.findings == []

    def test_none_input(self):
        result = scan_tool_output(None)
        assert result.has_sensitive_content is False
        assert result.redacted_content == ""

    def test_non_string_converted(self):
        # Caller is expected to convert, but scan_tool_output handles str only
        result = scan_tool_output(str({"key": "AKIAIOSFODNN7EXAMPLE"}))
        assert result.has_sensitive_content is True
        assert "AWS_KEY detected" in result.findings

    def test_large_output(self):
        # Should not hang or error on large output
        content = "a" * 1_000_000
        result = scan_tool_output(content)
        assert result.has_sensitive_content is False
        assert result.duration_ms >= 0

    def test_duration_is_recorded(self):
        content = "AKIAIOSFODNN7EXAMPLE"
        result = scan_tool_output(content)
        assert result.duration_ms >= 0
