import functools
import os
import subprocess
from types import SimpleNamespace

import pytest

import repo
import shell
from tests.conftest import FakeRunCmd, make_task_config


def _fake_run_cmd(
    returncodes: dict[str, int] | None = None,
    stdouts: dict[str, str] | None = None,
) -> FakeRunCmd:
    return FakeRunCmd(returncodes=returncodes, stdouts=stdouts, match_substring=True)


_config = make_task_config


def _answer_push_url(run):
    pushed: dict[str, str] = {}

    def wrapped(cmd, label, **kwargs):
        if label == "set-remote-push-url":
            pushed["url"] = cmd[-1]
        result = run(cmd, label, **kwargs)
        if label == "get-remote-push-url":
            return SimpleNamespace(returncode=0, stdout=f"{pushed.get('url', '')}\n", stderr="")
        return result

    return wrapped


def _patch_common(monkeypatch, fake: FakeRunCmd):
    monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
    monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
    monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
    monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
    monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
    monkeypatch.setattr(repo, "_preflight_probe_commit", lambda repo_dir: _PROBE_SHA)


_PROBE_SHA = "c0ffee" * 6 + "c0ff"


def _git(*args: str, cwd) -> str:
    identity = ("-c", "user.name=ABCA Test", "-c", "user.email=abca-test@example.invalid")
    done = subprocess.run(
        ["git", *identity, *args], cwd=cwd, check=True, capture_output=True, text=True
    )
    return done.stdout.strip()


def _origin(tmp_path, default: str, *branches: str) -> str:
    origin, seed = tmp_path / "origin.git", tmp_path / "seed"
    _git("init", "-q", "--bare", str(origin), cwd=tmp_path)
    _git("init", "-q", str(seed), cwd=tmp_path)
    for repository in (origin, seed):
        _git("symbolic-ref", "HEAD", f"refs/heads/{default}", cwd=repository)
    _git("commit", "-q", "--allow-empty", "-m", "base", cwd=seed)
    for name in branches:
        _git("checkout", "-q", "-b", name, default, cwd=seed)
        _git("commit", "-q", "--allow-empty", "-m", name, cwd=seed)
    _git("push", "-q", str(origin), "--all", cwd=seed)
    return str(origin)


def _setup_with_real_git(
    monkeypatch,
    tmp_path,
    config,
    *,
    default="main",
    branches=(),
    offline=False,
    ran=None,
    from_fork=False,
):
    origin = _origin(tmp_path, default, *branches)

    def run(cmd, label, cwd=None, check=True, **_kwargs):
        if ran is not None:
            ran.append(label)
        if label == "clone":
            cmd = ["git", "clone", "-q", origin, cmd[-1]]
        elif label == "check-pr-fork":
            answer = "true\n" if from_fork else "false\n"
            return SimpleNamespace(returncode=0, stdout=answer, stderr="")
        elif cmd[0] != "git" or label in (
            "safe-directory",
            "set-remote-url",
            "set-remote-push-url",
        ):
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        elif offline and cmd[1] == "fetch":
            return SimpleNamespace(returncode=1, stdout="", stderr="fatal: connection reset")
        return shell.run_cmd(cmd, label, cwd=cwd, check=check)

    monkeypatch.setattr(repo, "AGENT_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setattr(repo, "run_cmd", _answer_push_url(run))
    monkeypatch.setattr(repo, "run_cmd_with_backoff", functools.partial(run, check=False))
    monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
    monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: default)
    return repo.setup_repo(config)


class TestSetupRepoHappyPath:
    def test_new_task_argv_sequence_and_remote_url_has_no_token(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config())

        labels = fake.labels()
        assert "clone" in labels
        assert "set-remote-url" in labels
        assert "configure-git-credential-helper" in labels
        assert labels.index("clone") < labels.index("set-remote-url")
        assert labels.index("set-remote-url") < labels.index("create-branch")

        set_url_cmd = fake.cmd_for("set-remote-url")
        assert set_url_cmd is not None
        remote = set_url_cmd[-1]
        assert remote == "https://github.com/owner/repo.git"
        assert "@" not in remote
        assert "x-access-token" not in remote
        assert "ghp_" not in " ".join(set_url_cmd)

        helper_cmd = fake.cmd_for("configure-git-credential-helper")
        assert helper_cmd is not None
        assert "credential.https://github.com.helper" in helper_cmd
        assert fake.cmd_for("reset-git-credential-helpers")[-2:] == [
            "credential.https://github.com.helper",
            "",
        ]
        assert labels.index("reset-git-credential-helpers") < labels.index(
            "configure-git-credential-helper"
        )

        assert setup.branch.startswith("bgagent/task-abc/")
        assert setup.default_branch == "main"

    def test_clone_adds_no_upstream_remote_for_a_fork(self, monkeypatch):
        # For a fork, `gh repo clone` adds the parent as the remote `upstream` and
        # makes it the repository of every later `gh` command that has no `--repo`.
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        repo.setup_repo(_config())

        assert fake.cmd_for("clone")[:4] == ["gh", "repo", "clone", "--no-upstream"]

    def test_pr_branch_checkout_path(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)

        setup = repo.setup_repo(
            _config(
                is_pr_workflow=True,
                branch_name="feature/existing",
                base_branch="develop",
            )
        )

        labels = fake.labels()
        assert "fetch-pr-branch" in labels
        assert "checkout-pr-branch" in labels
        assert "create-branch" not in labels
        assert setup.branch == "feature/existing"
        assert setup.default_branch == "develop"

    def test_non_pr_task_captures_head_sha_for_digest(self, monkeypatch):
        fake = _fake_run_cmd(stdouts={"head-sha-after-setup": "deadbeefcafe1234\n"})
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config())

        assert "head-sha-after-setup" in fake.labels()
        assert setup.head_sha_before == "deadbeefcafe1234"

    def test_pr_workflow_does_not_double_capture_head_sha(self, monkeypatch):
        fake = _fake_run_cmd(stdouts={"head-sha-before": "aaaa1111bbbb2222\n"})
        _patch_common(monkeypatch, fake)

        setup = repo.setup_repo(
            _config(is_pr_workflow=True, branch_name="feature/x", base_branch="develop")
        )

        assert setup.head_sha_before == "aaaa1111bbbb2222"
        assert "head-sha-after-setup" not in fake.labels()


