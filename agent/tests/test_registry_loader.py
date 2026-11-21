"""Unit tests for registry.loader — merging resolved mcp_server assets (#246)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

from post_hooks import ensure_committed
from registry.loader import (
    RegistryAssetLoadError,
    apply_mcp_assets,
    apply_resolved_assets,
    build_skill_prompt_fragment,
)


@pytest.fixture(autouse=True)
def _repository(tmp_path):
    """``tmp_path`` is a git repository, as the clone of a task is: the loader
    raises where git cannot be shown to leave the written file out of commits."""
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)


def _read_mcp(repo_dir) -> dict:
    with open(repo_dir / ".mcp.json", encoding="utf-8") as f:
        return json.load(f)


def _mcp_asset(namespace: str, name: str, version: str, runtime: dict) -> dict:
    return {
        "kind": "mcp_server",
        "namespace": namespace,
        "name": name,
        "version": version,
        "runtime": runtime,
    }


# What the loader's error says a list field and an object field must be.
_STRING_LIST = "a list of strings"
_STRING_MAP = "an object with string values"


class TestApplyMcpAssets:
    def test_writes_new_mcp_json(self, tmp_path):
        runtime = {"transport": "http", "url": "https://mcp.example.com/sse"}
        asset = _mcp_asset("acme", "pdf-tools", "1.0.0", runtime)
        written = apply_mcp_assets(str(tmp_path), [asset])
        assert written == ["acme__pdf-tools"]
        merged = _read_mcp(tmp_path)
        # Hyphens are preserved (injective key) — not normalized to underscores.
        # `transport` is normalized to the SDK's `type` discriminant key (#246).
        assert merged["mcpServers"]["acme__pdf-tools"] == {
            "type": "http",
            "url": "https://mcp.example.com/sse",
        }

    def test_normalizes_transport_to_type(self, tmp_path):
        # A publisher following the documented `transport` contract must produce
        # a `.mcp.json` entry the SDK recognizes (discriminant key `type`), with
        # no leftover `transport` key and all other fields preserved.
        runtime = {
            "transport": "sse",
            "url": "https://x/sse",
            "headers": {"Authorization": "Bearer t"},
            "tool_prefix": "mcp__x__",
        }
        apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", runtime)])
        entry = _read_mcp(tmp_path)["mcpServers"]["acme__x"]
        assert entry["type"] == "sse"
        assert "transport" not in entry
        assert entry["url"] == "https://x/sse"
        assert entry["headers"] == {"Authorization": "Bearer t"}
        assert entry["tool_prefix"] == "mcp__x__"

    def test_preserves_existing_servers(self, tmp_path):
        existing = {"mcpServers": {"other": {"command": "/usr/bin/x"}}}
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))
        written = apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("acme", "weather", "2.1.0", {"transport": "sse", "url": "https://w"})],
        )
        assert written == ["acme__weather"]
        merged = _read_mcp(tmp_path)
        assert merged["mcpServers"]["other"]["command"] == "/usr/bin/x"
        assert "acme__weather" in merged["mcpServers"]

    def test_preserves_servers_of_a_file_with_a_byte_order_mark(self, tmp_path):
        # "UTF-8 with BOM" is a file the Claude CLI reads, not a malformed one: the
        # registry server joins the repository's servers instead of replacing them.
        existing = {"mcpServers": {"other": {"command": "/usr/bin/x"}}}
        (tmp_path / ".mcp.json").write_bytes(b"\xef\xbb\xbf" + json.dumps(existing).encode())
        apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("acme", "weather", "2.1.0", {"transport": "sse", "url": "https://w"})],
        )
        assert set(_read_mcp(tmp_path)["mcpServers"]) == {"other", "acme__weather"}

    def test_merges_multiple_servers(self, tmp_path):
        assets = [
            _mcp_asset("acme", "a", "1.0.0", {"transport": "http", "url": "https://a"}),
            _mcp_asset("acme", "b", "1.0.0", {"transport": "http", "url": "https://b"}),
        ]
        written = apply_mcp_assets(str(tmp_path), assets)
        assert set(written) == {"acme__a", "acme__b"}
        merged = _read_mcp(tmp_path)
        assert set(merged["mcpServers"]) == {"acme__a", "acme__b"}

    def test_hyphen_and_underscore_names_do_not_collide(self, tmp_path):
        # foo-bar and foo_bar are distinct assets; the key must not collapse them
        # to one entry (last-write-wins would drop a resolved server) (#246).
        assets = [
            _mcp_asset("acme", "foo-bar", "1.0.0", {"transport": "http", "url": "https://dash"}),
            _mcp_asset(
                "acme", "foo_bar", "1.0.0", {"transport": "http", "url": "https://underscore"}
            ),
        ]
        written = apply_mcp_assets(str(tmp_path), assets)
        assert set(written) == {"acme__foo-bar", "acme__foo_bar"}
        merged = _read_mcp(tmp_path)
        assert set(merged["mcpServers"]) == {"acme__foo-bar", "acme__foo_bar"}
        assert merged["mcpServers"]["acme__foo-bar"]["url"] == "https://dash"
        assert merged["mcpServers"]["acme__foo_bar"]["url"] == "https://underscore"

    def test_two_pins_of_one_asset_that_resolved_differently_raise(self, tmp_path):
        # A Blueprint that pins acme/pdf at ^1.0.0 and at ^2.0.0 gets both versions
        # resolved and stamped on the task. They share one .mcp.json key, so only
        # one could be loaded: fail closed, like every other pinned-but-unloaded case.
        assets = [
            _mcp_asset("acme", "pdf", "1.9.0", {"transport": "http", "url": "https://v1"}),
            _mcp_asset("acme", "pdf", "2.1.0", {"transport": "http", "url": "https://v2"}),
        ]
        with pytest.raises(RegistryAssetLoadError, match=r"acme__pdf: pinned more than once"):
            apply_mcp_assets(str(tmp_path), assets)
        assert not (tmp_path / ".mcp.json").exists()

    def test_two_pins_of_one_asset_that_resolved_alike_load_once(self, tmp_path):
        # ^1.0.0 and ~1.9.0 both resolve to 1.9.0: the same server, nothing is lost.
        asset = _mcp_asset("acme", "pdf", "1.9.0", {"transport": "http", "url": "https://v1"})
        written = apply_mcp_assets(str(tmp_path), [asset, dict(asset)])
        assert set(written) == {"acme__pdf"}
        assert _read_mcp(tmp_path)["mcpServers"] == {
            "acme__pdf": {"type": "http", "url": "https://v1"}
        }

    def test_repository_server_under_the_same_key_is_still_replaced(self, tmp_path):
        # Only pins of this bundle are compared with each other: an entry the
        # repository's own .mcp.json holds under the key is overlaid, as before.
        existing = {"mcpServers": {"acme__pdf": {"type": "http", "url": "https://old"}}}
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))
        asset = _mcp_asset("acme", "pdf", "1.9.0", {"transport": "http", "url": "https://v1"})
        apply_mcp_assets(str(tmp_path), [asset])
        assert _read_mcp(tmp_path)["mcpServers"]["acme__pdf"]["url"] == "https://v1"

    def test_ignores_non_mcp_kinds(self, tmp_path):
        assets = [
            {
                "kind": "cedar_policy_module",
                "namespace": "acme",
                "name": "p",
                "version": "1.0.0",
                "runtime": {"cedar_text": "permit(...);"},
            },
        ]
        written = apply_mcp_assets(str(tmp_path), assets)
        assert written == []
        assert not (tmp_path / ".mcp.json").exists()

    def test_empty_runtime_raises(self, tmp_path):
        # Fail-closed (#246 review): a pinned asset with no runtime cannot be
        # honored; skipping it would make the stamped audit bundle lie.
        with pytest.raises(RegistryAssetLoadError, match="empty runtime payload"):
            apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {})])
        assert not (tmp_path / ".mcp.json").exists()

    def test_http_without_url_raises(self, tmp_path):
        with pytest.raises(RegistryAssetLoadError, match="missing 'url'"):
            apply_mcp_assets(
                str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {"transport": "http"})]
            )

    def test_stdio_without_command_raises(self, tmp_path):
        with pytest.raises(RegistryAssetLoadError, match="missing 'command'"):
            apply_mcp_assets(
                str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {"transport": "stdio"})]
            )

    def test_unknown_transport_raises(self, tmp_path):
        with pytest.raises(RegistryAssetLoadError, match="unknown mcp_server transport"):
            apply_mcp_assets(
                str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {"transport": "grpc", "url": "u"})]
            )

    def test_stdio_with_command_loads(self, tmp_path):
        written = apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("acme", "x", "1.0.0", {"transport": "stdio", "command": "run-me"})],
        )
        assert written == ["acme__x"]
        assert _read_mcp(tmp_path)["mcpServers"]["acme__x"] == {
            "type": "stdio",
            "command": "run-me",
        }

    @pytest.mark.parametrize(
        ("transport", "field", "value", "shape"),
        [
            pytest.param("http", "headers", {"X-Shard": 3}, _STRING_MAP, id="headers-number"),
            pytest.param("sse", "headers", {"X-Shard": 3}, _STRING_MAP, id="sse-headers-number"),
            pytest.param("http", "headers", ["X-Shard: 3"], _STRING_MAP, id="headers-list"),
            pytest.param(
                "http",
                "headers",
                {"Authorization": "Bearer t", "X-Shard": 3},
                _STRING_MAP,
                id="headers-one-of-two-a-number",
            ),
            pytest.param("http", "headers", None, _STRING_MAP, id="headers-null"),
            pytest.param("stdio", "args", [1, "x"], _STRING_LIST, id="args-number"),
            pytest.param("stdio", "args", "x", _STRING_LIST, id="args-string"),
            pytest.param("stdio", "args", None, _STRING_LIST, id="args-null"),
            pytest.param("stdio", "env", {"PORT": 8080}, _STRING_MAP, id="env-number"),
            pytest.param("stdio", "env", ["PORT=8080"], _STRING_MAP, id="env-list"),
            pytest.param("stdio", "command", ["node", "server.js"], "a string", id="command-list"),
            pytest.param("http", "url", ["https://x"], "a string", id="url-list"),
        ],
    )
    def test_field_of_a_shape_the_cli_refuses_raises(
        self, tmp_path, transport, field, value, shape
    ):
        # The Claude Code CLI validates each .mcp.json entry: url and command are
        # strings, args is a list of strings, headers and env are objects with string
        # values. It skips an entry that differs and starts the session all the same,
        # so the task would run without the pinned server.
        base = {"command": "run-me"} if transport == "stdio" else {"url": "https://x"}
        asset = _mcp_asset("acme", "x", "1.0.0", {"transport": transport, **base, field: value})
        with pytest.raises(RegistryAssetLoadError) as raised:
            apply_mcp_assets(str(tmp_path), [asset])
        # The error names the asset, the field and what the field has to be.
        assert str(raised.value) == (
            f"acme__x: {transport} mcp_server runtime '{field}' must be {shape}"
        )
        assert not (tmp_path / ".mcp.json").exists()

    def test_string_headers_args_and_env_load(self, tmp_path):
        http = {"transport": "http", "url": "https://x", "headers": {"Authorization": "Bearer t"}}
        stdio = {
            "transport": "stdio",
            "command": "run-me",
            "args": ["--port", "8080"],
            "env": {"MODE": "fast"},
        }
        written = apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("acme", "web", "1.0.0", http), _mcp_asset("acme", "cli", "1.0.0", stdio)],
        )
        assert written == ["acme__web", "acme__cli"]
        assert _read_mcp(tmp_path)["mcpServers"] == {
            "acme__web": {
                "type": "http",
                "url": "https://x",
                "headers": {"Authorization": "Bearer t"},
            },
            "acme__cli": {
                "type": "stdio",
                "command": "run-me",
                "args": ["--port", "8080"],
                "env": {"MODE": "fast"},
            },
        }

    @pytest.mark.parametrize(
        "runtime",
        [
            pytest.param({"transport": "http", "url": "https://x", "args": "x"}, id="http-args"),
            pytest.param(
                {"transport": "stdio", "command": "run-me", "headers": {"X-Shard": 3}},
                id="stdio-headers",
            ),
        ],
    )
    def test_field_the_transport_does_not_use_is_not_checked(self, tmp_path, runtime):
        # The CLI reads args and env only for stdio, headers only for http and sse,
        # and drops the keys it does not read: this server is in the session.
        written = apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", runtime)])
        assert written == ["acme__x"]

    def test_empty_headers_args_and_env_load(self, tmp_path):
        # The CLI accepts an empty list and an empty object, and an empty string in them.
        http = {"transport": "http", "url": "https://x", "headers": {}}
        stdio = {"transport": "stdio", "command": "run-me", "args": [""], "env": {"MODE": ""}}
        bare = {"transport": "stdio", "command": "run-me", "args": [], "env": {}}
        assets = [
            _mcp_asset("acme", name, "1.0.0", runtime)
            for name, runtime in (("web", http), ("cli", stdio), ("bare", bare))
        ]
        assert apply_mcp_assets(str(tmp_path), assets) == ["acme__web", "acme__cli", "acme__bare"]

    def test_runtime_with_type_in_place_of_transport_is_checked_too(self, tmp_path):
        runtime = {"type": "http", "url": "https://x", "headers": {"X-Shard": 3}}
        with pytest.raises(RegistryAssetLoadError, match="'headers' must be"):
            apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", runtime)])

    def test_missing_repo_dir_raises(self):
        # Infrastructure failure (#246 Option C): the asset resolved but there's
        # nowhere to write it — fail-closed so the audit can't claim it loaded.
        asset = _mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})
        with pytest.raises(RegistryAssetLoadError, match="repo_dir missing"):
            apply_mcp_assets("/nonexistent/dir", [asset])

    def test_write_error_raises(self, tmp_path, monkeypatch):
        # Infrastructure failure: .mcp.json write fails → fail-closed.
        asset = _mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})

        def _boom(*_a, **_k):
            raise OSError("disk full")

        monkeypatch.setattr("builtins.open", _boom)
        with pytest.raises(RegistryAssetLoadError, match="failed to write"):
            apply_mcp_assets(str(tmp_path), [asset])

    def test_malformed_existing_treated_as_absent(self, tmp_path):
        # Degraded-but-safe: a corrupt existing .mcp.json is replaced, not fatal.
        (tmp_path / ".mcp.json").write_text("{ not valid json")
        runtime = {"transport": "http", "url": "https://x"}
        written = apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", runtime)])
        assert written == ["acme__x"]
        # Written in SDK shape (transport → type).
        assert _read_mcp(tmp_path)["mcpServers"]["acme__x"] == {"type": "http", "url": "https://x"}


def _skill_asset(namespace: str, name: str, runtime: dict) -> dict:
    return {
        "kind": "skill",
        "namespace": namespace,
        "name": name,
        "version": "1.0.0",
        "runtime": runtime,
    }


class TestBuildSkillPromptFragment:
    def test_empty_when_no_skills(self):
        assert build_skill_prompt_fragment([]) == ""
        mcp = _mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})
        assert build_skill_prompt_fragment([mcp]) == ""

    def test_appends_fragment_with_heading(self):
        out = build_skill_prompt_fragment(
            [_skill_asset("acme", "research", {"prompt_fragment": "Summarize findings."})]
        )
        assert "## Skills" in out
        assert "### Skill: acme/research" in out
        assert "Summarize findings." in out

    def test_includes_tool_hints(self):
        runtime = {"prompt_fragment": "Do X.", "tool_hints": ["Bash", "Edit"]}
        out = build_skill_prompt_fragment([_skill_asset("acme", "r", runtime)])
        assert "Bash, Edit" in out

    def test_concatenates_multiple_in_order(self):
        out = build_skill_prompt_fragment(
            [
                _skill_asset("acme", "a", {"prompt_fragment": "First."}),
                _skill_asset("acme", "b", {"prompt_fragment": "Second."}),
            ]
        )
        assert out.index("First.") < out.index("Second.")

    def test_blank_fragment_raises(self):
        # Fail-closed (#246 review): a pinned skill whose fragment is missing/blank
        # would otherwise be silently dropped while stamped as loaded.
        blank = _skill_asset("acme", "a", {"prompt_fragment": "   "})
        with pytest.raises(RegistryAssetLoadError, match="no usable 'prompt_fragment'"):
            build_skill_prompt_fragment([blank])

    def test_missing_runtime_raises(self):
        with pytest.raises(RegistryAssetLoadError, match="no usable 'prompt_fragment'"):
            build_skill_prompt_fragment([_skill_asset("acme", "a", {})])


class TestApplyResolvedAssets:
    def test_empty_is_noop(self, tmp_path):
        apply_resolved_assets(str(tmp_path), [])
        assert not (tmp_path / ".mcp.json").exists()

    def test_dispatches_mcp(self, tmp_path):
        written = apply_resolved_assets(
            str(tmp_path),
            [_mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "https://x"})],
        )
        assert written == ["acme__x"]
        assert (tmp_path / ".mcp.json").exists()

    def test_propagates_infra_failure(self, tmp_path):
        # Fail-closed (#246 Option C): an mcp_server that resolved but can't be
        # written must raise so the pipeline fails the task.
        with pytest.raises(RegistryAssetLoadError):
            apply_resolved_assets(
                "/nonexistent/dir",
                [_mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})],
            )

    def test_skill_and_cedar_do_not_touch_mcp_json(self, tmp_path):
        # apply_resolved_assets only handles on-disk kinds (mcp_server). Skills
        # and cedar modules are applied elsewhere, so no .mcp.json is written.
        apply_resolved_assets(str(tmp_path), [_skill_asset("acme", "r", {"prompt_fragment": "X."})])
        assert not (tmp_path / ".mcp.json").exists()


class TestAdr016LinearReStrip:
    """A registry-published Linear MCP server merged into .mcp.json must be
    scrubbed by strip_linear_mcp_servers (ADR-016), which the pipeline now runs
    AFTER the registry merge. Guards the bypass where a registry asset could
    re-introduce Linear tools under bypassPermissions (#246 review)."""

    def test_registry_linear_server_is_stripped_after_merge(self, tmp_path):
        from channel_mcp import strip_linear_mcp_servers

        # A registry asset that (maliciously or accidentally) provides Linear.
        apply_resolved_assets(
            str(tmp_path),
            [
                _mcp_asset(
                    "evil",
                    "linear",
                    "1.0.0",
                    {"transport": "http", "url": "https://mcp.linear.app/sse"},
                ),
                _mcp_asset("acme", "pdf", "1.0.0", {"transport": "http", "url": "https://pdf"}),
            ],
        )
        # The pipeline runs this immediately after the merge.
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1
        servers = _read_mcp(tmp_path)["mcpServers"]
        assert "evil__linear" not in servers  # Linear scrubbed
        assert "acme__pdf" in servers  # benign server survives


class TestMcpJsonNotCommittable:
    """A written .mcp.json carries the resolved runtime, which may hold secrets
    (bearer headers, url tokens, --api-key args). It lives in the live git clone,
    so the post-hook `git add -u` → commit → push must NOT be able to exfiltrate
    it to the PR. apply_mcp_assets blocks that (#246 B4): skip-worktree when the
    repository tracks the file, the clone's exclude file when it does not."""

    @staticmethod
    def _git(repo, *args) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def _init_repo(self, tmp_path):
        self._git(tmp_path, "init", "-q")
        self._git(tmp_path, "config", "user.email", "t@t")
        self._git(tmp_path, "config", "user.name", "t")
        (tmp_path / "README.md").write_text("x")
        self._git(tmp_path, "add", "README.md")
        self._git(tmp_path, "commit", "-qm", "init")

    def _secret_asset(self):
        return _mcp_asset(
            "acme",
            "secretful",
            "1.0.0",
            {
                "transport": "http",
                "url": "https://mcp.example/sse?token=SUPERSECRET",
                "headers": {"Authorization": "Bearer sk-live-abc123"},
            },
        )

    def test_untracked_mcp_json_cannot_be_staged(self, tmp_path):
        self._init_repo(tmp_path)
        apply_mcp_assets(str(tmp_path), [self._secret_asset()])
        # The file exists on disk (the SDK still reads it)...
        assert (tmp_path / ".mcp.json").exists()
        # ...but the safety-net `git add -u` (and even an explicit add) cannot stage it.
        self._git(tmp_path, "add", "-u")
        self._git(tmp_path, "add", ".mcp.json")
        staged = self._git(tmp_path, "diff", "--cached")
        assert "SUPERSECRET" not in staged.stdout
        assert "sk-live-abc123" not in staged.stdout

    def test_tracked_mcp_json_change_cannot_be_staged(self, tmp_path):
        # The dangerous case Scott reproduced: the repo already tracks .mcp.json.
        self._init_repo(tmp_path)
        (tmp_path / ".mcp.json").write_text('{"mcpServers":{}}\n')
        self._git(tmp_path, "add", ".mcp.json")
        self._git(tmp_path, "commit", "-qm", "track mcp")
        apply_mcp_assets(str(tmp_path), [self._secret_asset()])
        # git add -u stages tracked-but-modified files — must skip .mcp.json now.
        self._git(tmp_path, "add", "-u")
        staged = self._git(tmp_path, "diff", "--cached")
        assert staged.stdout.strip() == ""
        assert "SUPERSECRET" not in staged.stdout


class _GitClone:
    """git commands against a real repository under ``tmp_path``."""

    @staticmethod
    def _git(repo, *args, check=True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
        )
        if check:  # a step that failed must not read as "nothing was staged"
            assert result.returncode == 0, f"git {' '.join(args)}: {result.stderr.strip()}"
        return result

    @pytest.fixture(autouse=True)
    def _git_environment(self, tmp_path, monkeypatch):
        # No ignore file of the host (it may list .mcp.json), and an identity for
        # the commits, also for the one post_hooks makes.
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
        for role in ("AUTHOR", "COMMITTER"):
            monkeypatch.setenv(f"GIT_{role}_NAME", "t")
            monkeypatch.setenv(f"GIT_{role}_EMAIL", "t@t")


class TestMcpJsonGuardKeepsGitUsable(_GitClone):
    """Keeping .mcp.json out of commits must not cost the agent its git commands.

    Five kinds of repository, each with the registry server written into its
    ``.mcp.json`` by ``apply_mcp_assets``:

    * ``untracked``: the repository has no ``.mcp.json`` (the usual case). The
      guard was an intent-to-add index entry carrying the skip-worktree bit. To
      git that entry is an uncommitted change: ``git stash``, ``git rebase``,
      ``git cherry-pick``, a merge that is not a fast-forward and ``git reset
      --hard`` refused to run in the clone. The file is now listed in the
      clone's own exclude file, as the attachments directory is, and nothing is
      put in the index.
    * ``tracked``: the repository commits a ``.mcp.json``. Skip-worktree on the
      existing entry, as before.
    * ``re-included``: the repository's own ``.gitignore`` re-includes the file,
      which outranks the exclude file, so the index entry stays there.
    * ``unterminated-exclude``: as ``untracked``, but the last line of the clone's
      exclude file has no final newline. The entry starts on a line of its own,
      so that line and the entry both stay patterns.
    * ``read-only-exclude``: as ``untracked``, but the exclude file cannot be
      appended to. The file is not ignored then, so the index entry stays there
      as well.

    No test commits while that index entry is in place: where a kind has it, the
    change is staged and the staged files are read.
    """

    def _commit(self, repo, name: str, content: str) -> None:
        (repo / name).write_text(content)
        self._git(repo, "add", "--", name)
        self._git(repo, "commit", "-qm", f"add {name}")

    def _staged(self, repo) -> list[str]:
        return self._git(repo, "diff", "--cached", "--name-only").stdout.split()

    def _committed(self, repo) -> list[str]:
        """The files of the last commit; nothing of the session's server in any commit."""
        assert "SUPERSECRET" not in self._git(repo, "log", "-p", "--all").stdout
        return self._git(repo, "show", "--name-only", "--format=", "HEAD").stdout.split()

    def _clone(self, tmp_path, kind: str):
        """A clone of the given kind on a task branch one commit ahead of a ``main``
        that has moved on, after the registry server was written into it."""
        repo = tmp_path / "repo"
        repo.mkdir()
        self._git(repo, "init", "-q", "-b", "main")
        (repo / "code.txt").write_text("one\n")
        files = ["code.txt"]
        if kind == "tracked":
            (repo / ".mcp.json").write_text('{"mcpServers": {"docs": {"command": "docs-mcp"}}}\n')
            files.append(".mcp.json")
        if kind == "re-included":
            (repo / ".gitignore").write_text("!.mcp.json\n")
            files.append(".gitignore")
        self._git(repo, "add", "--", *files)
        self._git(repo, "commit", "-qm", "init")
        self._git(repo, "checkout", "-q", "-b", "task")
        self._commit(repo, "feature.txt", "feature\n")
        self._git(repo, "checkout", "-q", "main")
        self._commit(repo, "other.txt", "more\n")
        self._git(repo, "checkout", "-q", "task")
        exclude = repo / ".git" / "info" / "exclude"
        if kind == "unterminated-exclude":
            exclude.write_text("*.swp")
        if kind == "read-only-exclude":
            exclude.chmod(0o444)
        runtime = {"transport": "http", "url": "https://mcp.example/sse?token=SUPERSECRET"}
        apply_mcp_assets(str(repo), [_mcp_asset("acme", "secretful", "1.0.0", runtime)])
        return repo

    def test_untracked_file_gets_no_index_entry(self, tmp_path):
        repo = self._clone(tmp_path, "untracked")
        assert self._git(repo, "ls-files", "--", ".mcp.json").stdout == ""
        assert self._git(repo, "status", "--porcelain").stdout == ""

    @pytest.mark.parametrize(
        ("kind", "mechanism"),
        [
            pytest.param("untracked", ".git/info/exclude", id="untracked"),
            pytest.param("tracked", "skip-worktree", id="tracked"),
            pytest.param("re-included", "skip-worktree", id="re-included"),
        ],
    )
    def test_task_log_names_the_file_as_platform_managed(self, tmp_path, capfd, kind, mechanism):
        # The agent's own edit of the file stays out of its commits as well, and git
        # names another cause when it refuses to stage it (#760): a .gitignore file, or
        # a sparse-checkout definition. The task log is where the real one is on record.
        repo = self._clone(tmp_path, kind)
        lines = [ln for ln in capfd.readouterr().out.splitlines() if "platform-managed" in ln]
        assert len(lines) == 1
        assert " TASK Registry: " in lines[0]
        assert f"{repo / '.mcp.json'} is platform-managed for this task" in lines[0]
        assert mechanism in lines[0]

    def test_exclude_file_without_a_final_newline_keeps_its_last_pattern(self, tmp_path):
        # Appended directly behind "*.swp", the entry would make that line
        # "*.swp/.mcp.json": neither the clone's pattern nor the entry would match.
        repo = self._clone(tmp_path, "unterminated-exclude")
        assert self._git(repo, "ls-files", "--", ".mcp.json").stdout == ""
        assert self._git(repo, "check-ignore", "-q", "x.swp", check=False).returncode == 0
        assert self._git(repo, "check-ignore", "-q", ".mcp.json", check=False).returncode == 0

    @pytest.mark.skipif(os.geteuid() == 0, reason="root can append to a file of mode 0444")
    def test_exclude_file_that_cannot_be_written_leaves_the_file_protected(self, tmp_path):
        # Staged, not committed: this kind of clone ends on the index entry.
        repo = self._clone(tmp_path, "read-only-exclude")
        assert self._git(repo, "add", ".mcp.json", check=False).returncode != 0
        (repo / "code.txt").write_text("the agent's change\n")
        self._git(repo, "add", "-A")
        # code.txt is the control: it is staged, so the command did its work.
        assert self._staged(repo) == ["code.txt"]

    @pytest.mark.parametrize("kind", ["untracked", "tracked", "re-included"])
    def test_refused_add_of_the_file_comes_without_git_advice(self, tmp_path, monkeypatch, kind):
        # git refuses an add that names the file, ignored or flagged, and prints
        # advice with the refusal. The refusal stays; the advice is off in the clone.
        monkeypatch.setenv("LC_ALL", "C")  # git's own language: its advice lines begin "hint:"
        repo = self._clone(tmp_path, kind)
        refused = self._git(repo, "add", ".mcp.json", check=False)
        assert refused.returncode != 0
        assert "hint:" not in refused.stderr

    @pytest.mark.parametrize("kind", ["untracked", "tracked"])
    @pytest.mark.parametrize(
        ("dirty", "command"),
        [
            pytest.param(True, ["stash"], id="stash"),
            pytest.param(True, ["stash", "-u"], id="stash-u"),
            pytest.param(True, ["reset", "--hard"], id="reset-hard"),
            pytest.param(False, ["rebase", "main"], id="rebase"),
            pytest.param(False, ["pull", "--rebase", ".", "main"], id="pull-rebase"),
            pytest.param(False, ["merge", "--no-edit", "main"], id="merge"),
            pytest.param(False, ["cherry-pick", "main"], id="cherry-pick"),
        ],
    )
    def test_git_command_works_in_the_clone(self, tmp_path, kind, dirty, command):
        repo = self._clone(tmp_path, kind)
        if dirty:
            (repo / "code.txt").write_text("work in progress\n")
        self._git(repo, *command)
        # The command left the session's file alone.
        assert "acme__secretful" in _read_mcp(repo)["mcpServers"]

    @pytest.mark.parametrize("kind", ["untracked", "tracked"])
    @pytest.mark.parametrize(
        "commands",
        [
            pytest.param([["add", "-A"], ["commit", "-qm", "agent"]], id="add-A"),
            pytest.param([["add", "."], ["commit", "-qm", "agent"]], id="add-dot"),
            pytest.param([["add", "-u"], ["commit", "-qm", "agent"]], id="add-u"),
            pytest.param([["commit", "-qam", "agent"]], id="commit-am"),
        ],
    )
    def test_commit_of_the_agent_leaves_the_file_out(self, tmp_path, kind, commands):
        repo = self._clone(tmp_path, kind)
        (repo / "code.txt").write_text("the agent's change\n")
        for command in commands:
            self._git(repo, *command)
        # code.txt is the control: it is committed, so the commands did their work.
        assert self._committed(repo) == ["code.txt"]

    @pytest.mark.parametrize(
        "command",
        [
            pytest.param(["add", "-A"], id="add-A"),
            pytest.param(["add", "."], id="add-dot"),
            pytest.param(["add", "-u"], id="add-u"),
        ],
    )
    def test_staging_leaves_the_file_out_where_gitignore_re_includes_it(self, tmp_path, command):
        # Staged, not committed: this kind of clone keeps the index entry of the fallback, and
        # what is staged is what the guard decides.
        repo = self._clone(tmp_path, "re-included")
        (repo / "code.txt").write_text("the agent's change\n")
        self._git(repo, *command)
        # code.txt is the control: it is staged, so the command did its work.
        assert self._staged(repo) == ["code.txt"]

    @pytest.mark.parametrize("kind", ["untracked", "tracked", "re-included"])
    def test_naming_the_file_does_not_stage_it(self, tmp_path, kind):
        repo = self._clone(tmp_path, kind)
        assert self._git(repo, "add", ".mcp.json", check=False).returncode != 0
        assert self._staged(repo) == []

    @pytest.mark.parametrize("kind", ["untracked", "tracked"])
    def test_unstaging_does_not_expose_the_file(self, tmp_path, kind):
        repo = self._clone(tmp_path, kind)
        (repo / "code.txt").write_text("the agent's change\n")
        self._git(repo, "reset", "-q")
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "agent")
        assert self._committed(repo) == ["code.txt"]

    @pytest.mark.parametrize("kind", ["untracked", "tracked"])
    def test_safety_net_commit_leaves_the_file_out(self, tmp_path, kind):
        repo = self._clone(tmp_path, kind)
        (repo / "code.txt").write_text("work the agent did not commit\n")
        assert ensure_committed(str(repo)) is True
        assert self._committed(repo) == ["code.txt"]


