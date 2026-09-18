# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Real offline Git/working-tree recovery and hostile archive boundary checks."""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import subprocess
import tarfile
import time
from dataclasses import replace
from pathlib import Path

import pytest

import continuation_workspace as workspace
from continuation_session import CheckpointIdentity

IDENTITY = CheckpointIdentity("task", "attempt", "approval", "owner", "example/repository")


def git(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_AUTHOR_NAME="Fixture",
        GIT_AUTHOR_EMAIL="fixture@example.invalid",
        GIT_COMMITTER_NAME="Fixture",
        GIT_COMMITTER_EMAIL="fixture@example.invalid",
        LC_ALL="C",
    )
    return subprocess.check_output(
        ["git", "-c", f"core.hooksPath={os.devnull}", *args],
        cwd=root,
        env=env,
        stderr=subprocess.PIPE,
        timeout=10,
    )


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "--quiet", "--template=", "--initial-branch=work/task")
    (root / "tracked.txt").write_text("committed\n")
    (root / "binary.dat").write_bytes(b"\0original\xff")
    (root / "deleted.txt").write_text("delete from working tree")
    (root / "renamed.txt").write_text("rename in index")
    (root / "run.sh").write_text("#!/bin/sh\nexit 0\n")
    (root / ".gitignore").write_text("ignored/\n")
    git(root, "add", ".")
    git(root, "commit", "--quiet", "-m", "base")
    (root / "local-commit.txt").write_text("unpushed work")
    git(root, "add", ".")
    git(root, "commit", "--quiet", "-m", "unpushed commit")
    git(root, "tag", "local-tag")
    git(root, "branch", "another-branch")
    git(root, "remote", "add", "origin", "https://github.com/example/repository.git")
    (root / "tracked.txt").write_text("staged\n")
    (root / "binary.dat").write_bytes(b"\0staged\xfe")
    git(root, "add", "tracked.txt", "binary.dat")
    git(root, "mv", "renamed.txt", "renamed-new.txt")
    (root / "tracked.txt").write_text("unstaged\n")
    (root / "binary.dat").write_bytes(b"\0unstaged\xfd")
    (root / "deleted.txt").unlink()
    (root / "run.sh").chmod(0o755)
    (root / "untracked 雪\nfile.txt").write_text("untracked")
    (root / "ignored").mkdir()
    (root / "ignored/important.bin").write_bytes(b"\0ignored but required")
    (root / ".git/info").mkdir(exist_ok=True)
    (root / ".git/info/exclude").write_text("local-ignored.txt\n")
    (root / "local-ignored.txt").write_text("local ignore rules must survive")
    (root / "empty").mkdir()
    os.symlink("tracked.txt", root / "relative-link")
    git(root, "config", "--local", "http.extraHeader", "SYNTHETIC_AUTH_MUST_NOT_BE_COPIED")
    hooks = root / ".git/hooks"
    hooks.mkdir(exist_ok=True)
    marker = tmp_path / "hook-ran"
    hook = hooks / "post-checkout"
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
    hook.chmod(0o755)
    return root


def saved(repo):
    archive = repo.parent / "workspace.tar"
    receipt = workspace.capture_workspace(repo, archive, IDENTITY)
    return archive, receipt


def remove_original(repo):
    # Preserve the original owned test tree for comparison without leaving it at
    # the stable path that the replacement worker must use.
    original = repo.with_name("original")
    repo.rename(original)
    return original


def inventory(root):
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        if Path(directory) == root:
            dirs.remove(".git")
        for name in dirs + files:
            path = Path(directory) / name
            info = path.lstat()
            value = (
                os.readlink(path)
                if path.is_symlink()
                else path.read_bytes()
                if path.is_file()
                else None
            )
            result[str(path.relative_to(root))] = (
                stat.S_IFMT(info.st_mode),
                info.st_mode & 0o777,
                value,
            )
    return result


def rewrite(archive, *, mutate_manifest=None, mutate_member=None, extras=()):
    records = []
    with tarfile.open(archive, "r:") as tar:
        for member in tar:
            stream = tar.extractfile(member) if member.isfile() else None
            data = stream.read() if stream else None
            if stream:
                stream.close()
            if member.name == "manifest.json" and mutate_manifest:
                assert data is not None
                manifest = json.loads(data)
                mutate_manifest(manifest)
                data = json.dumps(manifest).encode()
                member.size = len(data)
            if mutate_member:
                member, data = mutate_member(member, data)
            records.append((member, data))
    with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as tar:
        for member, data in [*records, *extras]:
            tar.addfile(member, io.BytesIO(data) if data is not None else None)
    return hashlib.sha256(archive.read_bytes()).hexdigest()