class TestPullRequestBranch:
    @staticmethod
    def _pr_task(head: str):
        return _config(is_pr_workflow=True, pr_number="40", branch_name=head, base_branch="main")

    @pytest.mark.parametrize("head", ["develop", "feature/x"], ids=["default-branch", "other"])
    def test_pr_branch_is_checked_out_with_real_git(self, tmp_path, monkeypatch, head):
        ran: list[str] = []
        setup = _setup_with_real_git(
            monkeypatch,
            tmp_path,
            self._pr_task(head),
            default="develop",
            branches=("main", "feature/x"),
            ran=ran,
        )

        clone = setup.repo_dir
        assert _git("rev-parse", "--abbrev-ref", "HEAD", cwd=clone) == head
        assert _git("rev-parse", "HEAD", cwd=clone) == _git(
            "rev-parse", f"origin/{head}", cwd=clone
        )
        assert setup.head_sha_before == _git("rev-parse", f"origin/{head}", cwd=clone)
        assert (setup.branch, setup.default_branch) == (head, "main")
        assert "check-pr-fork" in ran

    def test_pr_from_a_fork_is_refused_before_its_branch_name_is_fetched(self, monkeypatch):
        fake = _fake_run_cmd(stdouts={"check-pr-fork": "true\n"})
        _patch_common(monkeypatch, fake)

        with pytest.raises(RuntimeError, match="#40 of owner/repo comes from another repository"):
            repo.setup_repo(self._pr_task("main"))

        assert "fetch-pr-branch" not in fake.labels()

    def test_pr_from_a_fork_is_refused_when_its_branch_name_is_another_branch_here(
        self, tmp_path, monkeypatch
    ):
        ran: list[str] = []

        with pytest.raises(RuntimeError, match="#40 of owner/repo comes from another repository"):
            _setup_with_real_git(
                monkeypatch,
                tmp_path,
                self._pr_task("feature/x"),
                branches=("feature/x",),
                ran=ran,
                from_fork=True,
            )

        assert "fetch-pr-branch" not in ran

    def test_fork_check_without_an_answer_stops_setup_like_a_failed_fetch(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        bad_gateway = "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)"

        def backoff(cmd, label, **kwargs):
            failed = label == "check-pr-fork"
            return SimpleNamespace(
                returncode=int(failed), stdout="", stderr=bad_gateway if failed else ""
            )

        monkeypatch.setattr(repo, "run_cmd_with_backoff", backoff)

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(self._pr_task("main"))

        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]: check-pr-fork ")
        assert "(resource: owner/repo)" in str(excinfo.value)
        assert "checkout-pr-branch" not in fake.labels()

    def test_pr_from_the_repository_itself_passes_the_fork_check(self, monkeypatch):
        fake = _fake_run_cmd(stdouts={"check-pr-fork": "false\n"})
        _patch_common(monkeypatch, fake)

        repo.setup_repo(self._pr_task("main"))

        assert fake.cmd_for("check-pr-fork") == [
            "gh",
            "pr",
            "view",
            "40",
            "--repo",
            "owner/repo",
            "--json",
            "isCrossRepository",
            "-q",
            ".isCrossRepository",
        ]
        assert "checkout-pr-branch" in fake.labels()


class TestDiamondBaseBranch:
    def test_diamond_resolves_real_default_over_server_main_literal(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "linear-vercel")

        setup = repo.setup_repo(
            _config(
                base_branch="main",
                merge_branches=["bgagent/task-x/feat-a", "bgagent/task-y/feat-b"],
            )
        )

        find_cmd = fake.cmd_for("find-base-branch")
        assert find_cmd is not None
        assert find_cmd[-1] == "refs/remotes/origin/linear-vercel"
        create_cmd = fake.cmd_for("create-branch-from-base")
        assert create_cmd is not None
        assert create_cmd[-1] == "origin/linear-vercel"
        assert setup.default_branch == "linear-vercel"
        assert "merge-predecessor" in " ".join(fake.labels()) or any(
            "merge" in lbl for lbl in fake.labels()
        )

    def test_diamond_no_op_when_server_base_already_matches_detected_default(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(
            _config(base_branch="main", merge_branches=["bgagent/task-x/feat-a"])
        )
        assert fake.cmd_for("find-base-branch")[-1] == "refs/remotes/origin/main"
        assert setup.default_branch == "main"

    def test_linear_child_base_branch_is_left_untouched(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "linear-vercel")

        setup = repo.setup_repo(
            _config(base_branch="bgagent/task-pred/feat-pred", merge_branches=[])
        )
        base_ref = "refs/remotes/origin/bgagent/task-pred/feat-pred"
        assert fake.cmd_for("find-base-branch")[-1] == base_ref
        assert fake.cmd_for("create-branch-from-base")[-1] == "origin/bgagent/task-pred/feat-pred"
        assert setup.default_branch == "bgagent/task-pred/feat-pred"


class TestStackedChildWithRealGit:
    PRED = "bgagent/task-pred/feat-pred"

    def test_child_branches_from_its_predecessor_when_the_connection_drops(
        self, tmp_path, monkeypatch
    ):
        setup = _setup_with_real_git(
            monkeypatch,
            tmp_path,
            _config(base_branch=self.PRED),
            branches=(self.PRED,),
            offline=True,
        )

        clone = setup.repo_dir
        assert _git("rev-parse", "HEAD", cwd=clone) == _git(
            "rev-parse", f"origin/{self.PRED}", cwd=clone
        )
        assert setup.default_branch == self.PRED
        assert not [n for n in setup.notes if "branched off default" in n]

    def test_predecessor_is_merged_when_the_connection_drops(self, tmp_path, monkeypatch):
        setup = _setup_with_real_git(
            monkeypatch,
            tmp_path,
            _config(base_branch="main", merge_branches=[self.PRED]),
            branches=(self.PRED,),
            offline=True,
        )

        clone = setup.repo_dir
        assert f"merged predecessor branch '{self.PRED}'" in setup.notes
        assert _git("rev-parse", "HEAD", cwd=clone) == _git(
            "rev-parse", f"origin/{self.PRED}", cwd=clone
        )

    def test_child_whose_base_is_gone_targets_the_default_branch(self, tmp_path, monkeypatch):
        setup = _setup_with_real_git(
            monkeypatch, tmp_path, _config(base_branch=self.PRED), default="trunk"
        )

        clone = setup.repo_dir
        assert _git("rev-parse", "HEAD", cwd=clone) == _git("rev-parse", "origin/trunk", cwd=clone)
        assert f"base branch '{self.PRED}' not on origin; branched off default instead" in (
            setup.notes
        )
        assert setup.default_branch == "trunk"


class TestReadOnlyBaselineSkip:
    def test_read_only_skips_build_and_lint_baseline(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=True))

        labels = fake.labels()
        assert "verify-build-pre" not in labels
        assert "verify-lint-pre" not in labels
        assert "clone" in labels
        assert "mise-install" in labels
        assert setup.build_before is True
        assert setup.lint_before is True
        assert setup.build_gate_inert is False
        assert setup.lint_gate_inert is False
        assert any("Read-only workflow" in n for n in setup.notes)

    def test_non_read_only_still_runs_build_and_lint_baseline(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        labels = fake.labels()
        assert "verify-build-pre" in labels
        assert "verify-lint-pre" in labels
        assert setup.build_before is True
        assert setup.lint_before is True


class TestBaselineBuildTimeout:
    class _RecordingFake:
        def __init__(
            self,
            timeout_on: str | None = None,
            rc_on: tuple[str, int, str] | None = None,
        ):
            self.calls: list[dict] = []
            self._timeout_on = timeout_on
            self._rc_on = rc_on

        def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            self.calls.append({"label": label, "timeout": timeout})
            if self._timeout_on and self._timeout_on in label:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)
            if self._rc_on and self._rc_on[0] in label:
                return SimpleNamespace(returncode=self._rc_on[1], stdout="", stderr=self._rc_on[2])
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        def timeout_for(self, label: str) -> int | None:
            for c in self.calls:
                if label in c["label"]:
                    return c["timeout"]
            return None

    def test_baseline_build_uses_the_generous_verify_ceiling_not_600s(self, monkeypatch):
        from post_hooks import BUILD_VERIFY_TIMEOUT_S

        fake = self._RecordingFake()
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        repo.setup_repo(_config(read_only=False))

        assert fake.timeout_for("verify-build-pre") == BUILD_VERIFY_TIMEOUT_S
        assert fake.timeout_for("verify-lint-pre") == BUILD_VERIFY_TIMEOUT_S
        assert BUILD_VERIFY_TIMEOUT_S > 600

    def test_baseline_build_timeout_is_guarded_not_a_task_crash(self, monkeypatch):
        fake = self._RecordingFake(timeout_on="verify-build-pre")
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.build_before is True
        assert setup.build_gate_inert is False
        assert any("did not finish within" in n for n in setup.notes)

    def test_baseline_lint_timeout_is_guarded(self, monkeypatch):
        fake = self._RecordingFake(timeout_on="verify-lint-pre")
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.lint_before is True
        assert setup.lint_gate_inert is False
        assert any("Initial lint" in n and "did not finish within" in n for n in setup.notes)

    def test_baseline_build_OOM_kill_is_not_a_regression(self, monkeypatch):
        fake = self._RecordingFake(rc_on=("verify-build-pre", 137, "Killed"))
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.build_before is True
        assert setup.build_gate_inert is False
        assert any("environment fault" in n for n in setup.notes)
        assert not any("FAILED before agent changes" in n for n in setup.notes)

    def test_baseline_build_genuine_failure_still_marks_regression_baseline(self, monkeypatch):
        fake = self._RecordingFake(rc_on=("verify-build-pre", 1, "TS2345: type error"))
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.build_before is False
        assert any("FAILED before agent changes" in n for n in setup.notes)


