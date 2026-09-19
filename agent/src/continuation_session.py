# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Acknowledged SDK conversation checkpoints for worker continuation.

This module does not release workers or change approval deadlines. A caller must
hold the lifecycle barrier, checkpoint the workspace, and conditionally publish
the returned receipt for the same task/attempt/request before releasing compute.
Only SDK transcript entries are captured; CLI authentication files and process
environment are never read. Transcript/action contents remain private task data.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from claude_agent_sdk import SessionStore

from shared_constants import SHARED_CONSTANTS

if TYPE_CHECKING:
    from claude_agent_sdk import SessionKey, SessionStoreEntry

CHECKPOINT_VERSION = 1
MAX_CHECKPOINT_BYTES = SHARED_CONSTANTS["microvm_continuation"]["max_conversation_bytes"]
MAX_CHECKPOINT_ENTRIES = 50_000
MAX_ID_LENGTH = 128
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")


class ContinuationCheckpointError(RuntimeError):
    """A checkpoint cannot be acknowledged or safely restored."""


def _encode(value: Any) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContinuationCheckpointError("Checkpoint contains invalid JSON data") from exc


def _copy(value: Any) -> Any:
    return json.loads(_encode(value))


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _session_id(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def _action_hash(tool_input: dict) -> str:
    # Match the approval row / RecentDecisionCache encoding, including spaces
    # and ASCII escaping. Invalid input is rejected rather than stringified.
    _encode(tool_input)
    return hashlib.sha256(json.dumps(tool_input, sort_keys=True).encode()).hexdigest()


@dataclass(frozen=True)
class CheckpointIdentity:
    task_id: str
    attempt_id: str
    request_id: str
    user_id: str
    repo: str

    def __post_init__(self) -> None:
        if (
            not all(
                _identifier(value) for value in (self.task_id, self.attempt_id, self.request_id)
            )
            or not isinstance(self.user_id, str)
            or not self.user_id
            or len(self.user_id) > MAX_ID_LENGTH
            or not isinstance(self.repo, str)
        ):
            raise ContinuationCheckpointError("Checkpoint identity is invalid")

    @property
    def prefix(self) -> str:
        prefix = SHARED_CONSTANTS["microvm_continuation"]["object_key_prefix"]
        return f"{prefix}{self.task_id}/{self.attempt_id}/{self.request_id}/"


@dataclass(frozen=True)
class CheckpointReceipt:
    """Pin a verified object version, never an overwriteable current key."""

    key: str
    version_id: str
    sha256: str
    size_bytes: int

    def validate(self, identity: CheckpointIdentity) -> None:
        if (
            not isinstance(self.sha256, str)
            or not _HASH.fullmatch(self.sha256)
            or self.key != identity.prefix + self.sha256 + ".json"
            or not isinstance(self.version_id, str)
            or not self.version_id
            or self.version_id == "null"
            or type(self.size_bytes) is not int
            or not 0 < self.size_bytes <= MAX_CHECKPOINT_BYTES
        ):
            raise ContinuationCheckpointError("Checkpoint receipt is invalid or outside this task")


def _validate_entries(entries: Any) -> list[dict]:
    if not isinstance(entries, list) or len(entries) > MAX_CHECKPOINT_ENTRIES:
        raise ContinuationCheckpointError("Checkpoint transcript entry limit exceeded")
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("type"), str):
            raise ContinuationCheckpointError("Checkpoint transcript entry is invalid")
        if "uuid" in entry and (not isinstance(entry["uuid"], str) or not entry["uuid"]):
            raise ContinuationCheckpointError("Checkpoint transcript entry UUID is invalid")
    return entries


def _pending_action_present(entries: list[dict], action: dict) -> bool:
    found = False
    for entry in entries:
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if (
                block.get("type") == "tool_result"
                and block.get("tool_use_id") == action["tool_use_id"]
            ):
                raise ContinuationCheckpointError("Pending action already has a tool result")
            if block.get("type") == "tool_use" and block.get("id") == action["tool_use_id"]:
                if found:
                    raise ContinuationCheckpointError("Pending action has duplicate transcript IDs")
                if (
                    entry.get("type") != "assistant"
                    or block.get("name") != action["tool_name"]
                    or _encode(block.get("input")) != _encode(action["tool_input"])
                ):
                    raise ContinuationCheckpointError(
                        "Pending action disagrees with the transcript"
                    )
                found = True
    return found