class TestWorkspaceRoundTrip:
    def test_preserves_commits_staged_unstaged_binary_deleted_untracked_ignored_and_modes(
        self, repo
    ):
        expected_files = inventory(repo)
        expected_index = git(repo, "ls-files", "--stage", "-z")
        expected_diff = git(repo, "diff", "--binary", "--no-ext-diff", "--no-textconv")
        expected_refs = git(repo, "for-each-ref", "--format=%(objectname) %(refname)")
        expected_ignored = git(
            repo, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"
        )
        archive, receipt = saved(repo)
        assert receipt.head == git(repo, "rev-parse", "HEAD").decode().strip()
        assert receipt.branch == "work/task"
        assert archive.stat().st_mode & 0o777 == 0o600
        assert b"SYNTHETIC_AUTH_MUST_NOT_BE_COPIED" not in archive.read_bytes()
        original = remove_original(repo)
        restored = workspace.restore_workspace(
            archive, repo, IDENTITY, expected_sha256=receipt.sha256
        )
        assert restored == receipt
        assert inventory(repo) == expected_files
        assert git(repo, "ls-files", "--stage", "-z") == expected_index
        assert git(repo, "diff", "--binary", "--no-ext-diff", "--no-textconv") == expected_diff
        assert git(repo, "for-each-ref", "--format=%(objectname) %(refname)") == expected_refs
        assert (
            git(repo, "ls-files", "--others", "--ignored", "--exclude-standard", "-z")
            == expected_ignored
        )
        assert git(repo, "log", "--format=%s").splitlines() == [b"unpushed commit", b"base"]
        assert (
            git(repo, "remote", "get-url", "origin").strip()
            == b"https://github.com/example/repository.git"
        )
        assert (
            git(repo, "config", "--local", "credential.helper").strip()
            == b"!gh auth git-credential"
        )
        assert "SYNTHETIC_AUTH" not in (repo / ".git/config").read_text()
        assert not (repo / ".git/hooks/post-checkout").exists()
        assert not (repo.parent / "hook-ran").exists()
        assert inventory(original) == expected_files
        assert not list(repo.parent.glob(".workspace-*"))

    def test_detached_head_is_preserved(self, repo):
        git(repo, "checkout", "--detach")
        archive, receipt = saved(repo)
        remove_original(repo)
        workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=receipt.sha256)
        assert receipt.branch is None
        assert git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == b"HEAD"

    def test_external_symlink_is_saved_as_a_leaf_without_reading_its_target(self, repo):
        secret = repo.parent / "outside"
        secret.write_text("SYNTHETIC_OUTSIDE_DATA_NOT_IN_ARCHIVE")
        os.symlink(secret, repo / "outside-link")
        archive, receipt = saved(repo)
        assert secret.read_bytes() not in archive.read_bytes()
        remove_original(repo)
        workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=receipt.sha256)
        assert os.readlink(repo / "outside-link") == str(secret)
        assert secret.read_text() == "SYNTHETIC_OUTSIDE_DATA_NOT_IN_ARCHIVE"

    def test_external_diff_configuration_does_not_execute_during_capture(self, repo):
        script = repo.parent / "external-diff"
        marker = repo.parent / "diff-ran"
        script.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
        script.chmod(0o755)
        git(repo, "config", "diff.external", str(script))
        saved(repo)
        assert not marker.exists()