class TestBaselineCommandThatCannotStart:
    def test_missing_program_is_a_failed_baseline_not_a_task_crash(self, monkeypatch):
        fake = _fake_run_cmd()

        def run_cmd(cmd, label, **kwargs):
            if label in ("verify-build-pre", "verify-lint-pre"):
                raise FileNotFoundError(2, "No such file or directory", cmd[0])
            return fake(cmd, label, **kwargs)

        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(run_cmd))
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(build_command="gradle build", lint_command="gradle check"))

        assert setup.build_before is False
        assert setup.lint_before is False
        assert "Initial build (gradle build) FAILED before agent changes" in setup.notes
        assert "Initial lint (gradle check) FAILED before agent changes" in setup.notes
        assert setup.build_gate_inert is False
        assert setup.lint_gate_inert is False

    def test_unclosed_quote_is_a_failed_baseline_not_a_task_crash(self, monkeypatch):
        # The shell reports the quote that is never closed as a syntax error: exit 2.
        fake = _fake_run_cmd(returncodes={"verify-build-pre": 2, "verify-lint-pre": 2})
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(
            _config(build_command="npm run 'build", lint_command='npx eslint "src')
        )

        assert fake.cmd_for("verify-build-pre") == ["bash", "-lc", "npm run 'build"]
        assert fake.cmd_for("verify-lint-pre") == ["bash", "-lc", 'npx eslint "src']
        assert setup.build_before is False
        assert setup.lint_before is False


# What mise 2026.11.6 prints, with exit 1, for the two default commands, less the version
# lines that close every error.
_NO_MISE_TASK_AT_ALL = {
    "verify-build-pre": (
        "mise ERROR no tasks defined in /workspace/task-abc. Are you in a project directory?"
    ),
    "verify-lint-pre": (
        "mise ERROR unknown command: lint\n\nDid you mean:\n  mise link\n  mise list\n  mise ln"
    ),
}
_OTHER_MISE_TASKS_ONLY = {
    "verify-build-pre": (
        "mise ERROR no task build found\n\nAvailable tasks:\n  Name  Description\n  test  "
    ),
    "verify-lint-pre": (
        "mise ERROR no task lint found\n\nDid you mean the command:\n  mise link\n  mise list\n"
        "  mise ln\n\nAvailable tasks:\n  Name  Description\n  test  "
    ),
}


class TestBaselineDefaultTaskMissing:
    @pytest.mark.parametrize(
        "said",
        [_NO_MISE_TASK_AT_ALL, _OTHER_MISE_TASKS_ONLY],
        ids=["no-mise-task-at-all", "other-mise-tasks-only"],
    )
    def test_missing_default_tasks_are_gates_that_did_not_run(self, monkeypatch, said):
        fake = _fake_run_cmd()

        def run_cmd(cmd, label, **kwargs):
            if label in said:
                return SimpleNamespace(returncode=1, stdout="", stderr=said[label])
            return fake(cmd, label, **kwargs)

        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(run_cmd))
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config())

        assert setup.build_gate_inert is True
        assert any("Build-regression gating is INERT" in n for n in setup.notes)
        assert setup.lint_gate_inert is True
        assert setup.lint_before is True
        assert any("lint verification is INERT" in n for n in setup.notes)
        assert "Initial lint (mise run lint) FAILED before agent changes" not in setup.notes


class TestFindMiseConfigs:
    def _mk(self, root, rels):
        import os

        for r in rels:
            d = os.path.dirname(r)
            if d:
                os.makedirs(os.path.join(root, d), exist_ok=True)
            open(os.path.join(root, r), "w").close()

    def _rel(self, root, configs):
        import os

        return sorted(os.path.relpath(c, root) for c in configs)

    def test_returns_nested_configs_excluding_root(self, tmp_path):
        root = str(tmp_path)
        self._mk(root, ["mise.toml", "cdk/mise.toml", "cli/mise.toml", "agent/mise.toml"])
        got = self._rel(root, repo._find_mise_configs(root))
        assert "mise.toml" not in got
        assert got == ["agent/mise.toml", "cdk/mise.toml", "cli/mise.toml"]

    def test_skips_vendored_and_build_dirs(self, tmp_path):
        root = str(tmp_path)
        self._mk(
            root,
            ["mise.toml", "cdk/mise.toml", "node_modules/pkg/mise.toml", "cdk/cdk.out/a/mise.toml"],
        )
        got = self._rel(root, repo._find_mise_configs(root))
        assert got == ["cdk/mise.toml"]

    def test_no_nested_configs_returns_empty(self, tmp_path):
        root = str(tmp_path)
        self._mk(root, ["mise.toml"])
        assert repo._find_mise_configs(root) == []


