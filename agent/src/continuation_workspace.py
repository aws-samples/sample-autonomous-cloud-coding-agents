# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Offline workspace archives for future worker continuation.

The caller must stop workspace writers with the lifecycle barrier. Capture is
local only: durable upload/read-back and conditional publication alongside the
conversation receipt are separate requirements before releasing a worker.

Preserve all working files, including ignored files, rather than guessing which
can be regenerated. Rebuild Git administration from a bundle and staged patch;
never copy the original Git config, hooks, home directory or process environment.
Repository contents themselves remain private and may contain sensitive data.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, NoReturn

from continuation_session import CheckpointIdentity, ContinuationCheckpointError

_OID = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
_CHUNK = 1024 * 1024
_ADMIN = {"git.bundle", "index.patch", "manifest.json"}
_MAX_PATH_BYTES = 4096
_PERMISSION_BITS = 0o777
_MAX_EXCLUDE_BYTES = 1024 * 1024


class WorkspaceCheckpointError(ContinuationCheckpointError):
    """A content-free stage code suitable for future lifecycle feedback."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class WorkspaceLimits:
    max_bytes: int = 1024 * 1024 * 1024
    max_entries: int = 100_000
    git_timeout_s: int = 60

    def __post_init__(self) -> None:
        if any(
            type(value) is not int or value <= 0
            for value in (self.max_bytes, self.max_entries, self.git_timeout_s)
        ):
            raise ValueError("Workspace limits must be positive integers")


@dataclass(frozen=True)
class WorkspaceArchive:
    sha256: str
    size_bytes: int
    head: str
    branch: str | None
    entries: int


_DEFAULT_LIMITS = WorkspaceLimits()


def _fail(code: str, message: str) -> NoReturn:
    raise WorkspaceCheckpointError(code, message)


def _git(
    root: Path,
    args: list[str],
    limits: WorkspaceLimits,
    *,
    output: BinaryIO | None = None,
    max_bytes: int | None = None,
    source: BinaryIO | None = None,
) -> bytes:
    """Bound Git output/time, disable hooks/helpers, and never log repository data."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_ATTR_NOSYSTEM="1",
        GIT_NO_REPLACE_OBJECTS="1",
        GIT_TERMINAL_PROMPT="0",
        GIT_OPTIONAL_LOCKS="0",
        LC_ALL="C",
    )
    command = [
        "git",
        "-c",
        f"core.hooksPath={os.devnull}",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "gc.auto=0",
        "-c",
        "protocol.allow=never",
        "-c",
        f"safe.directory={root}",
        *args,
    ]
    target = output if output is not None else io.BytesIO()
    bound = max_bytes if max_bytes is not None else min(limits.max_bytes, 16 * 1024 * 1024)
    count = 0
    # stderr may contain repository contents/configuration; only the stage and
    # exit code cross this boundary. The caller retains its original workspace.
    with (
        subprocess.Popen(
            command,
            cwd=root,
            env=env,
            stdin=source if source is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        ) as process,
        selectors.DefaultSelector() as selector,
    ):
        if process.stdout is None:
            _fail("git_failed", "Workspace Git output pipe is unavailable")
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + limits.git_timeout_s
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _fail("git_timeout", f"Workspace Git {args[0]} timed out")
                for key, _ in selector.select(min(remaining, 0.1)):
                    block = os.read(key.fd, _CHUNK)
                    if not block:
                        selector.unregister(key.fd)
                        continue
                    count += len(block)
                    if count > bound:
                        _fail("size_limit", f"Workspace Git {args[0]} exceeds the byte limit")
                    target.write(block)
            try:
                code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired as exc:
                raise WorkspaceCheckpointError("git_timeout", "Workspace Git timed out") from exc
            if code:
                _fail("git_failed", f"Workspace Git {args[0]} failed (exit {code})")
        finally:
            if process.poll() is None:
                process.stdout.close()
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        # Git may exit between wait and killpg. An error is
                        # ignorable only after wait confirms that it exited.
                        process.wait(timeout=0.1)
                    process.wait()
    return target.getvalue() if isinstance(target, io.BytesIO) else b""