class TestCaptureFailures:
    def test_git_deadline_stops_the_process_group(self, repo):
        git(repo, "config", "alias.checkpoint-wait", "!sleep 10")
        started = time.monotonic()
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace._git(repo, ["checkpoint-wait"], workspace.WorkspaceLimits(git_timeout_s=1))
        assert error.value.code == "git_timeout"
        assert time.monotonic() - started < 5

    @pytest.mark.parametrize("repo_name", ["../repo", "owner/..", "https://github.com/owner/repo"])
    def test_repository_identity_must_also_be_restorable(self, repo, repo_name):
        destination = repo.parent / "workspace.tar"
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.capture_workspace(repo, destination, replace(IDENTITY, repo=repo_name))
        assert error.value.code == "invalid_identity"
        assert not destination.exists()

    def test_submodule_index_entry_fails_without_fetching_it(self, repo):
        head = git(repo, "rev-parse", "HEAD").decode().strip()
        git(repo, "update-index", "--add", "--cacheinfo", f"160000,{head},submodule")
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            saved(repo)
        assert error.value.code == "unsupported_git"

    @pytest.mark.parametrize(
        "limits,code",
        [
            (workspace.WorkspaceLimits(max_bytes=32), "size_limit"),
            (workspace.WorkspaceLimits(max_entries=1), "entry_limit"),
        ],
    )
    def test_limits_do_not_publish_partial_archive(self, repo, limits, code):
        expected = inventory(repo)
        destination = repo.parent / "limited.tar"
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.capture_workspace(repo, destination, IDENTITY, limits=limits)
        assert error.value.code == code
        assert not destination.exists()
        assert inventory(repo) == expected
        assert not list(repo.parent.glob(".workspace-capture-*"))

    @pytest.mark.parametrize(
        "path", ["MERGE_HEAD", "index.lock", "shallow", "objects/info/alternates"]
    )
    def test_active_or_nonportable_git_layout_fails(self, repo, path):
        target = repo / ".git" / path
        target.parent.mkdir(exist_ok=True, parents=True)
        target.touch()
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            saved(repo)
        assert error.value.code == "unsupported_git"

    @pytest.mark.parametrize("flag", ["--assume-unchanged", "--skip-worktree", "intent-to-add"])
    def test_nonportable_index_flags_fail_instead_of_losing_state(self, repo, flag):
        if flag == "intent-to-add":
            (repo / "intent.txt").write_text("not staged yet")
            git(repo, "add", "-N", "intent.txt")
        else:
            git(repo, "update-index", flag, "tracked.txt")
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            saved(repo)
        assert error.value.code == "unsupported_git"

    @pytest.mark.parametrize("kind", ["fifo", "hardlink", "nested-git"])
    def test_special_files_are_rejected(self, repo, kind):
        target = repo / "unsupported"
        if kind == "fifo":
            os.mkfifo(target)
        elif kind == "hardlink":
            os.link(repo / "tracked.txt", target)
        else:
            target.mkdir()
            (target / ".git").mkdir()
        with pytest.raises(workspace.WorkspaceCheckpointError):
            saved(repo)
        assert not (repo.parent / "workspace.tar").exists()

    def test_existing_archive_is_not_overwritten(self, repo):
        destination = repo.parent / "workspace.tar"
        destination.write_bytes(b"keep")
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            saved(repo)
        assert error.value.code == "destination_exists"
        assert destination.read_bytes() == b"keep"

    def test_archive_cannot_be_written_inside_the_workspace(self, repo):
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.capture_workspace(repo, repo / "backup.tar", IDENTITY)
        assert error.value.code == "invalid_path"

    def test_worktree_mutation_prevents_acknowledgement(self, repo, monkeypatch):
        real_read = workspace._DigestReader.read
        changed = False

        def mutate(reader, size=-1):
            nonlocal changed
            block = real_read(reader, size)
            if not changed:
                changed = True
                (repo / "created-during-capture").write_text("concurrent writer")
            return block

        monkeypatch.setattr(workspace._DigestReader, "read", mutate)
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            saved(repo)
        assert error.value.code == "workspace_changed"
        assert not (repo.parent / "workspace.tar").exists()

    def test_racing_destination_is_not_replaced(self, repo, monkeypatch):
        real_link = os.link
        destination = repo.parent / "workspace.tar"

        def race(source, target):
            destination.write_bytes(b"other writer")
            real_link(source, target)

        monkeypatch.setattr(workspace.os, "link", race)
        with pytest.raises(workspace.WorkspaceCheckpointError):
            saved(repo)
        assert destination.read_bytes() == b"other writer"


