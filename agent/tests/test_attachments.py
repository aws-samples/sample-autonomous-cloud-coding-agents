"""Unit tests for attachments.py — download and integrity verification."""

import hashlib
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from attachments import ATTACHMENTS_DIR, PreparedAttachment, download_attachments
from models import AttachmentConfig


def _make_config(
    content: bytes = b"hello world",
    filename: str = "test.txt",
    attachment_id: str = "ATT001",
) -> tuple[AttachmentConfig, bytes]:
    """Create an AttachmentConfig with matching checksum."""
    checksum = hashlib.sha256(content).hexdigest()
    config = AttachmentConfig(
        attachment_id=attachment_id,
        type="file",
        content_type="text/plain",
        filename=filename,
        s3_uri="s3://test-bucket/attachments/user-1/task-1/ATT001/test.txt",
        s3_version_id="v1",
        size_bytes=len(content),
        checksum_sha256=checksum,
    )
    return config, content


class TestPreparedAttachment:
    def test_frozen_model(self):
        att = PreparedAttachment(
            attachment_id="ATT001",
            type="file",
            content_type="text/plain",
            filename="test.txt",
            local_path="/tmp/test.txt",
            size_bytes=100,
        )
        with pytest.raises(ValidationError):
            att.filename = "other.txt"

    def test_rejects_extra_fields(self):
        with pytest.raises(ValidationError):
            PreparedAttachment(
                attachment_id="ATT001",
                type="file",
                content_type="text/plain",
                filename="test.txt",
                local_path="/tmp/test.txt",
                size_bytes=100,
                extra_field="bad",  # ty: ignore[unknown-argument]
            )


class TestDownloadAttachments:
    def test_empty_list_returns_empty(self, tmp_path):
        result = download_attachments([], str(tmp_path))
        assert result == []

    @patch("boto3.client")
    def test_successful_download_and_verify(self, mock_client, tmp_path):
        config, content = _make_config()

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: content)}

        result = download_attachments([config], str(tmp_path))

        assert len(result) == 1
        assert result[0].filename == "test.txt"
        assert result[0].size_bytes == len(content)
        assert Path(result[0].local_path).exists()
        assert Path(result[0].local_path).read_bytes() == content

    @patch("boto3.client")
    def test_passes_version_id_to_s3(self, mock_client, tmp_path):
        config, content = _make_config()

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: content)}

        download_attachments([config], str(tmp_path))

        mock_s3.get_object.assert_called_once_with(
            Bucket="test-bucket",
            Key="attachments/user-1/task-1/ATT001/test.txt",
            VersionId="v1",
        )

    @patch("boto3.client")
    def test_checksum_mismatch_raises(self, mock_client, tmp_path):
        config, _ = _make_config()
        tampered_content = b"tampered content"

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: tampered_content)}

        with pytest.raises(RuntimeError, match="integrity check failed"):
            download_attachments([config], str(tmp_path))

    @patch("boto3.client")
    def test_size_mismatch_raises(self, mock_client, tmp_path):
        content = b"hello world"
        checksum = hashlib.sha256(content).hexdigest()

        # Config says size is 5, but content is 11 bytes
        config = AttachmentConfig(
            attachment_id="ATT001",
            type="file",
            content_type="text/plain",
            filename="test.txt",
            s3_uri="s3://test-bucket/attachments/user-1/task-1/ATT001/test.txt",
            s3_version_id="v1",
            size_bytes=5,
            checksum_sha256=checksum,
        )

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: content)}

        with pytest.raises(RuntimeError, match="size mismatch"):
            download_attachments([config], str(tmp_path))

    @patch("boto3.client")
    def test_file_written_read_only(self, mock_client, tmp_path):
        config, content = _make_config()

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: content)}

        result = download_attachments([config], str(tmp_path))

        local_path = Path(result[0].local_path)
        mode = os.stat(str(local_path)).st_mode & 0o777
        assert mode == 0o444

    @patch("boto3.client")
    def test_creates_per_attachment_subdirectory(self, mock_client, tmp_path):
        config, content = _make_config()

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: content)}

        result = download_attachments([config], str(tmp_path))

        # File should be under .attachments/<attachment_id>/<filename>
        local_path = Path(result[0].local_path)
        assert local_path.parent.name == config.attachment_id
        assert local_path.parent.parent.name == ATTACHMENTS_DIR

    @patch("boto3.client")
    def test_multiple_attachments_all_verified(self, mock_client, tmp_path):
        configs_and_contents = [
            _make_config(b"content 1", "file1.txt", "ATT001"),
            _make_config(b"content 2", "file2.txt", "ATT002"),
        ]

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        # Return different content for each call
        mock_s3.get_object.side_effect = [
            {"Body": MagicMock(read=lambda: configs_and_contents[0][1])},
            {"Body": MagicMock(read=lambda: configs_and_contents[1][1])},
        ]

        result = download_attachments([c[0] for c in configs_and_contents], str(tmp_path))
        assert len(result) == 2
        assert result[0].filename == "file1.txt"
        assert result[1].filename == "file2.txt"

    @patch("boto3.client")
    def test_partial_failure_cleans_up_attachments_dir(self, mock_client, tmp_path):
        """When download fails mid-loop, already-downloaded files are removed."""
        config_ok, content_ok = _make_config(b"good content", "good.txt", "ATT001")
        config_bad, _ = _make_config(b"bad content", "bad.txt", "ATT002")

        mock_s3 = MagicMock()
        mock_client.return_value = mock_s3
        # First attachment succeeds, second returns tampered content (checksum mismatch)
        mock_s3.get_object.side_effect = [
            {"Body": MagicMock(read=lambda: content_ok)},
            {"Body": MagicMock(read=lambda: b"tampered")},
        ]

        attachments_dir = tmp_path / ATTACHMENTS_DIR

        with pytest.raises(RuntimeError, match="integrity check failed"):
            download_attachments([config_ok, config_bad], str(tmp_path))

        # The entire .attachments directory should be cleaned up
        assert not attachments_dir.exists()