def _path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or len(value.encode()) > _MAX_PATH_BYTES:
        _fail("invalid_path", "Workspace archive path is invalid")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or str(path) != value
        or "\\" in value
        or "\0" in value
        or any(part in {".", ".."} or part.lower() == ".git" for part in path.parts)
    ):
        _fail("invalid_path", "Workspace archive path escapes the working tree")
    return path


def _stamp(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_mode,
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
        info.st_nlink,
    )


def _scan(root: Path, limits: WorkspaceLimits) -> dict[str, tuple[int, ...]]:
    entries = {}
    device = root.stat().st_dev
    for directory, dirs, files, fd in os.fwalk(root, follow_symlinks=False):
        relative = Path(directory).relative_to(root)
        if relative == Path("."):
            dirs[:] = [name for name in dirs if name != ".git"]
        for name in sorted(dirs + files):
            path = str(relative / name)
            _path(path)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if (
                not (
                    stat.S_ISREG(info.st_mode)
                    or stat.S_ISDIR(info.st_mode)
                    or stat.S_ISLNK(info.st_mode)
                )
                or info.st_dev != device
                or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1)
                or info.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX)
            ):
                _fail("unsupported_file", "Workspace has a special, linked or mounted file")
            entries[path] = _stamp(info)
            if len(entries) > limits.max_entries:
                _fail("entry_limit", "Workspace exceeds the entry limit")
    return dict(sorted(entries.items()))


def _open_file(root: Path, path: str) -> BinaryIO:
    """Open through directory descriptors; never traverse a substituted symlink."""
    parts = _path(path).parts
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        result = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        return os.fdopen(result, "rb")
    finally:
        os.close(fd)


def _git_state(root: Path, limits: WorkspaceLimits) -> dict:
    gitdir = root / ".git"
    if gitdir.is_symlink() or not gitdir.is_dir():
        _fail("unsupported_git", "Workspace requires a standalone Git checkout")
    for name in (
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
        "index.lock",
        "shallow",
        "objects/info/alternates",
        "info/grafts",
        "info/sparse-checkout",
    ):
        if os.path.lexists(gitdir / name):
            _fail("unsupported_git", "Workspace has an active or unsupported Git operation")
    if (
        _git(root, ["rev-parse", "--show-toplevel"], limits).decode().strip() != str(root)
        or Path(_git(root, ["rev-parse", "--absolute-git-dir"], limits).decode().strip()) != gitdir
        or _git(root, ["rev-parse", "--show-object-format"], limits).strip() != b"sha1"
    ):
        _fail("unsupported_git", "Workspace Git layout or object format is unsupported")
    head = _git(root, ["rev-parse", "HEAD"], limits).decode().strip()
    branch_value = _git(root, ["rev-parse", "--abbrev-ref", "HEAD"], limits).decode().strip()
    branch = None if branch_value == "HEAD" else branch_value
    refs = {}
    for line in _git(
        root, ["for-each-ref", "--format=%(objectname) %(refname)"], limits
    ).splitlines():
        oid, ref = line.decode().split(" ", 1)
        if ref.startswith("refs/replace/"):
            _fail("unsupported_git", "Workspace replacement refs cannot be checkpointed")
        refs[ref] = oid
    index = _git(root, ["ls-files", "--stage", "-z"], limits)
    for line in index.split(b"\0"):
        if not line:
            continue
        details, path = line.split(b"\t", 1)
        mode, _, stage = details.split()
        _path(path.decode())
        if mode == b"160000" or stage != b"0":
            _fail(
                "unsupported_git",
                "Workspace submodules or unresolved index entries are unsupported",
            )
    flags = _git(root, ["ls-files", "-v", "-z"], limits).split(b"\0")
    if any(entry and entry[:1] != b"H" for entry in flags):
        _fail("unsupported_git", "Workspace has sparse or assume-unchanged index flags")
    visible = _git(
        root,
        ["diff", "--cached", "--raw", "--no-ext-diff", "--no-textconv", "--ita-visible-in-index"],
        limits,
    )
    invisible = _git(
        root,
        ["diff", "--cached", "--raw", "--no-ext-diff", "--no-textconv", "--ita-invisible-in-index"],
        limits,
    )
    if visible != invisible:
        _fail("unsupported_git", "Workspace intent-to-add entries cannot be checkpointed")
    exclude_b64 = None
    if os.path.lexists(gitdir / "info/exclude"):
        with _open_file(gitdir, "info/exclude") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                _fail("unsupported_git", "Workspace Git ignore file must be regular")
            exclude = source.read(_MAX_EXCLUDE_BYTES + 1)
        if len(exclude) > _MAX_EXCLUDE_BYTES:
            _fail("size_limit", "Workspace Git ignore file exceeds the byte limit")
        exclude_b64 = base64.b64encode(exclude).decode()
    return {
        "head": head,
        "branch": branch,
        "refs": refs,
        "index_sha256": hashlib.sha256(index).hexdigest(),
        "exclude_b64": exclude_b64,
    }


