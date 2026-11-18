"""Unit tests for registry.loader — merging resolved mcp_server assets (#246)."""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from post_hooks import ensure_committed
from registry.loader import (
    RegistryAssetLoadError,
    apply_mcp_assets,
    apply_resolved_assets,
    build_skill_prompt_fragment,
)


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


class TestMcpJsonGuardKeepsGitUsable:
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

    @staticmethod
    def _git(repo, *args, check=True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
        )
        if check:  # a step that failed must not read as "nothing was staged"
            assert result.returncode == 0, f"git {' '.join(args)}: {result.stderr.strip()}"
        return result

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

    @pytest.fixture(autouse=True)
    def _git_environment(self, tmp_path, monkeypatch):
        # No ignore file of the host (it may list .mcp.json), and an identity for
        # the commits, also for the one post_hooks makes.
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
        for role in ("AUTHOR", "COMMITTER"):
            monkeypatch.setenv(f"GIT_{role}_NAME", "t")
            monkeypatch.setenv(f"GIT_{role}_EMAIL", "t@t")

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

    def test_untracked_file_gets_no_index_entry(self, tmp_path, capfd):
        repo = self._clone(tmp_path, "untracked")
        assert self._git(repo, "ls-files", "--", ".mcp.json").stdout == ""
        assert self._git(repo, "status", "--porcelain").stdout == ""
        assert "WARN" not in capfd.readouterr().out  # the guard reported no failure

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

    def test_refused_add_of_the_file_comes_without_git_advice(self, tmp_path, monkeypatch):
        # git refuses to add an ignored file that is named, and prints advice with
        # the refusal. The refusal stays; the advice is off in the clone.
        monkeypatch.setenv("LC_ALL", "C")  # git's own language: its advice lines begin "hint:"
        repo = self._clone(tmp_path, "untracked")
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
