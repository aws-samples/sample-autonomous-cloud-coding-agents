# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Conversation recovery must acknowledge exact data, not merely a write attempt."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
from dataclasses import replace
from typing import TYPE_CHECKING, Any
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

import continuation_session as checkpoint
from hooks import _sha256_tool_input_for_row

if TYPE_CHECKING:
    from claude_agent_sdk import SessionKey

SESSION_ID = "11111111-1111-4111-8111-aaaaaaaaaaaa"
PROJECT = "-workspace-task"
KEY: SessionKey = {"project_key": PROJECT, "session_id": SESSION_ID}
IDENTITY = checkpoint.CheckpointIdentity("task", "attempt", "request", "user", "owner/repo")
TOOL_INPUT = {"file_path": "/workspace/task/雪.txt", "offset": 1}


def assistant(**overrides) -> Any:
    entry = {
        "type": "assistant",
        "uuid": "entry-1",
        "sessionId": SESSION_ID,
        "message": {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "toolu_owned", "name": "Read", "input": TOOL_INPUT}
            ],
        },
    }
    entry.update(overrides)
    return entry


async def capture(store, **kwargs):
    return await store.checkpoint_pending(
        IDENTITY,
        session_id=SESSION_ID,
        tool_use_id="toolu_owned",
        tool_name="Read",
        tool_input=TOOL_INPUT,
        timeout_s=0.1,
        **kwargs,
    )


@pytest.fixture
def body():
    async def prepare():
        store = checkpoint.CheckpointSessionStore(PROJECT)
        await store.append(KEY, [assistant()])
        return await capture(store)

    return asyncio.run(prepare())