class TestDetectDefaultBranch:
    def test_returns_detected_branch(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout="trunk\n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "trunk"

    def test_timeout_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="gh", timeout=30)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_gh_missing_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_oserror_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise OSError("permission denied")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_subprocess_error_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise subprocess.SubprocessError("boom")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_nonzero_exit_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="auth error")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_empty_stdout_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout="   \n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    @pytest.mark.parametrize(
        "gh_failure",
        [
            subprocess.TimeoutExpired(cmd="gh", timeout=30),
            FileNotFoundError("gh"),
            SimpleNamespace(returncode=1, stdout="", stderr="HTTP 502: Bad Gateway"),
        ],
        ids=["timeout", "gh-missing", "non-zero-exit"],
    )
    def test_gh_failure_falls_back_to_the_default_branch_of_the_clone(
        self, tmp_path, monkeypatch, gh_failure
    ):
        clone = tmp_path / "clone"
        _git("clone", "-q", _origin(tmp_path, "trunk"), str(clone), cwd=tmp_path)
        real_run = subprocess.run

        def fake_run(cmd, **kwargs):
            if cmd[0] != "gh":
                return real_run(cmd, **kwargs)
            if isinstance(gh_failure, Exception):
                raise gh_failure
            return gh_failure

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", str(clone)) == "trunk"


class TestPlatformBranchNameVerbatim:
    def test_uses_platform_branch_name_verbatim_for_new_task(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=False,
                branch_name="bgagent/01TESTTASKID/abca-166-add-seville-guide-html",
                task_description="ABCA-166: Add seville-guide.html",
            )
        )
        assert setup.branch == "bgagent/01TESTTASKID/abca-166-add-seville-guide-html"

    def test_uses_platform_branch_name_verbatim_for_pr_workflow(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=True,
                branch_name="bgagent/01TESTTASKID/abca-167-stacked-child",
                base_branch="bgagent/01PREDTASK/abca-166-predecessor",
            )
        )
        assert setup.branch == "bgagent/01TESTTASKID/abca-167-stacked-child"

    def test_falls_back_to_derived_slug_only_when_no_branch_name(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=False,
                task_description="ABCA-168: derive me",
            )
        )
        assert setup.branch.startswith("bgagent/")


class _RecordingProgress:
    def __init__(self):
        self.calls = []
        self._disabled = False

    def __getattr__(self, name):
        if name.startswith("write_"):
            return lambda **kw: self.calls.append((name, kw))
        raise AttributeError(name)


class TestSetupRepoDependencyUnreachable:
    def _patch_backoff_to_fail(self, monkeypatch, fake, *, transient_stderr):
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)

        def fake_backoff(cmd, label, *, on_retry=None, **kwargs):
            from shell import is_transient_cmd_failure

            if is_transient_cmd_failure(transient_stderr):
                for attempt in range(1, 3):
                    if on_retry is not None:
                        on_retry(attempt, 3, transient_stderr)
            return SimpleNamespace(returncode=1, stdout="", stderr=transient_stderr)

        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake_backoff)

    def test_named_host_clone_bails_through_real_backoff_no_retry_events(self, monkeypatch):
        clone_calls = []

        def fake_run_cmd(cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            if "clone" in label:
                clone_calls.append(cmd)
                return SimpleNamespace(
                    returncode=1,
                    stdout="",
                    stderr="fatal: unable to access: Could not resolve host: github.com",
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr("shell.run_cmd", fake_run_cmd)
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake_run_cmd))
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        assert len(clone_calls) == 1
        assert str(excinfo.value).startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in str(excinfo.value)
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        assert not [c for c in blocked if c[1]["kind"] == "dependency_unreachable"]
        egress = [c for c in blocked if c[1]["kind"] == "egress_denied"]
        assert len(egress) == 1
        assert egress[0][1]["retryable"] is False

    def test_exhausted_clone_reports_and_raises_canonical_reason(self, monkeypatch):
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch, fake, transient_stderr="error: RPC failed; connection reset"
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:")
        assert "(resource: owner/repo)" in str(excinfo.value)

        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        assert len(blocked) == 3
        assert all(c[1]["kind"] == "dependency_unreachable" for c in blocked)
        assert all(c[1]["retryable"] is True for c in blocked)

    def test_exhausted_clone_naming_host_is_egress_denied_not_retryable(self, monkeypatch):
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="fatal: unable to access: Could not resolve host: github.com",
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        assert str(excinfo.value).startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in str(excinfo.value)

        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        terminal = [c for c in blocked if c[1]["kind"] == "egress_denied"]
        assert terminal, "expected an egress_denied blocker event"
        assert all(c[1]["retryable"] is False for c in terminal)
        assert all(c[1]["resource"] == "github.com" for c in terminal)

    def test_permanent_clone_failure_is_not_reported_as_dependency_unreachable(self, monkeypatch):
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="Could not resolve to a Repository with the name 'owner/repo'",
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(RuntimeError) as excinfo:
            repo.setup_repo(_config(), progress=progress)
        assert not isinstance(excinfo.value, repo.DependencyUnreachableError)
        assert "BLOCKED[" not in str(excinfo.value)
        assert not [c for c in progress.calls if c[0] == "write_agent_blocked"]

    def test_permanent_failure_stderr_is_redacted_in_raised_error(self, monkeypatch):
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="fatal: Authentication failed for 'https://ghp_SECRETTOKEN123@github.com/o/r'",
        )
        import pytest

        with pytest.raises(RuntimeError) as excinfo:
            repo.setup_repo(_config(), progress=_RecordingProgress())
        assert "ghp_SECRETTOKEN123" not in str(excinfo.value)

    def test_exhausted_pr_branch_fetch_reports_branch_as_resource(self, monkeypatch):
        fake = _fake_run_cmd()
        monkeypatch.setattr(repo, "run_cmd", _answer_push_url(fake))
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)

        def fake_backoff(cmd, label, *, on_retry=None, **kwargs):
            if label == "fetch-pr-branch":
                return SimpleNamespace(returncode=1, stdout="", stderr="connection timed out")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake_backoff)
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(
                _config(is_pr_workflow=True, branch_name="feature/x", base_branch="main"),
                progress=progress,
            )

        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:")
        assert "(resource: feature/x)" in str(excinfo.value)
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        assert any(c[1].get("resource") == "feature/x" for c in blocked)

    def test_remediation_does_not_widen_creds_or_egress(self, monkeypatch):
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(monkeypatch, fake, transient_stderr="connection timed out")
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError):
            repo.setup_repo(_config(), progress=progress)

        labels = fake.labels()
        assert "set-remote-url" not in labels
        assert "configure-git-credential-helper" not in labels
        assert "safe-directory" in labels


class TestCloneWorkspaceGuards:
    def test_prepare_clears_non_empty_workspace_and_notes(self, tmp_path):
        repo_dir = tmp_path / "task-abc"
        repo_dir.mkdir()
        (repo_dir / "stale.txt").write_text("residue from a prior run")
        (repo_dir / "nested").mkdir()
        notes: list[str] = []

        repo._prepare_clone_dir(str(repo_dir), notes)

        assert not repo_dir.exists()
        assert any("residue" in n for n in notes)

    def test_prepare_leaves_empty_workspace_untouched_no_note(self, tmp_path):
        repo_dir = tmp_path / "task-abc"
        repo_dir.mkdir()
        notes: list[str] = []

        repo._prepare_clone_dir(str(repo_dir), notes)

        assert repo_dir.exists()
        assert notes == []

    def test_prepare_absent_workspace_is_noop(self, tmp_path):
        repo_dir = tmp_path / "does-not-exist"
        notes: list[str] = []

        repo._prepare_clone_dir(str(repo_dir), notes)

        assert not repo_dir.exists()
        assert notes == []

    def test_assert_root_passes_when_git_dir_present(self, tmp_path):
        repo_dir = tmp_path / "task-abc"
        (repo_dir / ".git").mkdir(parents=True)

        repo._assert_clone_root(str(repo_dir))

    def test_assert_root_raises_when_git_missing(self, tmp_path):
        import pytest

        repo_dir = tmp_path / "task-abc"
        repo_dir.mkdir()
        (repo_dir / "inner" / ".git").mkdir(parents=True)

        with pytest.raises(RuntimeError, match="git repository at the workspace root"):
            repo._assert_clone_root(str(repo_dir))


