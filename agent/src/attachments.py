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
        workspace: The task's own directory (e.g., /workspace/<task_id>): the
            repository clone, or a directory of that name for a task without a
            repository. Never one that tasks share: a failed download removes
            its whole ``.attachments`` directory.

    Returns:
        List of PreparedAttachment with local file paths.

    Raises:
        RuntimeError: If any attachment fails download or integrity check.
    """
    if not attachments:
        return []

    from aws_session import tenant_client

    attachments_dir = Path(workspace) / ATTACHMENTS_DIR
    attachments_dir.mkdir(parents=True, exist_ok=True)
    git_info = Path(workspace) / ".git" / "info"
    if git_info.is_dir():
        with (git_info / "exclude").open("a") as exclude:
            exclude.write(f"\n/{ATTACHMENTS_DIR}/\n")

    s3_client = tenant_client("s3")
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
    parsed = urlparse(att.s3_uri)
    bucket = parsed.netloc
    key = parsed.path.lstrip("/")

    dest_dir = attachments_dir / att.attachment_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    local_path = dest_dir / att.filename

    log(
        "TASK",
        f"Downloading attachment '{att.filename}' "
        f"(s3://{bucket}/{key}, version={att.s3_version_id})",
    )

    response = s3_client.get_object(
        Bucket=bucket,
        Key=key,
        VersionId=att.s3_version_id,
    )
    content = response["Body"].read()

    actual_checksum = hashlib.sha256(content).hexdigest()
    if actual_checksum != att.checksum_sha256:
        raise RuntimeError(
            f"Attachment '{att.filename}' integrity check failed: "
            f"expected SHA-256 {att.checksum_sha256}, got {actual_checksum}. "
            f"The file may have been tampered with."
        )

    if len(content) != att.size_bytes:
        raise RuntimeError(
            f"Attachment '{att.filename}' size mismatch: "
            f"expected {att.size_bytes} bytes, got {len(content)} bytes."
        )

    local_path.write_bytes(content)
    os.chmod(str(local_path), 0o444)

    log("TASK", f"  Verified: {att.filename} ({len(content)} bytes, SHA-256 OK)")
    return local_path