class TestSessionMirror:
    def test_checkpoint_waits_for_exact_action_and_preserves_full_input(self):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            pending = asyncio.create_task(capture(store))
            await asyncio.sleep(0)
            assert not pending.done()
            await store.append(KEY, [assistant()])
            result = checkpoint.decode_checkpoint(await pending, IDENTITY)
            assert result["action"]["tool_input"] == TOOL_INPUT
            assert result["action"]["tool_input_sha256"] == _sha256_tool_input_for_row(TOOL_INPUT)
            assert result["session_id"] == SESSION_ID

        asyncio.run(scenario())

    def test_uuid_upserts_keep_order_and_opaque_fields_without_deduplicating_markers(self):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            user: Any = {"type": "user", "uuid": "user-1", "opaque": {"future": [1, 2]}}
            marker: Any = {"type": "mode", "data": "plan"}
            await store.append(KEY, [user, assistant(), marker])
            replacement = assistant(opaque={"changed": True})
            await store.append(KEY, [replacement, marker])
            expected = [user, replacement, marker, marker]
            assert await store.load(KEY) == expected
            replacement["opaque"]["changed"] = False
            loaded: Any = await store.load(KEY)
            loaded[0]["opaque"]["future"].append(3)
            unchanged: Any = await store.load(KEY)
            assert unchanged[1]["opaque"] == {"changed": True}
            assert unchanged[0]["opaque"]["future"] == [1, 2]

        asyncio.run(scenario())

    def test_restore_round_trip_through_public_store_contract(self, body):
        async def scenario():
            restored = checkpoint.CheckpointSessionStore.restore(body, IDENTITY)
            assert await restored.load(KEY) == [assistant()]
            reply: Any = {"type": "user", "uuid": "reply", "decision": "deny"}
            await restored.append(KEY, [reply])
            loaded = await restored.load(KEY)
            assert loaded is not None and len(loaded) == 2

        asyncio.run(scenario())

    def test_missing_mirror_never_certifies_the_checkpoint(self):
        async def scenario():
            with pytest.raises(
                checkpoint.ContinuationCheckpointError, match="did not acknowledge"
            ) as error:
                await capture(checkpoint.CheckpointSessionStore(PROJECT))
            assert error.value.code == "checkpoint_sdk_timeout"

        asyncio.run(scenario())

    @pytest.mark.parametrize(
        "bad_key",
        [
            {**KEY, "project_key": "other"},
            {**KEY, "session_id": "../../escape"},
            {**KEY, "subpath": "subagents/agent-other"},
        ],
    )
    def test_a_mirror_gap_prevents_later_checkpoint_acknowledgement(self, bad_key):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            with pytest.raises(checkpoint.ContinuationCheckpointError):
                await store.append(bad_key, [assistant()])
            await store.append(KEY, [assistant()])
            with pytest.raises(checkpoint.ContinuationCheckpointError, match="Unexpected SDK"):
                await capture(store)

        asyncio.run(scenario())

    def test_mismatched_action_fails_instead_of_waiting_for_a_later_match(self):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            entry = assistant()
            entry["message"]["content"][0]["input"] = {"file_path": "/different"}
            await store.append(KEY, [entry])
            with pytest.raises(checkpoint.ContinuationCheckpointError, match="disagrees"):
                await capture(store)

        asyncio.run(scenario())

    def test_completed_tool_cannot_be_recorded_as_pending(self):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            result: Any = {
                "type": "user",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_owned"}]},
            }
            await store.append(
                KEY,
                [assistant(), result],
            )
            with pytest.raises(checkpoint.ContinuationCheckpointError, match="already has"):
                await capture(store)

        asyncio.run(scenario())

    def test_buffer_limit_failure_does_not_silently_drop_entries(self, monkeypatch):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            monkeypatch.setattr(checkpoint, "MAX_CHECKPOINT_ENTRIES", 1)
            with pytest.raises(checkpoint.ContinuationCheckpointError, match="limit"):
                await store.append(KEY, [assistant(), {"type": "mode"}])
            with pytest.raises(checkpoint.ContinuationCheckpointError, match="limit"):
                await capture(store)

        asyncio.run(scenario())

    def test_cancelled_checkpoint_wait_propagates_cancellation(self):
        async def scenario():
            task = asyncio.create_task(capture(checkpoint.CheckpointSessionStore(PROJECT)))
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())

    def test_unwritten_session_load_returns_none(self):
        assert asyncio.run(checkpoint.CheckpointSessionStore(PROJECT).load(KEY)) is None

    def test_transcript_cannot_mix_another_session_into_the_saved_conversation(self):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            with pytest.raises(checkpoint.ContinuationCheckpointError, match="another SDK session"):
                await store.append(
                    KEY, [assistant(sessionId="22222222-2222-4222-8222-bbbbbbbbbbbb")]
                )

        asyncio.run(scenario())

    def test_duplicate_tool_identity_is_ambiguous(self):
        async def scenario():
            store = checkpoint.CheckpointSessionStore(PROJECT)
            await store.append(KEY, [assistant(), assistant(uuid="different-entry")])
            with pytest.raises(checkpoint.ContinuationCheckpointError, match="duplicate"):
                await capture(store)

        asyncio.run(scenario())


class VersionedS3:
    """A versioned object service with commit-then-disconnect failure injection."""

    def __init__(self):
        self.objects = {}
        self.calls = []
        self.write_error = None
        self.lose_write_reply = False
        self.versioned = True
        self.bad_checksum = False
        self.bad_length = False
        self.streams = []

    def put_object(self, **kwargs):
        self.calls.append(("put", kwargs))
        if self.write_error:
            raise self.write_error
        object_key = (kwargs["Bucket"], kwargs["Key"])
        if kwargs.get("IfNoneMatch") == "*" and object_key in self.objects:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        versions = self.objects.setdefault(object_key, [])
        version = f"version-{len(versions) + 1}" if self.versioned else "null"
        versions.append((version, kwargs["Body"]))
        if self.lose_write_reply:
            raise EndpointConnectionError(endpoint_url="https://s3.invalid")
        return {"VersionId": version}

    def get_object(self, **kwargs):
        self.calls.append(("get", kwargs))
        versions = self.objects.get((kwargs["Bucket"], kwargs["Key"]))
        if not versions:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        requested = kwargs.get("VersionId")
        version, body = (
            next(v for v in versions if v[0] == requested) if requested else versions[-1]
        )
        stream = io.BytesIO(body)
        self.streams.append(stream)
        return {
            "Body": stream,
            "VersionId": version,
            "ContentLength": len(body) + int(self.bad_length),
            "ChecksumSHA256": "wrong"
            if self.bad_checksum
            else base64.b64encode(hashlib.sha256(body).digest()).decode(),
        }


