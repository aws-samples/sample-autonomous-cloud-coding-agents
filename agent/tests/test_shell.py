"""Unit tests for shell.py — slugify, redact_secrets, truncate."""

from shell import redact_secrets, slugify, truncate


class TestSlugify:
    def test_basic(self):
        assert slugify("Fix the login bug") == "fix-the-login-bug"

    def test_special_chars(self):
        assert slugify("Add feature: OAuth2.0!") == "add-feature-oauth20"

    def test_max_len(self):
        result = slugify("a very long task description indeed", max_len=10)
        assert len(result) <= 10
        assert not result.endswith("-")

    def test_empty(self):
        assert slugify("") == "task"

    def test_only_special_chars(self):
        assert slugify("!!!") == "task"


class TestRedactSecrets:
    def test_ghp_token(self):
        assert "***" in redact_secrets("ghp_abc123XYZ")
        assert "abc123XYZ" not in redact_secrets("ghp_abc123XYZ")

    def test_github_pat_token(self):
        result = redact_secrets("github_pat_abcDEF123")
        assert "abcDEF123" not in result

    def test_x_access_token(self):
        result = redact_secrets("https://x-access-token:mysecret@github.com/foo/bar")
        assert "mysecret" not in result

    def test_no_secrets(self):
        text = "nothing secret here"
        assert redact_secrets(text) == text


class TestTruncate:
    def test_short_text(self):
        assert truncate("hello") == "hello"

    def test_long_text(self):
        long = "a" * 300
        result = truncate(long, max_len=100)
        assert len(result) == 103  # 100 + "..."
        assert result.endswith("...")

    def test_empty(self):
        assert truncate("") == ""

    def test_newlines_replaced(self):
        assert truncate("line1\nline2") == "line1 line2"