def decode_checkpoint(body: bytes, identity: CheckpointIdentity) -> dict:
    """Validate the complete private envelope before using any restored data."""
    if not body or len(body) > MAX_CHECKPOINT_BYTES:
        raise ContinuationCheckpointError("Checkpoint byte limit exceeded")
    try:
        envelope = json.loads(body)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ContinuationCheckpointError("Checkpoint is not valid JSON") from exc
    if (
        not isinstance(envelope, dict)
        or set(envelope)
        != {"version", "identity", "project_key", "session_id", "action", "entries"}
        or type(envelope.get("version")) is not int
        or envelope["version"] != CHECKPOINT_VERSION
        or envelope.get("identity") != asdict(identity)
        or not _session_id(envelope.get("session_id"))
        or not isinstance(envelope.get("project_key"), str)
        or not envelope["project_key"]
        or not isinstance(envelope.get("action"), dict)
    ):
        raise ContinuationCheckpointError("Checkpoint envelope or identity is invalid")
    action = envelope["action"]
    if (
        set(action) != {"tool_use_id", "tool_name", "tool_input", "tool_input_sha256"}
        or not _identifier(action.get("tool_use_id"))
        or not _identifier(action.get("tool_name"))
        or not isinstance(action.get("tool_input"), dict)
        or action.get("tool_input_sha256") != _action_hash(action["tool_input"])
    ):
        raise ContinuationCheckpointError("Checkpoint pending action is invalid")
    entries = _validate_entries(envelope.get("entries"))
    if any(
        "sessionId" in entry and entry["sessionId"] != envelope["session_id"] for entry in entries
    ):
        raise ContinuationCheckpointError("Transcript contains another SDK session")
    if not _pending_action_present(entries, action):
        raise ContinuationCheckpointError("Pending action is missing from the transcript")
    # Reject non-finite numbers even though Python's JSON decoder accepts them.
    _encode(envelope)
    return envelope


class CheckpointSessionStore(SessionStore):
    """Single SDK session buffer implementing its public append/load protocol.

    Eager mirroring is still asynchronous. ``checkpoint_pending`` waits for the
    exact assistant action to reach this buffer; enabling mirroring alone is not
    an acknowledgement. Buffers belong to the SDK runner's event loop.
    """

    def __init__(self, project_key: str) -> None:
        if not isinstance(project_key, str) or not project_key:
            raise ContinuationCheckpointError("SDK project key is unavailable")
        self.project_key = project_key
        self._session: str | None = None
        self._entries: list[dict] = []
        self._changed = asyncio.Condition()
        self._failure: str | None = None

    def _check_key(self, key: SessionKey) -> str:
        if (
            not isinstance(key, dict)
            or key.get("project_key") != self.project_key
            or not _session_id(key.get("session_id"))
            or "subpath" in key
            or (self._session is not None and key["session_id"] != self._session)
        ):
            raise ContinuationCheckpointError("Unexpected SDK session or subagent transcript")
        return key["session_id"]

    async def append(self, key: SessionKey, entries: list[SessionStoreEntry]) -> None:
        async with self._changed:
            try:
                session = self._check_key(key)
                incoming = _validate_entries(_copy(entries))
                if any(
                    "sessionId" in entry and entry["sessionId"] != session for entry in incoming
                ):
                    raise ContinuationCheckpointError("Transcript contains another SDK session")
                updated = _copy(self._entries)
                positions = {entry["uuid"]: i for i, entry in enumerate(updated) if "uuid" in entry}
                for entry in incoming:
                    entry_id = entry.get("uuid")
                    if entry_id in positions:
                        updated[positions[entry_id]] = entry
                    else:
                        if entry_id is not None:
                            positions[entry_id] = len(updated)
                        updated.append(entry)
                if (
                    len(updated) > MAX_CHECKPOINT_ENTRIES
                    or len(_encode(updated)) > MAX_CHECKPOINT_BYTES
                ):
                    raise ContinuationCheckpointError("SDK transcript exceeds checkpoint limits")
                self._session, self._entries = session, updated
            except ContinuationCheckpointError as exc:
                # The SDK can continue after a dropped mirror batch. Once a gap
                # is possible, no later matching action may certify completeness.
                self._failure = str(exc)
                raise
            finally:
                self._changed.notify_all()

    async def load(self, key: SessionKey) -> list[SessionStoreEntry] | None:
        async with self._changed:
            self._check_key(key)
            if self._failure:
                raise ContinuationCheckpointError(self._failure)
            return _copy(self._entries) if self._session else None

    async def checkpoint_pending(
        self,
        identity: CheckpointIdentity,
        *,
        session_id: str,
        tool_use_id: str,
        tool_name: str,
        tool_input: dict,
        timeout_s: float = 5,
    ) -> bytes:
        """Require mirrored action coverage; workspace/barrier checks are separate."""
        if (
            not _session_id(session_id)
            or not _identifier(tool_use_id)
            or not _identifier(tool_name)
            or not isinstance(tool_input, dict)
            or isinstance(timeout_s, bool)
            or not isinstance(timeout_s, (float, int))
            or not math.isfinite(timeout_s)
            or timeout_s <= 0
        ):
            raise ContinuationCheckpointError("Pending SDK action identity is invalid")
        action = {
            "tool_use_id": tool_use_id,
            "tool_name": tool_name,
            "tool_input": _copy(tool_input),
            "tool_input_sha256": _action_hash(tool_input),
        }
        try:
            async with asyncio.timeout(timeout_s), self._changed:
                while True:
                    if self._failure:
                        raise ContinuationCheckpointError(self._failure)
                    if self._session and self._session != session_id:
                        raise ContinuationCheckpointError("Pending SDK session identity changed")
                    if _pending_action_present(self._entries, action):
                        body = _encode(
                            {
                                "version": CHECKPOINT_VERSION,
                                "identity": asdict(identity),
                                "project_key": self.project_key,
                                "session_id": session_id,
                                "action": action,
                                "entries": self._entries,
                            }
                        )
                        decode_checkpoint(body, identity)
                        return body
                    await self._changed.wait()
        except TimeoutError as exc:
            raise ContinuationCheckpointError(
                "SDK mirror did not acknowledge the pending action"
            ) from exc

    @classmethod
    def restore(cls, body: bytes, identity: CheckpointIdentity) -> CheckpointSessionStore:
        envelope = decode_checkpoint(body, identity)
        store = cls(envelope["project_key"])
        store._session = envelope["session_id"]
        store._entries = envelope["entries"]
        return store


