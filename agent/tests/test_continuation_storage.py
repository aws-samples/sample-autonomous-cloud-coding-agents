# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Storage acknowledgement must survive retries without accepting partial state."""

from __future__ import annotations

import base64
import hashlib
import io
import json
from dataclasses import asdict, replace
from decimal import Decimal
from types import SimpleNamespace

import pytest

import continuation_storage as storage
from continuation_session import CheckpointIdentity, CheckpointReceipt
from models import RepoSetup

IDENTITY = CheckpointIdentity("task", "attempt", "request", "user", "owner/repo")


class RecordingStream(io.BytesIO):
    def __init__(self, body, max_read=1024 * 1024):
        super().__init__(body)
        self.read_sizes = []
        self.max_read = max_read

    def read(self, size=-1):
        assert 0 < size <= self.max_read
        self.read_sizes.append(size)
        return super().read(size)


class VersionedS3:
    def __init__(self):
        self.versions = {}
        self.calls = []
        self.streams = []
        self.lost_reply = False
        self.read_override = {}

    def put_object(self, **kwargs):
        self.calls.append(("put", kwargs))
        body = kwargs["Body"] if isinstance(kwargs["Body"], bytes) else kwargs["Body"].read()
        assert len(body) == kwargs.get("ContentLength", len(body))
        assert kwargs["IfNoneMatch"] == "*"
        assert kwargs["ServerSideEncryption"] == "AES256"
        assert base64.b64encode(hashlib.sha256(body).digest()).decode() == kwargs["ChecksumSHA256"]
        key = kwargs["Key"]
        if key in self.versions:
            raise RuntimeError("PreconditionFailed")
        self.versions[key] = [body]
        if self.lost_reply:
            raise TimeoutError("reply lost after commit")
        return {"VersionId": "1"}

    def get_object(self, **kwargs):
        self.calls.append(("get", kwargs))
        bodies = self.versions[kwargs["Key"]]
        version = kwargs.get("VersionId", str(len(bodies)))
        body = bodies[int(version) - 1]
        stream = RecordingStream(
            body, 16 * 1024 * 1024 + 1 if kwargs["Key"].endswith(".json") else 1024 * 1024
        )
        self.streams.append(stream)
        return {
            "Body": stream,
            "VersionId": version,
            "ContentLength": len(body),
            "ChecksumSHA256": base64.b64encode(hashlib.sha256(body).digest()).decode(),
            **self.read_override,
        }


@pytest.fixture
def prepared(tmp_path):
    source = tmp_path / "workspace.tar"
    source.write_bytes(b"saved workspace\n" * 180_000)
    client = VersionedS3()
    adapter = storage.S3ContinuationStorage("owned-bucket", client=client)
    return source, client, adapter


def manifest(receipt):
    digest = "a" * 64
    return storage.ContinuationManifest(
        IDENTITY,
        CheckpointReceipt(IDENTITY.prefix + digest + ".json", "1", digest, 10),
        receipt,
        storage.ContinuationContext(
            RepoSetup(repo_dir="/workspace/task", branch="agent/test", build_before=False),
            "Original user prompt",
            "Original system prompt",
            "coding/new-task-v1",
            "1",
        ),
    )