class _PreflightFake(FakeRunCmd):
    def __init__(self, preflight_rc: int = 0, preflight_stderr: str = "", timeout=False):
        super().__init__(match_substring=True)
        self._preflight_rc = preflight_rc
        self._preflight_stderr = preflight_stderr
        self._timeout = timeout
        self.preflight_timeout = None

    def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
        result = super().__call__(cmd, label, cwd=cwd, timeout=timeout, check=check, **kwargs)
        if label == "push-preflight":
            self.preflight_timeout = timeout
            if self._timeout:
                raise subprocess.TimeoutExpired(cmd, timeout, stderr=b"stalled")
            return SimpleNamespace(
                returncode=self._preflight_rc, stdout="", stderr=self._preflight_stderr
            )
        return result


def _denied_403(repo_url="owner/repo", user="someone"):
    return (
        f"remote: Permission to {repo_url}.git denied to {user}.\n"
        f"fatal: unable to access 'https://github.com/{repo_url}.git/': "
        "The requested URL returned error: 403"
    )


_DENIED_403 = _denied_403()
# The 404 #801 reports for every write of the scope-less classic PAT.
_DENIED_404 = (
    "remote: Repository not found.\n"
    "fatal: repository 'https://github.com/owner/repo.git/' not found"
)
_DENIED_FINE_GRAINED = (
    "remote: Write access to repository not granted.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_REJECTED_401 = (
    "remote: Invalid username or token. Password authentication is not supported.\n"
    "fatal: Authentication failed for 'https://github.com/owner/repo.git/'"
)
_ARCHIVED = (
    "remote: This repository was archived so it is read-only.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_SAML = (
    "remote: The 'acme' organization has enabled or enforced SAML SSO.\n"
    "remote: To access this repository, you must use a token authorized for it.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_IP_ALLOW_LIST = (
    "remote: Although you appear to have the correct authorization credentials, the "
    "`acme` organization has an IP allow list enabled, and your IP address is not "
    "permitted to access this resource.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_BAD_GATEWAY = (
    "fatal: unable to access 'https://github.com/{repo}.git/': "
    "The requested URL returned error: 502"
)