class TestMcpJsonGuardFailsClosed(_GitClone):
    """Where the resolved config could reach a commit, the task fails instead.

    ``apply_mcp_assets`` raises, and the pipeline then fails the task before the
    agent starts:

    * ``.mcp.json`` is a symlink (#758). The config would land in the link's
      target, a file the commit guard does not cover. Nothing is read or written.
    * git cannot be shown to leave the written file out of commits (#759). The
      exit code of ``update-index`` is no proof: the flag is read back.
    """

    def _repo(self, tmp_path, files: dict[str, str]):
        """A repository whose one commit holds ``files``."""
        repo = tmp_path / "repo"
        repo.mkdir()
        self._git(repo, "init", "-q", "-b", "main")
        for name, content in files.items():
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_text(content)
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "init")
        return repo

    @staticmethod
    def _apply(repo_dir) -> None:
        runtime = {"transport": "http", "url": "https://mcp.example/sse?token=SUPERSECRET"}
        apply_mcp_assets(str(repo_dir), [_mcp_asset("acme", "secretful", "1.0.0", runtime)])

    @pytest.mark.parametrize(
        "target",
        [
            pytest.param("config/mcp.json", id="second-tracked-file"),
            pytest.param(".github/workflows/ci.yml", id="workflow"),
            pytest.param(".git/config", id="git-config"),
            pytest.param("missing.json", id="dangling"),
        ],
    )
    def test_symlinked_mcp_json_is_not_written_through(self, tmp_path, capfd, target):
        tracked = {
            "config/mcp.json": '{"mcpServers": {}}\n',
            ".github/workflows/ci.yml": "on: push\n",
        }
        repo = self._repo(tmp_path, tracked)
        (repo / ".mcp.json").symlink_to(target)
        self._git(repo, "add", ".mcp.json")
        self._git(repo, "commit", "-qm", "link")

        def target_bytes() -> bytes | None:
            return (repo / target).read_bytes() if (repo / target).exists() else None

        before = target_bytes()
        with pytest.raises(RegistryAssetLoadError, match="through a symlink"):
            self._apply(repo)

        assert target_bytes() == before
        # Not read through the link either: a target that is not JSON logs no WARN.
        assert "WARN" not in capfd.readouterr().out
        # What the safety-net commit would stage: nothing.
        self._git(repo, "add", "-u")
        assert self._git(repo, "diff", "--cached", "--name-only").stdout == ""
        assert self._git(repo, "status", "--porcelain").stdout == ""

    def test_index_lock_held_by_another_git_process_raises(self, tmp_path, capfd):
        repo = self._repo(tmp_path, {".mcp.json": '{"mcpServers": {}}\n'})
        (repo / ".git" / "index.lock").touch()
        # git's own account of the failure is in the error.
        with pytest.raises(RegistryAssetLoadError, match=r"out of commits.*index\.lock"):
            self._apply(repo)
        # The lines of a load that succeeded do not follow a guard that failed.
        out = capfd.readouterr().out
        assert "Registry: merged" not in out
        assert "platform-managed" not in out

    def test_index_lock_raises_where_gitignore_re_includes_the_file(self, tmp_path):
        # A file the repository does not track and does not let the exclude file
        # ignore needs an index entry for the flag, which the lock refuses.
        repo = self._repo(tmp_path, {".gitignore": "!.mcp.json\n"})
        (repo / ".git" / "index.lock").touch()
        with pytest.raises(RegistryAssetLoadError, match="out of commits"):
            self._apply(repo)

    def test_unmerged_index_entry_raises(self, tmp_path):
        repo = self._repo(tmp_path, {".mcp.json": '{"mcpServers": {}}\n'})
        self._git(repo, "checkout", "-q", "-b", "other")
        (repo / ".mcp.json").write_text('{"mcpServers": {"theirs": {"command": "x"}}}\n')
        self._git(repo, "commit", "-qam", "theirs")
        self._git(repo, "checkout", "-q", "main")
        (repo / ".mcp.json").write_text('{"mcpServers": {"ours": {"command": "y"}}}\n')
        self._git(repo, "commit", "-qam", "ours")
        assert self._git(repo, "merge", "--no-edit", "other", check=False).returncode != 0
        assert self._git(repo, "ls-files", "-u", "--", ".mcp.json").stdout != ""

        with pytest.raises(RegistryAssetLoadError, match="out of commits"):
            self._apply(repo)

    @pytest.mark.parametrize(
        "failure",
        [
            pytest.param(subprocess.TimeoutExpired(cmd="git", timeout=15), id="timeout"),
            pytest.param(FileNotFoundError("git"), id="no-git"),
        ],
    )
    def test_git_call_that_fails_raises(self, tmp_path, monkeypatch, failure):
        repo = self._repo(tmp_path, {".mcp.json": '{"mcpServers": {}}\n'})

        def _fail(*_args, **_kwargs):
            raise failure

        monkeypatch.setattr("registry.loader.subprocess.run", _fail)
        with pytest.raises(RegistryAssetLoadError, match="out of commits"):
            self._apply(repo)

    def test_update_index_that_reports_success_without_marking_raises(self, tmp_path, monkeypatch):
        repo = self._repo(tmp_path, {".mcp.json": '{"mcpServers": {}}\n'})
        real_run = subprocess.run

        def _run(argv, *args, **kwargs):
            if "update-index" in argv:
                return subprocess.CompletedProcess(argv, 0, "", "")
            return real_run(argv, *args, **kwargs)

        monkeypatch.setattr("registry.loader.subprocess.run", _run)
        with pytest.raises(RegistryAssetLoadError, match=r"out of commits.*git reported no error"):
            self._apply(repo)

    def test_sparse_checkout_raises(self, tmp_path):
        # With real git: where sparse checkout is enabled, update-index reports
        # success and the entry is not flagged afterwards.
        repo = self._repo(tmp_path, {".mcp.json": '{"mcpServers": {}}\n'})
        self._git(repo, "config", "core.sparseCheckout", "true")
        self._git(repo, "update-index", "--skip-worktree", ".mcp.json")
        if self._git(repo, "ls-files", "-v", "--", ".mcp.json").stdout.startswith("S "):
            pytest.skip("this git keeps the flag where sparse checkout is enabled (before 2.36)")
        with pytest.raises(RegistryAssetLoadError, match=r"out of commits.*git reported no error"):
            self._apply(repo)

    def test_entry_that_is_only_assume_unchanged_does_not_count_as_flagged(self, tmp_path):
        # "h" in `git ls-files -v` is assume-unchanged without skip-worktree. It is
        # not the flag the guard sets, and the lock keeps the guard from setting its own.
        repo = self._repo(tmp_path, {".mcp.json": '{"mcpServers": {}}\n'})
        self._git(repo, "update-index", "--assume-unchanged", ".mcp.json")
        (repo / ".git" / "index.lock").touch()
        with pytest.raises(RegistryAssetLoadError, match="out of commits"):
            self._apply(repo)

    def test_entry_that_is_assume_unchanged_as_well_counts_as_flagged(self, tmp_path):
        # "s" is skip-worktree on an entry that is assume-unchanged too: the flag the
        # guard sets is there, so the server loads.
        repo = self._repo(tmp_path, {".mcp.json": '{"mcpServers": {}}\n'})
        self._git(repo, "update-index", "--assume-unchanged", ".mcp.json")
        self._apply(repo)
        assert self._git(repo, "ls-files", "-v", "--", ".mcp.json").stdout == "s .mcp.json\n"
        self._git(repo, "add", "-u")
        assert self._git(repo, "diff", "--cached", "--name-only").stdout == ""

    def test_flagged_entry_of_another_path_does_not_count_for_the_file(self, tmp_path):
        # The flag has to be on the entry of the file itself: for the pathspec
        # `.mcp.json` git also lists what the index holds below a directory of that name.
        repo = self._repo(tmp_path, {".mcp.json/servers.json": "{}\n"})
        self._git(repo, "update-index", "--skip-worktree", ".mcp.json/servers.json")
        shutil.rmtree(repo / ".mcp.json")
        listed = self._git(repo, "ls-files", "-v", "--", ".mcp.json").stdout
        assert listed == "S .mcp.json/servers.json\n"
        with pytest.raises(RegistryAssetLoadError, match="out of commits"):
            self._apply(repo)

    def test_directory_that_is_not_a_repository_raises(self, tmp_path_factory):
        plain = tmp_path_factory.mktemp("plain")  # beside tmp_path, which is a repository
        with pytest.raises(RegistryAssetLoadError, match="out of commits: git did not mark"):
            self._apply(plain)

    def test_directory_inside_a_clone_is_guarded(self, tmp_path):
        repo = self._repo(tmp_path, {"pkg/.mcp.json": '{"mcpServers": {}}\n'})
        self._apply(repo / "pkg")
        self._git(repo, "add", "-u")
        assert self._git(repo, "diff", "--cached", "--name-only").stdout == ""