class TestPinnedFiles:
    @pytest.mark.parametrize("size", [Decimal("42.5"), Decimal("NaN"), "42", 42.0, True])
    def test_ddb_receipt_does_not_coerce_invalid_sizes(self, size):
        digest = "a" * 64
        value = asdict(
            storage.FileReceipt(
                "manifest", IDENTITY.prefix + "manifest/" + digest + ".json", "1", digest, 42
            )
        )
        value["size_bytes"] = size
        with pytest.raises(storage.ContinuationStorageError):
            storage.FileReceipt.from_record(value, IDENTITY)

    def test_ddb_integral_receipt_roundtrip(self):
        digest = "a" * 64
        receipt = storage.FileReceipt(
            "manifest", IDENTITY.prefix + "manifest/" + digest + ".json", "1", digest, 42
        )
        assert (
            storage.FileReceipt.from_record(
                {**asdict(receipt), "size_bytes": Decimal("42")}, IDENTITY
            )
            == receipt
        )

    def test_streamed_roundtrip_pins_version_even_after_current_object_changes(
        self, prepared, tmp_path
    ):
        source, client, adapter = prepared
        receipt = adapter.save_workspace(source, IDENTITY)
        client.versions[receipt.key].append(b"later unrelated contents")
        destination = tmp_path / "restored.tar"
        adapter.download_workspace(receipt, IDENTITY, destination)
        assert destination.read_bytes() == source.read_bytes()
        assert client.calls[-1][1]["VersionId"] == "1"
        assert all(stream.closed for stream in client.streams)
        assert len(client.streams[-1].read_sizes) > 2
        assert destination.stat().st_mode & 0o777 == 0o600
        assert not list(tmp_path.glob(".continuation-*"))

    def test_lost_put_reply_and_repeated_put_require_successful_readback(self, prepared):
        source, client, adapter = prepared
        client.lost_reply = True
        first = adapter.save_workspace(source, IDENTITY)
        assert adapter.save_workspace(source, IDENTITY) == first
        assert len(client.versions[first.key]) == 1

    @pytest.mark.parametrize(
        "override",
        [
            {"VersionId": "null"},
            {"VersionId": ""},
            {"ContentLength": 1},
            {"ContentLength": True},
            {"ChecksumSHA256": None},
        ],
    )
    def test_bad_readback_never_acknowledges_worker_release(self, prepared, override):
        source, client, adapter = prepared
        client.read_override = override
        with pytest.raises(storage.ContinuationStorageError, match="retain the worker"):
            adapter.save_workspace(source, IDENTITY)
        assert client.streams[-1].closed

    @pytest.mark.parametrize("payload", [b"short", b"x" * 2_880_000])
    def test_corrupt_or_truncated_stream_leaves_no_destination(self, prepared, tmp_path, payload):
        source, client, adapter = prepared
        receipt = adapter.save_workspace(source, IDENTITY)
        bad_stream = RecordingStream(payload)
        client.read_override["Body"] = bad_stream
        destination = tmp_path / "restored.tar"
        with pytest.raises(storage.ContinuationStorageError):
            adapter.download_workspace(receipt, IDENTITY, destination)
        assert not destination.exists()
        assert not list(tmp_path.glob(".continuation-*"))
        assert bad_stream.closed

    def test_existing_destination_is_never_overwritten(self, prepared, tmp_path):
        source, _, adapter = prepared
        receipt = adapter.save_workspace(source, IDENTITY)
        destination = tmp_path / "restored.tar"
        destination.write_text("keep me")
        with pytest.raises(FileExistsError):
            adapter.download_workspace(receipt, IDENTITY, destination)
        assert destination.read_text() == "keep me"
        assert not list(tmp_path.glob(".continuation-*"))

    def test_task_and_attempt_receipts_cannot_cross_boundaries(self, prepared, tmp_path):
        source, client, adapter = prepared
        receipt = adapter.save_workspace(source, IDENTITY)
        count = len(client.calls)
        for identity in (replace(IDENTITY, task_id="other"), replace(IDENTITY, attempt_id="other")):
            with pytest.raises(storage.ContinuationStorageError, match="receipt"):
                adapter.download_workspace(receipt, identity, tmp_path / "bad.tar")
        assert len(client.calls) == count

    def test_disk_pressure_is_distinct_and_detected_before_network(
        self, prepared, tmp_path, monkeypatch
    ):
        source, client, adapter = prepared
        receipt = adapter.save_workspace(source, IDENTITY)
        count = len(client.calls)
        monkeypatch.setattr(storage.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
        with pytest.raises(storage.ContinuationStorageError) as raised:
            adapter.download_workspace(receipt, IDENTITY, tmp_path / "bad.tar")
        assert raised.value.code == "disk_pressure"
        assert len(client.calls) == count

    def test_disk_pressure_during_download_removes_partial_file(
        self, prepared, tmp_path, monkeypatch
    ):
        source, _, adapter = prepared
        receipt = adapter.save_workspace(source, IDENTITY)
        readings = iter([10**12, 10**12, 0])
        monkeypatch.setattr(
            storage.shutil, "disk_usage", lambda _: SimpleNamespace(free=next(readings))
        )
        with pytest.raises(storage.ContinuationStorageError) as raised:
            adapter.download_workspace(receipt, IDENTITY, tmp_path / "bad.tar")
        assert raised.value.code == "disk_pressure"
        assert not list(tmp_path.glob(".continuation-*"))
        assert not (tmp_path / "bad.tar").exists()

    def test_upload_rejects_symlinks_and_hardlinks(self, prepared, tmp_path):
        source, client, adapter = prepared
        link = tmp_path / "link"
        link.symlink_to(source)
        with pytest.raises(OSError):
            adapter.save_workspace(link, IDENTITY)
        link.unlink()
        link.hardlink_to(source)
        with pytest.raises(storage.ContinuationStorageError, match="invalid"):
            adapter.save_workspace(source, IDENTITY)
        assert not client.calls

    def test_transfer_deadline_closes_stream_and_discards_partial_file(
        self, prepared, tmp_path, monkeypatch
    ):
        source, _, adapter = prepared
        receipt = adapter.save_workspace(source, IDENTITY)
        times = iter([0, 0, 0, 301])
        monkeypatch.setattr(storage.time, "monotonic", lambda: next(times))
        with pytest.raises(storage.ContinuationStorageError) as raised:
            adapter.download_workspace(receipt, IDENTITY, tmp_path / "bad.tar")
        assert raised.value.code == "transfer_timeout"
        assert not (tmp_path / "bad.tar").exists()


class TestManifest:
    def test_complete_manifest_preserves_baseline_and_exact_receipts(self, prepared):
        source, _, adapter = prepared
        record = manifest(adapter.save_workspace(source, IDENTITY))
        receipt = adapter.save_manifest(record)
        restored = adapter.load_manifest(receipt, IDENTITY)
        assert restored == record
        assert restored.context.setup.build_before is False
        assert restored.workspace.version_id == "1"

    @pytest.mark.parametrize(
        "change",
        [
            lambda value: value.update(version=True),
            lambda value: value["identity"].update(request_id="another"),
            lambda value: value["context"].update(github_token="must not be serialized"),
            lambda value: value["context"]["setup"].update(build_before="false"),
            lambda value: value["context"]["setup"].update(repo_dir="relative"),
            lambda value: value["workspace"].update(kind="manifest"),
            lambda value: value["conversation"].update(version_id="null"),
        ],
    )
    def test_manifest_rejects_mixed_identity_unknown_fields_and_invalid_context(
        self, prepared, change
    ):
        source, _, adapter = prepared
        body = manifest(adapter.save_workspace(source, IDENTITY)).encode(adapter.limits)
        value = json.loads(body)
        change(value)
        with pytest.raises(storage.ContinuationCheckpointError):
            storage.ContinuationManifest.decode(
                json.dumps(value).encode(), IDENTITY, adapter.limits
            )
