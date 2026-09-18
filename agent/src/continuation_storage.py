# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Bounded, version-pinned storage for complete continuation checkpoints.

The small manifest is the commit record: it is written only after the workspace
and SDK conversation have both been read back successfully. Publishing that
manifest to the task's conditional state record is a separate operation. An S3
upload alone never grants permission to stop a worker.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import time
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, BinaryIO

from continuation_session import (
    CheckpointIdentity,
    CheckpointReceipt,
    ContinuationCheckpointError,
    S3ContinuationCheckpoints,
)
from models import RepoSetup
from shared_constants import SHARED_CONSTANTS

_CHUNK = 1024 * 1024
_MAX_MANIFEST_BYTES = SHARED_CONSTANTS["microvm_continuation"]["max_manifest_bytes"]
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_KINDS = {"workspace": "tar", "manifest": "json"}
_VERSION = SHARED_CONSTANTS["microvm_continuation"]["version"]
_MAX_VERSION_ID_LENGTH = 1024


class ContinuationStorageError(ContinuationCheckpointError):
    """Content-free failure classification for lifecycle diagnostics."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class StorageLimits:
    max_workspace_bytes: int = SHARED_CONSTANTS["microvm_continuation"]["max_workspace_bytes"]
    disk_reserve_bytes: int = 128 * _CHUNK
    transfer_timeout_s: int = 300

    def __post_init__(self) -> None:
        if any(
            type(value) is not int or value <= 0
            for value in (
                self.max_workspace_bytes,
                self.disk_reserve_bytes,
                self.transfer_timeout_s,
            )
        ):
            raise ValueError("Continuation storage limits must be positive integers")


_DEFAULT_LIMITS = StorageLimits()


@dataclass(frozen=True)
class FileReceipt:
    kind: str
    key: str
    version_id: str
    sha256: str
    size_bytes: int

    @classmethod
    def from_record(
        cls, value: Any, identity: CheckpointIdentity, limits: StorageLimits = _DEFAULT_LIMITS
    ) -> FileReceipt:
        """Accept DynamoDB's integral Decimal without coercing strings/floats/bools."""
        if not isinstance(value, dict) or set(value) != {
            "kind",
            "key",
            "version_id",
            "sha256",
            "size_bytes",
        }:
            raise ContinuationStorageError(
                "invalid_receipt", "Continuation file receipt is invalid"
            )
        data = dict(value)
        size = data["size_bytes"]
        if isinstance(size, Decimal) and size.is_finite() and size == size.to_integral_value():
            data["size_bytes"] = int(size)
        receipt = cls(**data)
        receipt.validate(identity, limits)
        return receipt

    def validate(self, identity: CheckpointIdentity, limits: StorageLimits) -> None:
        suffix = _KINDS.get(self.kind)
        bound = limits.max_workspace_bytes if self.kind == "workspace" else _MAX_MANIFEST_BYTES
        if (
            suffix is None
            or not isinstance(self.sha256, str)
            or not _SHA256.fullmatch(self.sha256)
            or self.key != f"{identity.prefix}{self.kind}/{self.sha256}.{suffix}"
            or not isinstance(self.version_id, str)
            or not self.version_id
            or self.version_id == "null"
            or len(self.version_id) > _MAX_VERSION_ID_LENGTH
            or type(self.size_bytes) is not int
            or not 0 < self.size_bytes <= bound
        ):
            raise ContinuationStorageError(
                "invalid_receipt", "Continuation file receipt is invalid"
            )


@dataclass(frozen=True)
class ContinuationContext:
    """Workflow products needed after recovery; never serialize TaskConfig secrets."""

    setup: RepoSetup
    user_prompt: str
    system_prompt: str
    workflow_id: str
    workflow_version: str
    approval_scopes: tuple[str, ...] = ()
    approval_gate_count: int = 0
    turns_used: int = 0
    cost_usd: float = 0.0
    token_usage: dict[str, int] = field(default_factory=dict)
    started_reaction_id: str | None = None

    def to_dict(self) -> dict:
        value = asdict(self)
        value["setup"] = self.setup.model_dump(mode="json")
        value["approval_scopes"] = list(self.approval_scopes)
        return value

    @classmethod
    def from_dict(cls, value: Any) -> ContinuationContext:
        from continuation_usage import valid_cost, valid_tokens

        text_fields = {"user_prompt", "system_prompt", "workflow_id", "workflow_version"}
        fields = text_fields | {
            "setup",
            "approval_scopes",
            "approval_gate_count",
            "turns_used",
            "cost_usd",
            "token_usage",
            "started_reaction_id",
        }
        if (
            not isinstance(value, dict)
            or set(value) != fields
            or any(not isinstance(value[name], str) for name in text_fields)
            or not value["workflow_id"]
            or not value["workflow_version"]
            or not isinstance(value["setup"], dict)
            or set(value["setup"]) != set(RepoSetup.model_fields)
            or not isinstance(value["approval_scopes"], list)
            or any(not isinstance(scope, str) for scope in value["approval_scopes"])
            or any(
                type(value[name]) is not int or value[name] < 0
                for name in ("approval_gate_count", "turns_used")
            )
            or not valid_cost(value["cost_usd"])
            or not valid_tokens(value["token_usage"])
            or (
                value["started_reaction_id"] is not None
                and not isinstance(value["started_reaction_id"], str)
            )
        ):
            raise ContinuationStorageError(
                "invalid_context", "Continuation workflow context is invalid"
            )
        try:
            setup = RepoSetup.model_validate(value["setup"], strict=True)
        except ValueError as exc:
            raise ContinuationStorageError(
                "invalid_context", "Continuation repository context is invalid"
            ) from exc
        if not Path(setup.repo_dir).is_absolute():
            raise ContinuationStorageError(
                "invalid_context", "Continuation workspace must be absolute"
            )
        return cls(
            setup,
            value["user_prompt"],
            value["system_prompt"],
            value["workflow_id"],
            value["workflow_version"],
            tuple(value["approval_scopes"]),
            value["approval_gate_count"],
            value["turns_used"],
            float(value["cost_usd"]),
            value["token_usage"],
            value["started_reaction_id"],
        )