class TestPushCapabilityPreflight:
    def _setup(self, monkeypatch, fake):
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

    def _raises(self, monkeypatch, stderr, exc=None, progress=None, **config):
        import pytest

        fake = _PreflightFake(preflight_rc=128, preflight_stderr=stderr)
        self._setup(monkeypatch, fake)
        with pytest.raises(exc or repo.PushCapabilityError) as excinfo:
            repo.setup_repo(_config(**config), progress=progress)
        return fake, str(excinfo.value)

    def test_writeable_task_probes_push_with_a_forced_dry_run(self, monkeypatch):
        token = "ghp_" + "z" * 36
        fake = _PreflightFake()
        self._setup(monkeypatch, fake)

        setup = repo.setup_repo(_config(branch_name="bgagent/task-abc/feature", github_token=token))

        cmd = fake.cmd_for("push-preflight")
        assert cmd is not None
        assert cmd[:4] == ["git", "push", "--dry-run", "--no-verify"]
        assert cmd[4] == "origin"
        src, dst = cmd[5].split(":", 1)
        assert src == f"+{_PROBE_SHA}"
        assert dst.startswith("refs/heads/")
        assert dst != f"refs/heads/{setup.branch}"
        assert token not in " ".join(cmd)
        assert "@" not in " ".join(cmd)
        assert fake.preflight_timeout == 120

    def test_preflight_runs_after_auth_is_configured_and_before_branch_setup(self, monkeypatch):
        fake = _PreflightFake()
        self._setup(monkeypatch, fake)

        repo.setup_repo(_config())

        labels = fake.labels()
        assert labels.index("configure-git-credential-helper") < labels.index("push-preflight")
        assert labels.index("push-preflight") < labels.index("create-branch")

    def test_read_only_workflow_is_not_gated(self, monkeypatch):
        fake = _PreflightFake(preflight_rc=128, preflight_stderr=_DENIED_403)
        self._setup(monkeypatch, fake)

        def _no_probe(repo_dir):
            raise AssertionError("a read-only task must not make the probe commit")

        monkeypatch.setattr(repo, "_preflight_probe_commit", _no_probe)

        repo.setup_repo(_config(read_only=True))

        assert "push-preflight" not in fake.labels()

    def test_read_only_matches_the_coding_workflows_that_never_push(self):
        from workflow import load_workflow

        assert load_workflow("coding/pr-review-v1").read_only is True
        for pushing in ("coding/new-task-v1", "coding/pr-iteration-v1", "coding/restack-v1"):
            assert load_workflow(pushing).read_only is False, pushing

    def _artifact_workflow(self):
        from workflow import load_workflow

        base = load_workflow("coding/new-task-v1")
        return base.model_copy(
            update={
                "id": "synthetic/artifact-repoful-v1",
                "requires_repo": True,
                "terminal_outcomes": base.terminal_outcomes.model_copy(
                    update={"primary": "artifact"}
                ),
            }
        )

    def test_repo_bound_artifact_workflow_is_not_gated(self, monkeypatch):
        artifact_wf = self._artifact_workflow()
        assert artifact_wf.delivers_repo_artifact
        fake = _PreflightFake(preflight_rc=128, preflight_stderr=_DENIED_403)
        self._setup(monkeypatch, fake)
        monkeypatch.setattr("workflow.load_workflow", lambda workflow_id: artifact_wf)

        repo.setup_repo(
            _config(resolved_workflow={"id": "synthetic/artifact-repoful-v1", "version": "1"})
        )

        assert "push-preflight" not in fake.labels()
        assert "create-branch" in fake.labels()

    def test_resolve_strategy_workflow_is_not_gated(self, monkeypatch):
        from workflow import load_workflow

        base = load_workflow("coding/new-task-v1")
        steps = [
            step.model_copy(update={"strategy": "resolve"}) if step.kind == "ensure_pr" else step
            for step in base.steps
        ]
        resolve_wf = base.model_copy(update={"id": "synthetic/resolve-v1", "steps": steps})
        assert resolve_wf.read_only is False and resolve_wf.ensure_pr_strategy == "resolve"
        fake = _PreflightFake(preflight_rc=128, preflight_stderr=_DENIED_403)
        self._setup(monkeypatch, fake)
        monkeypatch.setattr("workflow.load_workflow", lambda workflow_id: resolve_wf)

        repo.setup_repo(_config(resolved_workflow={"id": "synthetic/resolve-v1", "version": "1"}))

        assert "push-preflight" not in fake.labels()

    def test_push_url_is_pinned_to_https_before_the_check(self, monkeypatch):
        fake = _PreflightFake()
        self._setup(monkeypatch, fake)

        repo.setup_repo(_config())

        assert fake.cmd_for("set-remote-push-url")[-1] == "https://github.com/owner/repo.git"
        labels = fake.labels()
        assert labels.index("set-remote-push-url") < labels.index("push-preflight")
        assert fake.cmd_for("reset-git-credential-helpers")[-2:] == [
            "credential.https://github.com.helper",
            "",
        ]

    def test_rewritten_push_url_stops_setup(self, monkeypatch):
        import pytest

        fake = _PreflightFake()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        def rewritten(cmd, label, **kwargs):
            result = fake(cmd, label, **kwargs)
            if label == "get-remote-push-url":
                return SimpleNamespace(
                    returncode=0, stdout="git@github.com:owner/repo.git\n", stderr=""
                )
            return result

        monkeypatch.setattr(repo, "run_cmd", rewritten)

        with pytest.raises(RuntimeError, match="rewrites the push URL"):
            repo.setup_repo(_config())

        assert "push-preflight" not in fake.labels()

    def test_repo_optional_artifact_workflow_with_a_repo_is_gated(self, monkeypatch):
        from workflow import load_workflow

        assert not load_workflow("default/agent-v1").delivers_repo_artifact
        self._raises(
            monkeypatch,
            _DENIED_403,
            resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
        )

    def test_unloadable_workflow_is_gated(self, monkeypatch):
        from workflow import WorkflowValidationError

        def _broken(workflow_id):
            raise WorkflowValidationError("bad file")

        monkeypatch.setattr("workflow.load_workflow", _broken)
        self._raises(monkeypatch, _DENIED_403, resolved_workflow={"id": "x/y-v1", "version": "1"})

    def test_fine_grained_token_passes_on_the_servers_verdict(self, monkeypatch):
        fake = _PreflightFake(preflight_rc=0)
        self._setup(monkeypatch, fake)

        repo.setup_repo(_config(github_token="github_pat_" + "a" * 20))

        assert "create-branch" in fake.labels()

    def test_classic_token_with_repo_scope_passes(self, monkeypatch):
        fake = _PreflightFake(preflight_rc=0)
        self._setup(monkeypatch, fake)

        repo.setup_repo(_config(github_token="ghp_" + "a" * 36))

        assert "create-branch" in fake.labels()

    def test_classic_token_without_scopes_fails_before_the_agent_runs(self, monkeypatch):
        token = "ghp_" + "b" * 36
        fake, message = self._raises(monkeypatch, _DENIED_404, github_token=token)

        assert message.startswith("Token cannot push to owner/repo")
        assert "classic personal access token" in message
        assert "`public_repo` scope for a public repository, or `repo` for a private one" in message
        assert "its owner needs write access to the repository" in message
        assert "Repository not found" in message
        assert "agent/README.md" in message
        assert token not in message
        assert fake.labels()[-1] == "push-preflight"

    def test_403_refusal_and_the_login_is_not_kept(self, monkeypatch):
        _, message = self._raises(monkeypatch, _denied_403(user="bot-account"))

        assert message.startswith("Token cannot push to owner/repo")
        assert "Permission to owner/repo.git denied to <token user>" in message
        assert "bot-account" not in message

    def test_fine_grained_refusal_names_access_and_the_contents_permission(self, monkeypatch):
        _, message = self._raises(
            monkeypatch, _DENIED_FINE_GRAINED, github_token="github_pat_" + "c" * 20
        )

        assert "fine-grained personal access token" in message
        assert "include the repository in the token's repository access" in message
        assert "Contents permission with Read and write access" in message
        assert "Write access to repository not granted" in message

    def test_unknown_token_type_gets_both_remedies(self, monkeypatch):
        _, message = self._raises(monkeypatch, _DENIED_403, github_token="")

        assert "Contents permission" in message
        assert "`public_repo` scope" in message

    def test_github_app_token_remedy(self):
        remedy = repo._token_remedy("ghs_" + "e" * 36)

        assert remedy.label == "GitHub App token"
        assert "install it on the repository" in remedy.remedy

    def test_rejected_credential_is_an_auth_failure_not_a_scope_problem(self, monkeypatch):
        _, message = self._raises(monkeypatch, _REJECTED_401, github_token="ghp_" + "f" * 36)

        assert message.startswith("BLOCKED[auth_failure]:")
        assert "(resource: owner/repo)" in message
        assert "invalid, expired or revoked" in message
        assert "Token cannot push" not in message

    def test_archived_repository_is_not_blamed_on_the_token(self, monkeypatch):
        _, message = self._raises(monkeypatch, _ARCHIVED, github_token="ghp_" + "b" * 36)

        assert message.startswith("Repository owner/repo is archived on GitHub, so it is read-only")
        assert "Token cannot push" not in message
        assert "`public_repo`" not in message

    def test_saml_enforcement_names_sso_authorization(self, monkeypatch):
        _, message = self._raises(monkeypatch, _SAML, github_token="ghp_" + "b" * 36)

        assert message.startswith("GitHub organization policy blocks pushes to owner/repo")
        assert "SAML single sign-on" in message
        assert "Configure SSO" in message
        assert "`public_repo`" not in message

    def test_ip_allow_list_names_the_allow_list(self, monkeypatch):
        _, message = self._raises(monkeypatch, _IP_ALLOW_LIST)

        assert message.startswith("GitHub organization policy blocks pushes to owner/repo")
        assert "egress IP addresses" in message

    def test_names_never_pick_the_cause(self, monkeypatch):
        import pytest

        for repo_url, user in (
            ("acme/archived-tools", "someone"),
            ("acme/python3-saml", "someone"),
            ("owner/repo", "samlee"),
            ("owner/repo", "archivedbot"),
        ):
            _, message = self._raises(
                monkeypatch,
                _denied_403(repo_url, user),
                repo_url=repo_url,
                github_token="ghp_" + "b" * 36,
            )
            assert message.startswith(f"Token cannot push to {repo_url}"), repo_url
            assert "`public_repo` scope" in message
            assert "SAML" not in message
            assert "is archived on GitHub" not in message

        for repo_url in ("acme/archived-notes", "acme/saml-tools"):
            fake = _PreflightFake(
                preflight_rc=128, preflight_stderr=_BAD_GATEWAY.format(repo=repo_url)
            )
            self._setup(monkeypatch, fake)
            with pytest.raises(repo.DependencyUnreachableError) as excinfo:
                repo.setup_repo(_config(repo_url=repo_url))
            assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:"), repo_url

    def test_error_quotes_the_line_that_says_why(self, monkeypatch):
        stderr = "warning: redirecting to https://github.com/owner/repo.git/\n" + _DENIED_403
        _, message = self._raises(monkeypatch, stderr)

        assert "Permission to owner/repo.git denied" in message
        assert "redirecting" not in message

    def test_git_stderr_is_redacted_in_the_error(self, monkeypatch):
        leaked = "ghp_" + "d" * 36
        _, message = self._raises(
            monkeypatch, f"remote: Permission to owner/repo.git denied. Token {leaked}"
        )

        assert leaked not in message

    def test_each_refusal_emits_the_event_of_its_cause(self, monkeypatch):
        for stderr, kind in (
            (_DENIED_403, "auth_failure"),
            (_REJECTED_401, "auth_failure"),
            (_SAML, "auth_failure"),
            (_ARCHIVED, "unknown_environmental"),
        ):
            progress = _RecordingProgress()
            self._raises(monkeypatch, stderr, progress=progress)

            blocked = [kw for name, kw in progress.calls if name == "write_agent_blocked"]
            assert len(blocked) == 1, stderr
            assert blocked[0]["kind"] == kind, stderr
            assert blocked[0]["retryable"] is False
            assert blocked[0]["resource"] == "owner/repo"
        assert "token" not in blocked[0]["detail"].lower()

    def test_transient_failure_is_not_reported_as_a_permission_problem(self, monkeypatch):
        _, message = self._raises(
            monkeypatch, _BAD_GATEWAY.format(repo="owner/repo"), exc=repo.DependencyUnreachableError
        )

        assert message.startswith("BLOCKED[dependency_unreachable]:")

    def test_rate_limit_is_transient(self, monkeypatch):
        _, message = self._raises(
            monkeypatch,
            "fatal: unable to access 'https://github.com/owner/repo.git/': "
            "The requested URL returned error: 429",
            exc=repo.DependencyUnreachableError,
        )

        assert message.startswith("BLOCKED[dependency_unreachable]:")

    def test_timeout_is_a_retryable_dependency_failure_not_a_build_timeout(self, monkeypatch):
        import pytest

        fake = _PreflightFake(timeout=True)
        self._setup(monkeypatch, fake)
        progress = _RecordingProgress()

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        message = str(excinfo.value)
        assert message.startswith("BLOCKED[dependency_unreachable]:")
        assert "within 120s" in message
        assert "retries" not in message
        blocked = [kw for name, kw in progress.calls if name == "write_agent_blocked"]
        assert blocked and blocked[0]["retryable"] is True

    def test_unresolvable_host_is_an_egress_block(self, monkeypatch):
        _, message = self._raises(
            monkeypatch,
            "fatal: unable to access 'https://github.com/acme/archived-x.git/': "
            "Could not resolve host: github.com",
            exc=repo.DependencyUnreachableError,
            repo_url="acme/archived-x",
        )

        assert message.startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in message

    def test_other_failure_stops_the_task_with_the_git_error(self, monkeypatch):
        _, message = self._raises(monkeypatch, "fatal: something unexpected", exc=RuntimeError)

        assert "push-preflight failed" in message
        assert "something unexpected" in message

    def test_failed_probe_commit_stops_setup_before_the_push(self, monkeypatch):
        import pytest

        fake = _PreflightFake()
        self._setup(monkeypatch, fake)

        def _broken(repo_dir):
            raise RuntimeError("push-preflight-commit failed (exit 128): fatal: bad object")

        monkeypatch.setattr(repo, "_preflight_probe_commit", _broken)

        with pytest.raises(RuntimeError, match="push-preflight-commit failed"):
            repo.setup_repo(_config())

        assert "push-preflight" not in fake.labels()
        assert "create-branch" not in fake.labels()

    def test_pr_iteration_is_checked_before_its_branch_is_fetched(self, monkeypatch):
        fake, _ = self._raises(
            monkeypatch,
            _DENIED_403,
            is_pr_workflow=True,
            branch_name="feature/x",
            base_branch="develop",
        )

        assert "fetch-pr-branch" not in fake.labels()
        assert "checkout-pr-branch" not in fake.labels()

    def test_stacked_child_is_checked_before_its_base_is_fetched(self, monkeypatch):
        fake, _ = self._raises(
            monkeypatch, _DENIED_403, branch_name="bgagent/t/child", base_branch="pred"
        )

        assert "fetch-base-branch" not in fake.labels()