class TestImmutableStorage:
    def test_missing_bucket_reports_storage_configuration_failure(self):
        with pytest.raises(checkpoint.ContinuationCheckpointError) as error:
            checkpoint.S3ContinuationCheckpoints("")
        assert error.value.code == "checkpoint_storage_unavailable"

    @pytest.fixture
    def storage(self):
        client = VersionedS3()
        return checkpoint.S3ContinuationCheckpoints("private-checkpoints", client=client), client

    def test_default_client_refuses_ambient_credentials(self, monkeypatch):
        import aws_session

        client_factory = Mock()
        monkeypatch.setattr(aws_session, "is_scoped", lambda: False)
        monkeypatch.setattr(aws_session, "tenant_client", client_factory)
        with pytest.raises(checkpoint.ContinuationCheckpointError, match="task-scoped credentials"):
            checkpoint.S3ContinuationCheckpoints("private-checkpoints")
        client_factory.assert_not_called()

    def test_default_client_uses_attributed_scoped_factory(self, monkeypatch):
        import aws_session

        client_factory = Mock(return_value=VersionedS3())
        monkeypatch.setattr(aws_session, "is_scoped", lambda: True)
        monkeypatch.setattr(aws_session, "tenant_client", client_factory)
        store = checkpoint.S3ContinuationCheckpoints("private-checkpoints")
        assert store.client is client_factory.return_value
        assert client_factory.call_args.args == ("s3",)
        assert client_factory.call_args.kwargs["config"].retries == {"total_max_attempts": 1}

    def test_save_requires_read_back_and_returns_a_version_pinned_receipt(self, storage, body):
        store, client = storage
        receipt = store.save(body, IDENTITY)
        assert [call[0] for call in client.calls] == ["put", "get"]
        assert receipt.key == IDENTITY.prefix + hashlib.sha256(body).hexdigest() + ".json"
        assert client.calls[0][1]["IfNoneMatch"] == "*"
        assert client.calls[0][1]["ServerSideEncryption"] == "AES256"
        assert store.load(receipt, IDENTITY) == body
        assert client.calls[-1][1]["VersionId"] == receipt.version_id
        assert all(stream.closed for stream in client.streams)

    def test_unreadable_saved_version_reports_storage_failure(self, storage, body):
        store, client = storage
        receipt = store.save(body, IDENTITY)
        client.get_object = Mock(
            side_effect=ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
        )
        with pytest.raises(checkpoint.ContinuationCheckpointError) as error:
            store.load(receipt, IDENTITY)
        assert error.value.code == "checkpoint_storage_unavailable"

    def test_lost_write_reply_recovers_from_exact_read_back(self, storage, body):
        store, client = storage
        client.lose_write_reply = True
        receipt = store.save(body, IDENTITY)
        assert receipt.version_id == "version-1"
        assert store.save(body, IDENTITY) == receipt
        assert len(client.objects[(store.bucket, receipt.key)]) == 1

    def test_uncommitted_write_failure_never_returns_a_receipt(self, storage, body):
        store, client = storage
        client.write_error = ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")
        with pytest.raises(checkpoint.ContinuationCheckpointError, match="keep the current worker"):
            store.save(body, IDENTITY)
        assert not client.objects

    @pytest.mark.parametrize("failure", ["versioned", "bad_checksum", "bad_length"])
    def test_unverifiable_storage_never_acknowledges(self, storage, body, failure):
        store, client = storage
        setattr(client, failure, failure != "versioned")
        with pytest.raises(
            checkpoint.ContinuationCheckpointError, match="could not be verified"
        ) as error:
            store.save(body, IDENTITY)
        assert error.value.code == "checkpoint_storage_unverified"
        assert all(stream.closed for stream in client.streams)

    def test_load_keeps_the_original_version_even_if_current_key_changes(self, storage, body):
        store, client = storage
        receipt = store.save(body, IDENTITY)
        client.put_object(Bucket=store.bucket, Key=receipt.key, Body=b"replacement")
        assert store.load(receipt, IDENTITY) == body

    @pytest.mark.parametrize("field", ["task_id", "attempt_id", "request_id", "user_id", "repo"])
    def test_cross_identity_data_is_rejected_before_any_io(self, storage, body, field):
        store, client = storage
        wrong = replace(IDENTITY, **{field: "other"})
        with pytest.raises(checkpoint.ContinuationCheckpointError, match="identity"):
            store.save(body, wrong)
        assert not client.calls

    def test_receipt_cannot_redirect_a_read_outside_its_task(self, storage, body):
        store, client = storage
        receipt = store.save(body, IDENTITY)
        count = len(client.calls)
        with pytest.raises(checkpoint.ContinuationCheckpointError, match="outside this task"):
            store.load(replace(receipt, key="continuations/other/data"), IDENTITY)
        assert len(client.calls) == count

    def test_valid_transport_checksum_does_not_replace_receipt_integrity(self, storage, body):
        store, client = storage
        receipt = store.save(body, IDENTITY)
        client.objects[(store.bucket, receipt.key)][0] = (receipt.version_id, b"x" * len(body))
        with pytest.raises(checkpoint.ContinuationCheckpointError, match="does not match"):
            store.load(receipt, IDENTITY)