@dataclass(frozen=True)
class ContinuationManifest:
    identity: CheckpointIdentity
    conversation: CheckpointReceipt
    workspace: FileReceipt
    context: ContinuationContext

    def encode(self, limits: StorageLimits) -> bytes:
        self.conversation.validate(self.identity)
        self.workspace.validate(self.identity, limits)
        if self.workspace.kind != "workspace":
            raise ContinuationStorageError("invalid_manifest", "Manifest workspace kind is invalid")
        context = self.context.to_dict()
        ContinuationContext.from_dict(context)
        try:
            body = json.dumps(
                {
                    "version": _VERSION,
                    "identity": asdict(self.identity),
                    "conversation": asdict(self.conversation),
                    "workspace": asdict(self.workspace),
                    "context": context,
                },
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        except (TypeError, ValueError, RecursionError) as exc:
            raise ContinuationStorageError("invalid_manifest", "Manifest data is invalid") from exc
        if len(body) > _MAX_MANIFEST_BYTES:
            raise ContinuationStorageError(
                "size_limit", "Continuation manifest exceeds its byte limit"
            )
        return body

    @classmethod
    def decode(
        cls, body: bytes, identity: CheckpointIdentity, limits: StorageLimits
    ) -> ContinuationManifest:
        if not body or len(body) > _MAX_MANIFEST_BYTES:
            raise ContinuationStorageError(
                "size_limit", "Continuation manifest exceeds its byte limit"
            )
        try:
            value = json.loads(body)
            if (
                not isinstance(value, dict)
                or set(value) != {"version", "identity", "conversation", "workspace", "context"}
                or type(value["version"]) is not int
                or value["version"] != _VERSION
                or value["identity"] != asdict(identity)
            ):
                raise ValueError("Invalid envelope")
            result = cls(
                identity,
                CheckpointReceipt(**value["conversation"]),
                FileReceipt(**value["workspace"]),
                ContinuationContext.from_dict(value["context"]),
            )
            result.encode(limits)
            return result
        except (TypeError, ValueError, KeyError, RecursionError) as exc:
            raise ContinuationStorageError(
                "invalid_manifest", "Continuation manifest is invalid"
            ) from exc


def _stamp(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _time_left(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise ContinuationStorageError(
            "transfer_timeout", "Continuation transfer exceeded its deadline"
        )


def _space(path: Path, required: int, limits: StorageLimits) -> None:
    if shutil.disk_usage(path).free < required + limits.disk_reserve_bytes:
        raise ContinuationStorageError(
            "disk_pressure", "Continuation transfer has insufficient disk space"
        )


class S3ContinuationStorage:
    def __init__(
        self, bucket: str, *, client: Any = None, limits: StorageLimits = _DEFAULT_LIMITS
    ) -> None:
        # Reuse the mandatory task-scoped credential check and conservative SDK
        # timeouts. An explicitly injected client is only for tests/operators.
        self.conversations = S3ContinuationCheckpoints(bucket, client=client)
        self.bucket = self.conversations.bucket
        self.client = self.conversations.client
        self.limits = limits

    def _read(
        self,
        receipt: FileReceipt,
        identity: CheckpointIdentity,
        destination: BinaryIO | None,
        *,
        deadline: float,
        current: bool = False,
        disk_path: Path | None = None,
    ) -> FileReceipt:
        receipt.validate(identity, self.limits)
        _time_left(deadline)
        response = self.client.get_object(
            Bucket=self.bucket,
            Key=receipt.key,
            ChecksumMode="ENABLED",
            **({} if current else {"VersionId": receipt.version_id}),
        )
        stream = response["Body"]
        try:
            version = response.get("VersionId")
            if (
                not isinstance(version, str)
                or not version
                or version == "null"
                or (not current and version != receipt.version_id)
                or type(response.get("ContentLength")) is not int
                or response["ContentLength"] != receipt.size_bytes
                or response.get("ChecksumSHA256")
                != base64.b64encode(bytes.fromhex(receipt.sha256)).decode()
            ):
                raise ContinuationStorageError(
                    "integrity_failed", "Stored continuation metadata differs"
                )
            digest = hashlib.sha256()
            count = 0
            while True:
                _time_left(deadline)
                chunk = stream.read(min(_CHUNK, receipt.size_bytes - count + 1))
                if not chunk:
                    break
                count += len(chunk)
                if count > receipt.size_bytes:
                    raise ContinuationStorageError(
                        "size_limit", "Stored continuation exceeds its receipt"
                    )
                digest.update(chunk)
                if destination is not None:
                    if disk_path is not None:
                        _space(disk_path, len(chunk), self.limits)
                    destination.write(chunk)
            if count != receipt.size_bytes or digest.hexdigest() != receipt.sha256:
                raise ContinuationStorageError(
                    "integrity_failed", "Stored continuation content differs"
                )
            verified = FileReceipt(receipt.kind, receipt.key, version, receipt.sha256, count)
            verified.validate(identity, self.limits)
            return verified
        finally:
            stream.close()

    def _save(
        self, source: BinaryIO, identity: CheckpointIdentity, kind: str, size: int
    ) -> FileReceipt:
        deadline = time.monotonic() + self.limits.transfer_timeout_s
        digest = hashlib.sha256()
        count = 0
        while chunk := source.read(_CHUNK):
            _time_left(deadline)
            count += len(chunk)
            if count > size:
                raise ContinuationStorageError(
                    "source_changed", "Prepared continuation changed size"
                )
            digest.update(chunk)
        if count != size:
            raise ContinuationStorageError("source_changed", "Prepared continuation is incomplete")
        sha256 = digest.hexdigest()
        key = f"{identity.prefix}{kind}/{sha256}.{_KINDS[kind]}"
        # The provisional version is never returned: _read must supply and
        # validate a real S3 version, including after a lost PutObject reply.
        provisional = FileReceipt(kind, key, "unverified", sha256, size)
        provisional.validate(identity, self.limits)
        source.seek(0)
        write_error = None
        try:
            _time_left(deadline)
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=source,
                ContentLength=size,
                ContentType="application/x-tar" if kind == "workspace" else "application/json",
                ServerSideEncryption="AES256",
                ChecksumSHA256=base64.b64encode(digest.digest()).decode(),
                IfNoneMatch="*",
            )
        except Exception as exc:
            write_error = exc
        try:
            return self._read(provisional, identity, None, deadline=deadline, current=True)
        except Exception as exc:
            raise ContinuationStorageError(
                "unverified_upload", "Continuation upload could not be verified; retain the worker"
            ) from (write_error if write_error is not None else exc)

    def save_workspace(self, archive: Path, identity: CheckpointIdentity) -> FileReceipt:
        with os.fdopen(
            os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
        ) as source:
            before = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or not 0 < before.st_size <= self.limits.max_workspace_bytes
            ):
                raise ContinuationStorageError(
                    "invalid_source", "Prepared workspace archive is invalid"
                )
            receipt = self._save(source, identity, "workspace", before.st_size)
            if _stamp(os.fstat(source.fileno())) != _stamp(before):
                raise ContinuationStorageError(
                    "source_changed", "Workspace archive changed during upload"
                )
            return receipt

    def save_manifest(self, manifest: ContinuationManifest) -> FileReceipt:
        import io

        body = manifest.encode(self.limits)
        return self._save(io.BytesIO(body), manifest.identity, "manifest", len(body))

    def load_manifest(
        self, receipt: FileReceipt, identity: CheckpointIdentity
    ) -> ContinuationManifest:
        import io

        if receipt.kind != "manifest":
            raise ContinuationStorageError("invalid_receipt", "Expected a continuation manifest")
        target = io.BytesIO()
        self._read(
            receipt,
            identity,
            target,
            deadline=time.monotonic() + self.limits.transfer_timeout_s,
        )
        return ContinuationManifest.decode(target.getvalue(), identity, self.limits)

    def download_workspace(
        self, receipt: FileReceipt, identity: CheckpointIdentity, destination: Path
    ) -> None:
        if receipt.kind != "workspace":
            raise ContinuationStorageError("invalid_receipt", "Expected a workspace archive")
        receipt.validate(identity, self.limits)
        _space(destination.parent, receipt.size_bytes, self.limits)
        # The caller supplies a private staging directory. Never truncate an
        # existing destination; publish the verified file with a no-replace link.
        fd, name = tempfile.mkstemp(prefix=".continuation-", dir=destination.parent)
        try:
            with os.fdopen(fd, "wb") as target:
                self._read(
                    receipt,
                    identity,
                    target,
                    deadline=time.monotonic() + self.limits.transfer_timeout_s,
                    disk_path=destination.parent,
                )
                target.flush()
                os.fsync(target.fileno())
            os.link(name, destination)
        finally:
            os.unlink(name)
