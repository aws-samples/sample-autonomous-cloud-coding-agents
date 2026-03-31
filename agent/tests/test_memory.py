"""Unit tests for pure functions in memory.py."""

import pytest

from memory import _validate_repo


class TestValidateRepo:
    def test_valid_simple(self):
        _validate_repo("owner/repo")  # should not raise

    def test_valid_with_dots_and_dashes(self):
        _validate_repo("my-org/my.repo-name")

    def test_valid_with_underscores(self):
        _validate_repo("org_name/repo_name")

    def test_invalid_full_url(self):
        with pytest.raises(ValueError, match="does not match"):
            _validate_repo("https://github.com/owner/repo")

    def test_invalid_no_slash(self):
        with pytest.raises(ValueError, match="does not match"):
            _validate_repo("justrepo")

    def test_invalid_extra_slash(self):
        with pytest.raises(ValueError, match="does not match"):
            _validate_repo("owner/repo/extra")

    def test_invalid_spaces(self):
        with pytest.raises(ValueError, match="does not match"):
            _validate_repo("owner/ repo")

    def test_invalid_empty(self):
        with pytest.raises(ValueError, match="does not match"):
            _validate_repo("")
