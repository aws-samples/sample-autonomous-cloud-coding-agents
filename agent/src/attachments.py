"""Attachment download and integrity verification.

Downloads attachments from S3 using version-pinned reads and verifies
SHA-256 checksums against the orchestrator-provided values. Files are
placed in a workspace subdirectory for the agent to reference.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict

from shell import log

ATTACHMENTS_DIR = ".attachments"


class PreparedAttachment(BaseModel):
    """An attachment downloaded to the local filesystem and verified."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    attachment_id: str
    type: Literal["image", "file", "url"]
    content_type: str
    filename: str
    local_path: str
    size_bytes: int
    token_estimate: int | None = None


def download_attachments(
    attachments: list,
    workspace: str,
) -> list[PreparedAttachment]:
    """Download all attachments from S3 and verify integrity.

    Args:
        attachments: List of AttachmentConfig models from TaskConfig.
        workspace: The agent workspace root (e.g., /workspace).

    Returns:
        List of PreparedAttachment with local file paths.

    Raises:
        RuntimeError: If any attachment fails download or integrity check.
    """
    if not attachments:
        return []

    import boto3

    attachments_dir = Path(workspace) / ATTACHMENTS_DIR
    attachments_dir.mkdir(parents=True, exist_ok=True)

    s3_client = boto3.client("s3")
    prepared: list[PreparedAttachment] = []

    try:
        for att in attachments:
            local_path = _download_single(att, attachments_dir, s3_client)
            prepared.append(
                PreparedAttachment(
                    attachment_id=att.attachment_id,
                    type=att.type,
                    content_type=att.content_type,
                    filename=att.filename,
                    local_path=str(local_path),
                    size_bytes=att.size_bytes,
                    token_estimate=att.token_estimate,
                )
            )
    except Exception:
        import shutil

        shutil.rmtree(attachments_dir, ignore_errors=True)
        raise

    log("TASK", f"Downloaded {len(prepared)} attachment(s) to {attachments_dir}")
    return prepared


def _download_single(att, attachments_dir: Path, s3_client) -> Path:
    """Download a single attachment and verify its SHA-256 checksum."""
    # Parse s3_uri (s3://bucket/key)
    parsed = urlparse(att.s3_uri)
    bucket = parsed.netloc
    key = parsed.path.lstrip("/")

    # Unique subdirectory per attachment to avoid filename collisions
    dest_dir = attachments_dir / att.attachment_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    local_path = dest_dir / att.filename

    log(
        "TASK",
        f"Downloading attachment '{att.filename}' "
        f"(s3://{bucket}/{key}, version={att.s3_version_id})",
    )

    # Download with pinned VersionId to prevent TOCTOU
    response = s3_client.get_object(
        Bucket=bucket,
        Key=key,
        VersionId=att.s3_version_id,
    )
    content = response["Body"].read()

    # Verify SHA-256 integrity
    actual_checksum = hashlib.sha256(content).hexdigest()
    if actual_checksum != att.checksum_sha256:
        raise RuntimeError(
            f"Attachment '{att.filename}' integrity check failed: "
            f"expected SHA-256 {att.checksum_sha256}, got {actual_checksum}. "
            f"The file may have been tampered with."
        )

    # Verify size matches
    if len(content) != att.size_bytes:
        raise RuntimeError(
            f"Attachment '{att.filename}' size mismatch: "
            f"expected {att.size_bytes} bytes, got {len(content)} bytes."
        )

    # Write to local filesystem
    local_path.write_bytes(content)
    os.chmod(str(local_path), 0o444)  # Read-only

    log("TASK", f"  Verified: {att.filename} ({len(content)} bytes, SHA-256 OK)")
    return local_path