class TestPushPreflightRedaction:
    def test_timeout_warning_redacts_before_keeping_the_tail(self, monkeypatch, capfd):
        import pytest

        token = "ghs_" + "Q" * 515
        fake = _PreflightFake()
        _patch_common(monkeypatch, fake)

        def timing_out(cmd, label, **kwargs):
            raise subprocess.TimeoutExpired(cmd, 120, stderr=f"remote: {token}".encode())

        monkeypatch.setattr(repo, "run_cmd_with_backoff", timing_out)
        with pytest.raises(repo.DependencyUnreachableError):
            repo._preflight_push_capability(_config(), "/nonexistent", progress=None)

        assert "Q" * 20 not in capfd.readouterr().out

    def test_refusal_excerpt_redacts_before_cutting(self):
        token = "ghs_" + "R" * 300
        line = repo._quoted_line(
            [f"remote: Permission to owner/repo.git denied. {token}"], ("permission to",)
        )

        assert "R" * 20 not in line
        assert len(line) <= 200

    def test_setup_failure_snippet_redacts_before_cutting(self):
        import pytest

        token = "ghs_" + "S" * 600
        with pytest.raises(RuntimeError) as excinfo:
            repo._fail_setup_command("push-preflight", "owner/repo", f"fatal: odd {token}", None)

        assert "S" * 20 not in str(excinfo.value)


class TestPushRefusalFitsTheTaskRecord:
    def test_longest_refusal_fits(self):
        repo_url = f"{'o' * 39}/{'r' * 100}"
        stderr = f"remote: Permission to {repo_url}.git denied to someone. {'x' * 300}"
        refusal = repo._push_refusal(_config(repo_url=repo_url, github_token=""), stderr)

        persisted = f"PushCapabilityError: {refusal}"
        assert len(persisted) <= 1000, len(persisted)
        assert "The task stopped before the agent ran" in persisted[:1000]


