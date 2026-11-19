#!/usr/bin/env python3
# MIT No Attribution
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# the Software without restriction, including without limitation the rights to
# use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
# the Software, and to permit persons to whom the Software is furnished to do so.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Package the Dockerfile's local inputs into a reproducible MicroVM build ZIP."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import stat
import zipfile


# Keep these in step with the local COPY sources in agent/Dockerfile. The
# packaging regression checks both directions; COPY --from uses remote stages.
INPUTS = (
    "agent/pyproject.toml",
    "agent/uv.lock",
    "agent/src",
    "agent/policies",
    "agent/workflows",
    "agent/prepare-commit-msg.sh",
    "agent/managed-settings.json",
    "contracts",
)
IGNORED_DIRS = {"__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "node_modules", ".git"}


def source_files(root: Path):
    """Yield only regular build inputs; never follow a link outside the tree."""
    def walk(path: Path):
        if path.is_symlink():
            raise ValueError(f"MicroVM build inputs must not contain symlinks: {path}")
        if path.is_dir():
            for child in sorted(path.iterdir()):
                if child.name in IGNORED_DIRS or child.name == ".DS_Store":
                    continue
                if child.suffix in {".pyc", ".pyo"}:
                    continue
                yield from walk(child)
        elif path.is_file():
            yield path
        else:
            raise ValueError(f"Missing or unsupported MicroVM build input: {path}")

    dockerfile = root / "agent/Dockerfile"
    if dockerfile.is_symlink() or not dockerfile.is_file():
        raise ValueError("agent/Dockerfile must be a regular file")
    yield "Dockerfile", dockerfile
    for name in INPUTS:
        for path in walk(root / name):
            yield path.relative_to(root).as_posix(), path


def build(root: Path, output: Path):
    files = sorted(source_files(root))
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, path in files:
            # File dates, checkout locations, uid/gid and umask must not cause
            # needless image versions. Preserve just the executable permission.
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with path.open("rb") as source, archive.open(info, "w") as target:
                shutil.copyfileobj(source, target)
    digest = hashlib.sha256()
    with output.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return {
        "sha256": digest.hexdigest(),
        "checksum_sha256": base64.b64encode(digest.digest()).decode("ascii"),
        "file_count": len(files),
        "size_bytes": output.stat().st_size,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.repo_root.resolve(), args.output.resolve())))


if __name__ == "__main__":
    main()