class S3ContinuationCheckpoints:
    """Store immutable, encrypted checkpoints under a task/attempt/request key.

    The bucket must have versioning enabled. The task role needs PutObject,
    GetObject and GetObjectVersion for its own continuations/<task_id>/ prefix.
    This adapter never lists buckets, deletes data or falls back to ambient AWS
    credentials. The caller must arrange retention after the owning request
    closes; this adapter does not configure object expiration.
    """

    def __init__(self, bucket: str, *, client: Any = None) -> None:
        if not isinstance(bucket, str) or not bucket or "/" in bucket:
            raise ContinuationCheckpointError("Checkpoint bucket is unavailable")
        if client is None:
            from botocore.config import Config

            from aws_session import is_scoped, tenant_client

            if not is_scoped():
                raise ContinuationCheckpointError(
                    "Checkpoint storage requires task-scoped credentials"
                )
            client = tenant_client(
                "s3",
                config=Config(connect_timeout=2, read_timeout=5, retries={"total_max_attempts": 1}),
            )
        self.bucket, self.client = bucket, client

    def _read(self, key: str, *, version_id: str | None = None) -> tuple[bytes, str]:
        kwargs = {"Bucket": self.bucket, "Key": key, "ChecksumMode": "ENABLED"}
        if version_id is not None:
            kwargs["VersionId"] = version_id
        response = self.client.get_object(**kwargs)
        stream = response["Body"]
        try:
            size = response.get("ContentLength")
            if type(size) is not int or not 0 < size <= MAX_CHECKPOINT_BYTES:
                raise ContinuationCheckpointError("Stored checkpoint byte limit exceeded")
            body = stream.read(MAX_CHECKPOINT_BYTES + 1)
            if len(body) != size:
                raise ContinuationCheckpointError("Stored checkpoint is incomplete")
        finally:
            stream.close()
        actual_version = response.get("VersionId")
        if (
            not isinstance(actual_version, str)
            or not actual_version
            or actual_version == "null"
            or (version_id is not None and actual_version != version_id)
        ):
            raise ContinuationCheckpointError("Checkpoint storage requires an exact object version")
        checksum = base64.b64encode(hashlib.sha256(body).digest()).decode()
        if response.get("ChecksumSHA256") != checksum:
            raise ContinuationCheckpointError(
                "Stored checkpoint checksum is unavailable or incorrect"
            )
        return body, actual_version

    def save(self, body: bytes, identity: CheckpointIdentity) -> CheckpointReceipt:
        """Read back and verify even after an ambiguous write response."""
        decode_checkpoint(body, identity)
        digest = hashlib.sha256(body).hexdigest()
        key = identity.prefix + digest + ".json"
        write_error: Exception | None = None
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=body,
                ContentType="application/json",
                ServerSideEncryption="AES256",
                ChecksumSHA256=base64.b64encode(hashlib.sha256(body).digest()).decode(),
                IfNoneMatch="*",
            )
        except Exception as exc:
            # A timeout can follow a committed write; a repeated save can also
            # return 412. Only exact read-back permits an acknowledgement.
            write_error = exc
        try:
            stored, version = self._read(key)
            if stored != body:
                raise ContinuationCheckpointError(
                    "Stored checkpoint differs from the prepared data"
                )
        except Exception as exc:
            cause = write_error if write_error is not None else exc
            raise ContinuationCheckpointError(
                "Checkpoint could not be verified; keep the current worker available"
            ) from cause
        receipt = CheckpointReceipt(key, version, digest, len(body))
        receipt.validate(identity)
        return receipt

    def load(self, receipt: CheckpointReceipt, identity: CheckpointIdentity) -> bytes:
        receipt.validate(identity)
        try:
            body, _ = self._read(receipt.key, version_id=receipt.version_id)
        except Exception as exc:
            raise ContinuationCheckpointError("Saved checkpoint could not be read") from exc
        if len(body) != receipt.size_bytes or hashlib.sha256(body).hexdigest() != receipt.sha256:
            raise ContinuationCheckpointError("Saved checkpoint does not match its receipt")
        decode_checkpoint(body, identity)
        return body