class TestPushPreflightRetries:
    def _run(self, monkeypatch, stderr):
        import pytest

        attempts = []

        def fake_run_cmd(cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            if label == "push-preflight":
                attempts.append(cmd)
                return SimpleNamespace(returncode=128, stdout="", stderr=stderr)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        import functools

        import shell

        sleeps = []
        monkeypatch.setattr("shell.run_cmd", fake_run_cmd)
        monkeypatch.setattr(
            repo,
            "run_cmd_with_backoff",
            functools.partial(shell.run_cmd_with_backoff, sleep=sleeps.append),
        )
        monkeypatch.setattr(repo, "_preflight_probe_commit", lambda repo_dir: _PROBE_SHA)
        with pytest.raises(RuntimeError):
            repo._preflight_push_capability(_config(), "/nonexistent", progress=None)
        return attempts, sleeps

    def test_refusal_takes_one_attempt(self, monkeypatch):
        attempts, sleeps = self._run(monkeypatch, _DENIED_403)

        assert len(attempts) == 1
        assert sleeps == []

    def test_outage_is_retried(self, monkeypatch):
        attempts, sleeps = self._run(monkeypatch, _BAD_GATEWAY.format(repo="owner/repo"))

        assert len(attempts) == 3
        assert len(sleeps) == 2


class TestPushPreflightAgainstRealGit:
    @staticmethod
    def _git(*args, cwd):
        return subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
        ).stdout

    def _remote_and_clone(self, tmp_path, monkeypatch, *, empty=False):
        monkeypatch.setenv("GIT_AUTHOR_NAME", "t")
        monkeypatch.setenv("GIT_AUTHOR_EMAIL", "t@example.com")
        monkeypatch.setenv("GIT_COMMITTER_NAME", "t")
        monkeypatch.setenv("GIT_COMMITTER_EMAIL", "t@example.com")
        remote = tmp_path / "remote.git"
        self._git("init", "--bare", "-q", "-b", "main", str(remote), cwd=tmp_path)
        if not empty:
            seed = tmp_path / "seed"
            self._git("init", "-q", str(seed), cwd=tmp_path)
            self._git("commit", "-q", "--allow-empty", "-m", "init", cwd=seed)
            self._git("push", "-q", str(remote), "HEAD:refs/heads/main", cwd=seed)
        work = tmp_path / "work"
        self._git("clone", "-q", str(remote), str(work), cwd=tmp_path)
        return remote, work

    def test_dry_run_creates_no_ref_and_leaves_the_clone_alone(self, tmp_path, monkeypatch):
        remote, work = self._remote_and_clone(tmp_path, monkeypatch)
        refs_before = self._git("for-each-ref", cwd=remote)
        head_before = self._git("rev-parse", "HEAD", cwd=work)
        config_before = (work / ".git" / "config").read_text()

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert self._git("for-each-ref", cwd=remote) == refs_before
        assert "bgagent-push-preflight" not in refs_before
        assert self._git("rev-parse", "HEAD", cwd=work) == head_before
        assert self._git("status", "--porcelain", cwd=work) == ""
        assert (work / ".git" / "config").read_text() == config_before

    def test_dry_run_reaches_the_remote(self, tmp_path, monkeypatch):
        import pytest

        _, work = self._remote_and_clone(tmp_path, monkeypatch)
        self._git("remote", "set-url", "origin", str(tmp_path / "missing.git"), cwd=work)

        with pytest.raises(RuntimeError, match="push-preflight failed"):
            repo._preflight_push_capability(_config(), str(work), progress=None)

    def test_empty_repository_passes(self, tmp_path, monkeypatch):
        remote, work = self._remote_and_clone(tmp_path, monkeypatch, empty=True)

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert self._git("for-each-ref", cwd=remote) == ""

    def test_existing_ref_with_the_probe_name_does_not_block(self, tmp_path, monkeypatch):
        remote, work = self._remote_and_clone(tmp_path, monkeypatch)
        other = tmp_path / "other"
        self._git("init", "-q", str(other), cwd=tmp_path)
        self._git("commit", "-q", "--allow-empty", "-m", "unrelated", cwd=other)
        self._git("push", "-q", str(remote), "HEAD:refs/heads/bgagent-push-preflight", cwd=other)
        refs_before = self._git("for-each-ref", cwd=remote)

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert self._git("for-each-ref", cwd=remote) == refs_before

    def test_pre_push_hook_does_not_run(self, tmp_path, monkeypatch):
        _, work = self._remote_and_clone(tmp_path, monkeypatch)
        hooks = tmp_path / "hooks"
        hooks.mkdir()
        marker = tmp_path / "hook-ran"
        hook = hooks / "pre-push"
        hook.write_text(f"#!/bin/sh\ntouch {marker}\nexit 1\n")
        hook.chmod(0o755)
        self._git("config", "core.hooksPath", str(hooks), cwd=work)
        subprocess.run(
            ["git", "push", "--dry-run", "origin", "HEAD:refs/heads/x"],
            cwd=work,
            capture_output=True,
        )
        assert marker.exists()
        marker.unlink()

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert not marker.exists()

    def test_only_the_tasks_token_answers_for_github(self, tmp_path, monkeypatch):
        _, work = self._remote_and_clone(tmp_path, monkeypatch)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(
            "#!/bin/sh\ncat >/dev/null\necho username=task-token\necho password=x\n"
        )
        marker = tmp_path / "saved-login-asked"
        (bin_dir / "saved-login").write_text(
            f"#!/bin/sh\ncat >/dev/null\ntouch {marker}\n"
            "echo username=saved-login\necho password=y\n"
        )
        for f in bin_dir.iterdir():
            f.chmod(0o755)
        global_cfg = tmp_path / "global.gitconfig"
        global_cfg.write_text(
            f"[credential]\n\thelper = !{bin_dir}/saved-login\n"
            f'[credential "https://github.com"]\n\thelper = !{bin_dir}/saved-login\n'
        )
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_cfg))
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

        repo._configure_git_credentials(str(work), "owner/repo")

        filled = subprocess.run(
            ["git", "credential", "fill"],
            cwd=work,
            input="protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        ).stdout
        assert "username=task-token" in filled
        assert not marker.exists()

    def test_push_url_ignores_push_insteadof_and_a_rewrite_is_refused(self, tmp_path, monkeypatch):
        import pytest

        _, work = self._remote_and_clone(tmp_path, monkeypatch)
        global_cfg = tmp_path / "global.gitconfig"
        global_cfg.write_text('[url "git@github.com:"]\n\tpushInsteadOf = https://github.com/\n')
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_cfg))

        repo._configure_git_credentials(str(work), "owner/repo")

        push_url = self._git("remote", "get-url", "--push", "origin", cwd=work).strip()
        assert push_url == "https://github.com/owner/repo.git"

        # insteadOf rewrites even an explicit push URL.
        global_cfg.write_text('[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n')
        with pytest.raises(RuntimeError, match="rewrites the push URL"):
            repo._configure_git_credentials(str(work), "owner/repo")

    def test_helper_reset_is_scoped_to_github(self, tmp_path, monkeypatch):
        _, work = self._remote_and_clone(tmp_path, monkeypatch)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(
            "#!/bin/sh\ncat >/dev/null\necho username=task-token\necho password=x\n"
        )
        (bin_dir / "saved-login").write_text(
            "#!/bin/sh\ncat >/dev/null\necho username=saved-login\necho password=y\n"
        )
        for f in bin_dir.iterdir():
            f.chmod(0o755)
        global_cfg = tmp_path / "global.gitconfig"
        global_cfg.write_text(f"[credential]\n\thelper = !{bin_dir}/saved-login\n")
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_cfg))
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

        repo._configure_git_credentials(str(work), "owner/repo")

        def fill(host):
            return subprocess.run(
                ["git", "credential", "fill"],
                cwd=work,
                input=f"protocol=https\nhost={host}\n\n",
                capture_output=True,
                text=True,
                check=True,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            ).stdout

        assert "username=task-token" in fill("github.com")
        assert "username=saved-login" in fill("gitlab.example.com")
