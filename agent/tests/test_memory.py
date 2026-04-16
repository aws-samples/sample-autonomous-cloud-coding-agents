"""Unit tests for pure functions in memory.py."""

from unittest.mock import MagicMock, patch

import pytest

from memory import _SCHEMA_VERSION, _validate_repo, write_repo_learnings, write_task_episode


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


class TestWriteTaskEpisode:
    @patch("memory._get_client")
    def test_includes_source_type_in_metadata(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_task_episode("mem-1", "owner/repo", "task-1", "COMPLETED")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert metadata["source_type"] == {"stringValue": "agent_episode"}
        assert metadata["schema_version"] == {"stringValue": "3"}

    @patch("memory._get_client")
    def test_includes_content_sha256_in_metadata(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_task_episode("mem-1", "owner/repo", "task-1", "COMPLETED")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert "content_sha256" in metadata
        # SHA-256 hex is 64 chars
        assert len(metadata["content_sha256"]["stringValue"]) == 64


class TestWriteRepoLearnings:
    @patch("memory._get_client")
    def test_includes_source_type_in_metadata(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_repo_learnings("mem-1", "owner/repo", "task-1", "Use Jest for tests")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert metadata["source_type"] == {"stringValue": "agent_learning"}
        assert metadata["schema_version"] == {"stringValue": "3"}

    @patch("memory._get_client")
    def test_includes_content_sha256_in_metadata(self, mock_get_client):
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        write_repo_learnings("mem-1", "owner/repo", "task-1", "Use Jest for tests")

        call_kwargs = mock_client.create_event.call_args[1]
        metadata = call_kwargs["metadata"]
        assert "content_sha256" in metadata
        assert len(metadata["content_sha256"]["stringValue"]) == 64