class TestEnvelope:
    @pytest.mark.parametrize(
        "change",
        [
            lambda data: data.update(version=2),
            lambda data: data.update(version=True),
            lambda data: data.update(session_id="../../other"),
            lambda data: data["action"].update(tool_input_sha256="0" * 64),
            lambda data: data["action"].update(tool_input={"file_path": "changed"}),
            lambda data: data.update(entries=[]),
            lambda data: data.update(environment={"AWS_SECRET_ACCESS_KEY": "synthetic"}),
        ],
    )
    def test_corrupt_or_incompatible_envelope_fails(self, body, change):
        data = json.loads(body)
        change(data)
        with pytest.raises(checkpoint.ContinuationCheckpointError):
            checkpoint.decode_checkpoint(json.dumps(data).encode(), IDENTITY)

    @pytest.mark.parametrize("body", [b"{", b"\xff", b"null", b""])
    def test_invalid_json_fails(self, body):
        with pytest.raises(checkpoint.ContinuationCheckpointError) as error:
            checkpoint.decode_checkpoint(body, IDENTITY)
        assert error.value.code == (
            "checkpoint_failed" if body in (b"null", b"") else "checkpoint_invalid_json"
        )

    @pytest.mark.parametrize("value", ["../task", "", "task/other", "x" * 129])
    def test_path_components_cannot_escape_task_prefix(self, value):
        with pytest.raises(checkpoint.ContinuationCheckpointError):
            replace(IDENTITY, task_id=value)


def test_invalid_json_reports_a_specific_checkpoint_code():
    with pytest.raises(checkpoint.ContinuationCheckpointError) as error:
        checkpoint._encode({"not_json": object()})
    assert error.value.code == "checkpoint_invalid_json"


def test_unspecified_checkpoint_failure_does_not_claim_invalid_data():
    assert checkpoint.ContinuationCheckpointError("Unknown failure").code == "checkpoint_failed"