class _DigestReader:
    def __init__(self, stream: BinaryIO) -> None:
        self.stream = stream
        self.digest = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        block = self.stream.read(size)
        self.digest.update(block)
        return block


def _file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _repository_identity(identity: CheckpointIdentity) -> None:
    if not _REPO.fullmatch(identity.repo) or any(
        part in {".", ".."} for part in identity.repo.split("/")
    ):
        _fail("invalid_identity", "Workspace repository identity is invalid")


def capture_workspace(
    workspace: Path,
    destination: Path,
    identity: CheckpointIdentity,
    *,
    limits: WorkspaceLimits = _DEFAULT_LIMITS,
) -> WorkspaceArchive:
    """Create an owned local archive; never overwrite a previously saved file."""
    try:
        return _capture_workspace(workspace, destination, identity, limits)
    except WorkspaceCheckpointError:
        raise
    except (
        OSError,
        ValueError,
        TypeError,
        RecursionError,
        subprocess.SubprocessError,
        tarfile.TarError,
    ) as exc:
        raise WorkspaceCheckpointError(
            "capture_failed", "Workspace capture failed; keep the worker available"
        ) from exc


def _capture_workspace(
    workspace: Path, destination: Path, identity: CheckpointIdentity, limits: WorkspaceLimits
) -> WorkspaceArchive:
    _repository_identity(identity)
    root = workspace.absolute()
    destination = destination.absolute()
    if root.resolve() != root or not root.is_dir():
        _fail("invalid_path", "Workspace must be an existing canonical directory")
    if destination.is_relative_to(root) or destination.parent.resolve() != destination.parent:
        _fail("invalid_path", "Workspace archive must be outside the working tree")
    if os.path.lexists(destination):
        _fail("destination_exists", "Workspace archive destination already exists")
    original = _git_state(root, limits)
    before = _scan(root, limits)
    with tempfile.TemporaryDirectory(
        prefix=".workspace-capture-", dir=destination.parent
    ) as scratch:
        temp = Path(scratch)
        bundle, patch = temp / "git.bundle", temp / "index.patch"
        with bundle.open("wb") as output:
            _git(
                root,
                ["bundle", "create", "-", "--all", "HEAD"],
                limits,
                output=output,
                max_bytes=limits.max_bytes,
            )
        with patch.open("wb") as output:
            _git(
                root,
                [
                    "diff",
                    "--cached",
                    "--binary",
                    "--full-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "HEAD",
                    "--",
                ],
                limits,
                output=output,
                max_bytes=limits.max_bytes - bundle.stat().st_size,
            )
        records = []
        total = bundle.stat().st_size + patch.stat().st_size
        archive = temp / "workspace.tar"
        with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as tar:
            for path, stamp in before.items():
                mode, _, _, size, *_ = stamp
                member = tarfile.TarInfo("files/" + path)
                member.mode = stat.S_IMODE(mode)
                record = {"path": path, "mode": member.mode}
                if stat.S_ISDIR(mode):
                    member.type = tarfile.DIRTYPE
                    record["kind"] = "directory"
                    tar.addfile(member)
                elif stat.S_ISLNK(mode):
                    member.type = tarfile.SYMTYPE
                    member.linkname = os.readlink(root / path)
                    record.update(kind="symlink", target=member.linkname)
                    tar.addfile(member)
                else:
                    total += size
                    if total > limits.max_bytes:
                        _fail("size_limit", "Workspace exceeds the byte limit")
                    member.size = size
                    with _open_file(root, path) as stream:
                        if _stamp(os.fstat(stream.fileno())) != stamp:
                            _fail("workspace_changed", "Workspace changed during capture")
                        reader = _DigestReader(stream)
                        tar.addfile(member, reader)
                        if _stamp(os.fstat(stream.fileno())) != stamp:
                            _fail("workspace_changed", "Workspace changed during capture")
                    record.update(kind="file", size=size, sha256=reader.digest.hexdigest())
                records.append(record)
            metadata = {
                "version": 1,
                "identity": asdict(identity),
                "workspace": str(root),
                "git": original,
                "files": records,
                "bundle_sha256": _file_digest(bundle),
                "patch_sha256": _file_digest(patch),
            }
            for path in (bundle, patch):
                member = tarfile.TarInfo(path.name)
                member.mode, member.size = 0o600, path.stat().st_size
                with path.open("rb") as stream:
                    tar.addfile(member, stream)
            body = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()
            member = tarfile.TarInfo("manifest.json")
            member.mode, member.size = 0o600, len(body)
            tar.addfile(member, io.BytesIO(body))
        if archive.stat().st_size > limits.max_bytes:
            _fail("size_limit", "Workspace archive exceeds the byte limit")
        if _scan(root, limits) != before or _git_state(root, limits) != original:
            _fail("workspace_changed", "Workspace or Git state changed during capture")
        with tarfile.open(archive, "r:") as tar:
            _validated_manifest(tar, identity, root, limits)
        digest = _file_digest(archive)
        size = archive.stat().st_size
        # A hard link publishes the completed file without replacing a racing
        # writer's destination. The temporary name is removed by its owned scope.
        archive.chmod(0o600)
        os.link(archive, destination)
        return WorkspaceArchive(digest, size, original["head"], original["branch"], len(records))