class TestRestoreBoundaries:
    def test_existing_workspace_is_never_cleared(self, repo):
        archive, receipt = saved(repo)
        before = inventory(repo)
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=receipt.sha256)
        assert error.value.code == "destination_exists"
        assert inventory(repo) == before

    def test_receipt_checksum_is_required(self, repo):
        archive, _ = saved(repo)
        remove_original(repo)
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256="0" * 64)
        assert error.value.code == "checksum_mismatch"
        assert not repo.exists()

    @pytest.mark.parametrize("field", ["task_id", "attempt_id", "request_id", "user_id", "repo"])
    def test_cross_identity_restore_is_rejected(self, repo, field):
        archive, receipt = saved(repo)
        remove_original(repo)
        wrong = replace(IDENTITY, **{field: "other/repo" if field == "repo" else "other"})
        with pytest.raises(workspace.WorkspaceCheckpointError):
            workspace.restore_workspace(archive, repo, wrong, expected_sha256=receipt.sha256)
        assert not repo.exists()

    def test_workspace_path_must_remain_stable(self, repo):
        archive, receipt = saved(repo)
        target = repo.parent / "different-workspace"
        with pytest.raises(workspace.WorkspaceCheckpointError):
            workspace.restore_workspace(archive, target, IDENTITY, expected_sha256=receipt.sha256)
        assert not target.exists()

    @pytest.mark.parametrize(
        "change",
        [
            lambda m: m.update(version=True),
            lambda m: m.update(environment={"SYNTHETIC": "not allowed"}),
            lambda m: m["git"].update(index_sha256="0" * 64),
            lambda m: m["git"]["refs"].update({"refs/heads/../escape": "a" * 40}),
            lambda m: m["git"].update(branch="different"),
            lambda m: m["git"].update(exclude_b64="not valid base64"),
            lambda m: m["files"][0].update(path="../escape"),
        ],
    )
    def test_invalid_manifest_does_not_publish_a_workspace(self, repo, change):
        archive, _ = saved(repo)
        remove_original(repo)
        digest = rewrite(archive, mutate_manifest=change)
        with pytest.raises(workspace.WorkspaceCheckpointError):
            workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=digest)
        assert not repo.exists()
        assert not list(repo.parent.glob(".workspace-restore-*"))

    def test_changed_file_bytes_fail_inner_checksum_even_with_valid_outer_receipt(self, repo):
        archive, _ = saved(repo)
        remove_original(repo)

        def corrupt(member, data):
            if member.name == "files/tracked.txt":
                data = b"x" * len(data)
            return member, data

        digest = rewrite(archive, mutate_member=corrupt)
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=digest)
        assert error.value.code == "checksum_mismatch"
        assert not repo.exists()

    @pytest.mark.parametrize(
        "name,kind",
        [
            ("files/../escape", tarfile.REGTYPE),
            ("/absolute", tarfile.REGTYPE),
            ("files/.git/config", tarfile.REGTYPE),
            ("files/unlisted", tarfile.REGTYPE),
            ("files/empty/", tarfile.DIRTYPE),
            ("files/link", tarfile.LNKTYPE),
        ],
    )
    def test_extra_traversal_duplicate_and_hardlink_members_are_rejected(self, repo, name, kind):
        archive, _ = saved(repo)
        remove_original(repo)
        extra = tarfile.TarInfo(name)
        extra.type = kind
        extra.linkname = "files/tracked.txt" if kind == tarfile.LNKTYPE else ""
        digest = rewrite(archive, extras=[(extra, b"" if kind == tarfile.REGTYPE else None)])
        with pytest.raises(workspace.WorkspaceCheckpointError):
            workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=digest)
        assert not repo.exists()
        assert not (repo.parent / "escape").exists()

    def test_archive_cannot_write_through_a_symlink(self, repo):
        archive, _ = saved(repo)
        remove_original(repo)
        extra = tarfile.TarInfo("files/relative-link/escape")
        extra.mode = 0o644
        extra.size = 1

        def add_child(manifest):
            manifest["files"].append(
                {
                    "path": "relative-link/escape",
                    "kind": "file",
                    "mode": 0o644,
                    "size": 1,
                    "sha256": hashlib.sha256(b"x").hexdigest(),
                }
            )

        digest = rewrite(archive, mutate_manifest=add_child, extras=[(extra, b"x")])
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=digest)
        assert error.value.code == "invalid_archive"
        assert not repo.exists()

    def test_archive_change_during_restore_does_not_publish(self, repo, monkeypatch):
        archive, receipt = saved(repo)
        remove_original(repo)
        original_git = workspace._git

        def change(root, args, *rest, **kwargs):
            if args[0] == "init":
                with archive.open("ab") as stream:
                    stream.write(b"changed")
            return original_git(root, args, *rest, **kwargs)

        monkeypatch.setattr(workspace, "_git", change)
        with pytest.raises(workspace.WorkspaceCheckpointError) as error:
            workspace.restore_workspace(archive, repo, IDENTITY, expected_sha256=receipt.sha256)
        assert error.value.code == "workspace_changed"
        assert not repo.exists()
