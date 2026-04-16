"""Unit tests for pure functions in memory.py."""

import hashlib
from unittest.mock import MagicMock, patch

import pytest

from memory import (
    _SCHEMA_VERSION,
    MEMORY_SOURCE_TYPES,
    _validate_repo,
    write_repo_learnings,
    write_task_episode,
)
from sanitization import sanitize_external_content


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


class TestSchemaVersion:
    def test_schema_version_is_3(self):
        assert _SCHEMA_VERSION == "3"


class TestMemorySourceTypes:
    def test_contains_expected_values(self):
        assert {"agent_episode", "agent_learning", "orchestrator_fallback"} == MEMORY_SOURCE_TYPES

    def test_is_frozen(self):
        assert isinstance(MEMORY_SOURCE_TYPES, frozenset)


class TestWriteTaskEpisode:
    @patch("memory._get_client")
    def test_includes_source_type_in_metadata(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_task_episode("mem-1", "owner/repo", "task-1", "COMPLETED")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert metadata["source_type"] == {"stringValue": "agent_episode"}
        assert metadata["source_type"]["stringValue"] in MEMORY_SOURCE_TYPES
        assert metadata["schema_version"] == {"stringValue": "3"}

    @patch("memory._get_client")
    def test_content_sha256_matches_sanitized_content(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_task_episode("mem-1", "owner/repo", "task-1", "COMPLETED")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert "content_sha256" in metadata
        hash_value = metadata["content_sha256"]["stringValue"]
        assert len(hash_value) == 64

        # Verify hash matches the sanitized content that was actually stored
        content = call_kwargs["payload"][0]["conversational"]["content"]["text"]
        sanitized = sanitize_external_content(content)
        expected = hashlib.sha256(sanitized.encode("utf-8")).hexdigest()
        assert hash_value == expected


class TestWriteRepoLearnings:
    @patch("memory._get_client")
    def test_includes_source_type_in_metadata(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_repo_learnings("mem-1", "owner/repo", "task-1", "Use Jest for tests")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert metadata["source_type"] == {"stringValue": "agent_learning"}
        assert metadata["source_type"]["stringValue"] in MEMORY_SOURCE_TYPES
        assert metadata["schema_version"] == {"stringValue": "3"}

    @patch("memory._get_client")
    def test_content_sha256_matches_sanitized_content(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_repo_learnings("mem-1", "owner/repo", "task-1", "Use Jest for tests")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert "content_sha256" in metadata
        hash_value = metadata["content_sha256"]["stringValue"]
        assert len(hash_value) == 64

        content = call_kwargs["payload"][0]["conversational"]["content"]["text"]
        sanitized = sanitize_external_content(content)
        expected = hashlib.sha256(sanitized.encode("utf-8")).hexdigest()
        assert hash_value == expected