def _validated_manifest(
    tar: tarfile.TarFile, identity: CheckpointIdentity, root: Path, limits: WorkspaceLimits
) -> tuple[dict, dict[str, tarfile.TarInfo]]:
    members = {}
    for member in tar:
        name = member.name.rstrip("/") if member.isdir() else member.name
        if (
            name in members
            or len(members) >= limits.max_entries + len(_ADMIN)
            or member.size < 0
            or member.size > limits.max_bytes
            or member.mode < 0
            or member.mode > _PERMISSION_BITS
            or member.sparse is not None
            or set(member.pax_headers) - {"path", "linkpath"}
        ):
            _fail("invalid_archive", "Workspace archive has duplicate or unsupported entries")
        if member.name in _ADMIN:
            if not member.isfile():
                _fail("invalid_archive", "Workspace archive metadata is not a regular file")
        elif member.name.startswith("files/"):
            _path(
                member.name.removeprefix("files/").removesuffix("/")
                if member.isdir()
                else member.name.removeprefix("files/")
            )
            if member.type not in {tarfile.REGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE}:
                _fail("invalid_archive", "Workspace archive file type is unsupported")
        else:
            _fail("invalid_archive", "Workspace archive has an unknown entry")
        members[name] = member
    if not _ADMIN.issubset(members) or members["manifest.json"].size > 32 * 1024 * 1024:
        _fail("invalid_archive", "Workspace archive manifest is unavailable")
    stream = tar.extractfile(members["manifest.json"])
    if stream is None:
        _fail("invalid_archive", "Workspace archive manifest has no data")
    with stream:
        manifest = json.load(stream)
    if (
        not isinstance(manifest, dict)
        or set(manifest)
        != {"version", "identity", "workspace", "git", "files", "bundle_sha256", "patch_sha256"}
        or type(manifest["version"]) is not int
        or manifest["version"] != 1
        or manifest["identity"] != asdict(identity)
        or manifest["workspace"] != str(root)
        or not isinstance(manifest["files"], list)
        or len(manifest["files"]) > limits.max_entries
    ):
        _fail("invalid_archive", "Workspace checkpoint identity, path or version differs")
    state = manifest["git"]
    if (
        not isinstance(state, dict)
        or set(state) != {"head", "branch", "refs", "index_sha256", "exclude_b64"}
        or not isinstance(state["head"], str)
        or not _OID.fullmatch(state["head"])
        or (state["branch"] is not None and not isinstance(state["branch"], str))
        or not isinstance(state["refs"], dict)
        or not isinstance(state["index_sha256"], str)
        or not _SHA256.fullmatch(state["index_sha256"])
    ):
        _fail("invalid_archive", "Workspace Git metadata is invalid")
    exclude = state["exclude_b64"]
    if exclude is not None:
        if not isinstance(exclude, str) or len(exclude) > 4 * (_MAX_EXCLUDE_BYTES // 3 + 1):
            _fail("invalid_archive", "Workspace Git ignore data is invalid")
        if len(base64.b64decode(exclude, validate=True)) > _MAX_EXCLUDE_BYTES:
            _fail("invalid_archive", "Workspace Git ignore data exceeds its limit")
    paths = {}
    folded = set()
    for record in manifest["files"]:
        if not isinstance(record, dict):
            _fail("invalid_archive", "Workspace file manifest is invalid")
        path = str(_path(record.get("path")))
        if path.casefold() in folded:
            _fail("invalid_archive", "Workspace file paths collide")
        folded.add(path.casefold())
        kind = record.get("kind")
        fields = {"path", "mode", "kind"} | (
            {"sha256", "size"} if kind == "file" else {"target"} if kind == "symlink" else set()
        )
        member = members.get("files/" + path)
        if (
            set(record) != fields
            or kind not in {"file", "directory", "symlink"}
            or member is None
            or type(record["mode"]) is not int
            or member.mode != record["mode"]
            or member.type
            != {"file": tarfile.REGTYPE, "directory": tarfile.DIRTYPE, "symlink": tarfile.SYMTYPE}[
                kind
            ]
        ):
            _fail("invalid_archive", "Workspace file manifest disagrees with its archive")
        if kind == "file":
            if type(record["size"]) is not int or member.size != record["size"]:
                _fail("invalid_archive", "Workspace file size disagrees with its archive")
            _verify_member(tar, member, record["sha256"])
        elif kind == "symlink":
            if (
                not isinstance(record["target"], str)
                or not record["target"]
                or "\0" in record["target"]
                or len(record["target"].encode()) > _MAX_PATH_BYTES
                or member.linkname != record["target"]
                or member.size != 0
            ):
                _fail("invalid_archive", "Workspace symlink metadata is invalid")
        elif member.size != 0:
            _fail("invalid_archive", "Workspace directory contains data")
        paths[path] = kind
    if set(members) != _ADMIN | {"files/" + path for path in paths}:
        _fail("invalid_archive", "Workspace archive has unlisted files")
    for path in paths:
        for parent in PurePosixPath(path).parents:
            if str(parent) != "." and paths.get(str(parent)) != "directory":
                _fail(
                    "invalid_archive", "Workspace archive traverses a symlink or missing directory"
                )
    for name, key in (("git.bundle", "bundle_sha256"), ("index.patch", "patch_sha256")):
        _verify_member(tar, members[name], manifest[key])
    return manifest, members


def _verify_member(tar: tarfile.TarFile, member: tarfile.TarInfo, digest: str) -> None:
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        _fail("invalid_archive", "Workspace file checksum is invalid")
    stream = tar.extractfile(member)
    if stream is None:
        _fail("invalid_archive", "Workspace archive file has no data")
    with stream:
        actual = hashlib.sha256()
        while block := stream.read(_CHUNK):
            actual.update(block)
        if actual.hexdigest() != digest:
            _fail("checksum_mismatch", "Workspace file checksum did not match")


def restore_workspace(
    archive: Path,
    workspace: Path,
    identity: CheckpointIdentity,
    *,
    expected_sha256: str,
    limits: WorkspaceLimits = _DEFAULT_LIMITS,
) -> WorkspaceArchive:
    """Restore only into a nonexistent stable path; validate before publication."""
    try:
        return _restore_workspace(archive, workspace, identity, expected_sha256, limits)
    except WorkspaceCheckpointError:
        raise
    except (
        OSError,
        ValueError,
        TypeError,
        RecursionError,
        subprocess.SubprocessError,
        tarfile.TarError,
    ) as exc:
        raise WorkspaceCheckpointError(
            "restore_failed", "Workspace restoration failed; continuation cannot start"
        ) from exc


def _restore_workspace(
    archive: Path,
    workspace: Path,
    identity: CheckpointIdentity,
    expected_sha256: str,
    limits: WorkspaceLimits,
) -> WorkspaceArchive:
    root = workspace.absolute()
    if root.parent.resolve() != root.parent or os.path.lexists(root):
        _fail("destination_exists", "Workspace restore requires a new canonical destination")
    _repository_identity(identity)
    size = archive.stat().st_size
    if not 0 < size <= limits.max_bytes:
        _fail("size_limit", "Workspace archive exceeds the byte limit")
    if not isinstance(expected_sha256, str) or not _SHA256.fullmatch(expected_sha256):
        _fail("checksum_mismatch", "Workspace archive receipt checksum is invalid")
    # The only tree removed on error is this newly-created owned staging tree.
    # Never use extractall: paths/types/parents are validated, and links are leaves.
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with (
        os.fdopen(fd, "rb") as archive_stream,
        tempfile.TemporaryDirectory(prefix=".workspace-restore-", dir=root.parent) as scratch,
    ):
        archive_stamp = _stamp(os.fstat(archive_stream.fileno()))
        if not stat.S_ISREG(archive_stamp[0]) or archive_stamp[3] != size:
            _fail("invalid_archive", "Workspace archive is not a stable regular file")
        if hashlib.file_digest(archive_stream, "sha256").hexdigest() != expected_sha256:
            _fail("checksum_mismatch", "Workspace archive differs from its receipt")
        archive_stream.seek(0)
        staging = Path(scratch) / "tree"
        staging.mkdir(mode=0o700)
        with tarfile.open(fileobj=archive_stream, mode="r:") as tar:
            manifest, members = _validated_manifest(tar, identity, root, limits)
            for name in ("git.bundle", "index.patch"):
                source = tar.extractfile(members[name])
                if source is None:
                    _fail("invalid_archive", "Workspace Git archive has no data")
                with source, (Path(scratch) / name).open("xb") as output:
                    shutil.copyfileobj(source, output, _CHUNK)
            records = manifest["files"]
            for record in sorted(
                records, key=lambda record: len(PurePosixPath(record["path"]).parts)
            ):
                target = staging / record["path"]
                if record["kind"] == "directory":
                    target.mkdir(mode=0o700)
                elif record["kind"] == "symlink":
                    os.symlink(record["target"], target)
                else:
                    source = tar.extractfile(members["files/" + record["path"]])
                    if source is None:
                        _fail("invalid_archive", "Workspace archive file has no data")
                    with source, target.open("xb") as output:
                        shutil.copyfileobj(source, output, _CHUNK)
                    target.chmod(record["mode"])
        state = manifest["git"]
        _git(staging, ["init", "--template=", "--quiet"], limits)
        for ref, oid in state["refs"].items():
            if (
                not isinstance(ref, str)
                or not ref.startswith("refs/")
                or ref.startswith("refs/replace/")
                or not isinstance(oid, str)
                or not _OID.fullmatch(oid)
            ):
                _fail("invalid_archive", "Workspace saved Git ref is invalid")
            _git(staging, ["check-ref-format", ref], limits)
        bundle = str(Path(scratch) / "git.bundle")
        _git(staging, ["bundle", "verify", bundle], limits)
        advertised = _git(staging, ["bundle", "unbundle", bundle], limits)
        bundle_refs = dict(line.decode().split(" ", 1)[::-1] for line in advertised.splitlines())
        if bundle_refs != {**state["refs"], "HEAD": state["head"]}:
            _fail("invalid_archive", "Workspace Git bundle refs disagree with the manifest")
        ref_updates = Path(scratch) / "refs.txt"
        ref_updates.write_text(
            "".join(f"update {ref} {oid}\n" for ref, oid in state["refs"].items())
        )
        with ref_updates.open("rb") as source:
            _git(staging, ["update-ref", "--stdin"], limits, source=source)
        branch = state["branch"]
        if branch is None:
            _git(staging, ["update-ref", "--no-deref", "HEAD", state["head"]], limits)
        else:
            _git(staging, ["check-ref-format", "refs/heads/" + branch], limits)
            if state["refs"].get("refs/heads/" + branch) != state["head"]:
                _fail("invalid_archive", "Workspace branch disagrees with saved HEAD")
            _git(staging, ["symbolic-ref", "HEAD", "refs/heads/" + branch], limits)
        _git(staging, ["read-tree", "HEAD"], limits)
        patch = Path(scratch) / "index.patch"
        if patch.stat().st_size:
            _git(
                staging,
                ["apply", "--cached", "--binary", "--whitespace=nowarn", str(patch)],
                limits,
            )
        index = _git(staging, ["ls-files", "--stage", "-z"], limits)
        if hashlib.sha256(index).hexdigest() != state["index_sha256"]:
            _fail("invalid_archive", "Workspace staged state was not restored exactly")
        _git(
            staging, ["remote", "add", "origin", f"https://github.com/{identity.repo}.git"], limits
        )
        _git(staging, ["config", "--local", "credential.helper", "!gh auth git-credential"], limits)
        if state["exclude_b64"] is not None:
            ignore_file = staging / ".git/info/exclude"
            ignore_file.parent.mkdir(exist_ok=True)
            ignore_file.write_bytes(base64.b64decode(state["exclude_b64"], validate=True))
        for record in sorted(
            records, key=lambda record: len(PurePosixPath(record["path"]).parts), reverse=True
        ):
            if record["kind"] == "directory":
                (staging / record["path"]).chmod(record["mode"])
        if _stamp(os.fstat(archive_stream.fileno())) != archive_stamp:
            _fail("workspace_changed", "Workspace archive changed during restoration")
        # Reserve the final directory exclusively, then move the owned contents.
        # A partial move is rolled back; an existing destination is never cleared.
        root.mkdir(mode=0o700)
        try:
            for entry in staging.iterdir():
                os.rename(entry, root / entry.name)
        except BaseException:
            shutil.rmtree(root)
            raise
        return WorkspaceArchive(expected_sha256, size, state["head"], branch, len(records))
