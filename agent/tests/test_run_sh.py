"""``run.sh``, run with stand-ins for ``docker`` and ``aws`` first on PATH.

``run.sh`` is the documented way to try the agent container locally (developer
guide, README quick start), and nothing in the build executes it. Each test runs
the real script and reads what it asked ``docker`` to do. No image is built, no
container starts, and the AWS CLI of the machine is not called.
"""

import os
import subprocess
import sys
from pathlib import Path

_AGENT = Path(__file__).resolve().parents[1]

# Records the arguments of `docker build` and of `docker run`, one per line, and
# answers `docker image inspect` with a size. Any other call (`docker rm`) succeeds.
_DOCKER = """\
#!/usr/bin/env bash
case "$1" in
  build | run) printf '%s\\n' "$@" > "$CALLS/docker-$1" ;;
  image) echo 1048576 ;;
esac
"""

# AWS CLI v2: `configure export-credentials` prints the credentials of the profile.
_AWS_CLI_V2 = """\
#!/usr/bin/env bash
if [ "$1" = --version ]; then
  echo "aws-cli/2.31.37 Python/3.13.9 Darwin/25.6.0 exe/arm64"
elif [ "$*" = "configure export-credentials --format process" ]; then
  echo '{"Version": 1, "AccessKeyId": "key-from-cli", "SecretAccessKey": "secret-from-cli"}'
else
  exit 2
fi
"""

# AWS CLI v1 has no `configure export-credentials`: it prints its usage and exits 2.
_AWS_CLI_V1 = """\
#!/usr/bin/env bash
if [ "$1" = --version ]; then
  echo "aws-cli/1.45.26 Python/3.12.2 Darwin/25.6.0 botocore/1.43.26"
else
  echo "aws: error: argument subcommand: Invalid choice, valid choices are:" >&2
  exit 2
fi
"""


def _run_sh(tmp_path, aws=_AWS_CLI_V2, **env) -> subprocess.CompletedProcess[str]:
    """Run ``run.sh owner/repo 42`` for a user who has a ``~/.aws`` and no keys exported."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, script in (("docker", _DOCKER), ("aws", aws)):
        (bin_dir / name).write_text(script, encoding="utf-8")
        (bin_dir / name).chmod(0o755)
    (tmp_path / "home" / ".aws").mkdir(parents=True)
    # run.sh reads the CLI's answer with `python3`: the interpreter of this test run.
    path = [str(bin_dir), str(Path(sys.executable).parent), os.environ["PATH"]]
    return subprocess.run(
        ["bash", str(_AGENT / "run.sh"), "owner/repo", "42"],
        env={
            "PATH": os.pathsep.join(path),
            "HOME": str(tmp_path / "home"),
            "CALLS": str(tmp_path),
            "GITHUB_TOKEN": "test-token",
            "AWS_REGION": "us-east-1",
            **env,
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


def _docker(tmp_path, command) -> list[str]:
    """The arguments ``run.sh`` gave to ``docker build`` or to ``docker run``."""
    return (tmp_path / f"docker-{command}").read_text(encoding="utf-8").splitlines()


def _copied_from_context(dockerfile: Path) -> list[str]:
    """Every path a ``COPY`` of the Dockerfile reads from the build context."""
    sources = []
    for line in dockerfile.read_text(encoding="utf-8").splitlines():
        words = line.split()
        if words[:1] == ["COPY"] and not any(word.startswith("--from") for word in words):
            sources += [word for word in words[1:-1] if not word.startswith("--")]
    return sources


def test_build_context_holds_every_path_the_dockerfile_copies(tmp_path):
    run = _run_sh(tmp_path)
    assert run.returncode == 0, run.stderr

    build = _docker(tmp_path, "build")
    context = Path(build[-1])
    dockerfile = Path(build[build.index("-f") + 1]) if "-f" in build else context / "Dockerfile"
    assert dockerfile.resolve() == _AGENT / "Dockerfile"
    copied = _copied_from_context(dockerfile)
    assert copied, "found no COPY from the build context in agent/Dockerfile"
    missing = [path for path in copied if not (context / path).exists()]
    assert not missing, (
        f"run.sh builds agent/Dockerfile with {context} as the build context, and the "
        f"Dockerfile copies paths that do not exist there: {missing}"
    )


def test_auxiliary_model_the_caller_set_reaches_the_container(tmp_path):
    run = _run_sh(tmp_path, ANTHROPIC_DEFAULT_HAIKU_MODEL="us.anthropic.claude-haiku-5-5")
    assert run.returncode == 0, run.stderr

    assert "ANTHROPIC_DEFAULT_HAIKU_MODEL=us.anthropic.claude-haiku-5-5" in _docker(tmp_path, "run")


def test_aws_cli_v2_credentials_reach_the_container(tmp_path):
    run = _run_sh(tmp_path)
    assert run.returncode == 0, run.stderr

    container = _docker(tmp_path, "run")
    assert "AWS_ACCESS_KEY_ID=key-from-cli" in container
    assert "AWS_SECRET_ACCESS_KEY=secret-from-cli" in container


def test_aws_cli_v1_falls_through_to_the_mount_of_the_aws_directory(tmp_path):
    run = _run_sh(tmp_path, aws=_AWS_CLI_V1)
    assert run.returncode == 0, run.stderr

    assert f"{tmp_path}/home/.aws:/home/agent/.aws:ro" in _docker(tmp_path, "run")
