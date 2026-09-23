"""Git hosting provider abstraction.

Strategy-pattern dispatch for git clone, PR creation, and credential management
across GitHub and Bitbucket.
"""

from __future__ import annotations

import json
import subprocess
from typing import Literal, Protocol, runtime_checkable

GitProviderType = Literal["github", "bitbucket"]


@runtime_checkable
class GitProvider(Protocol):
    """Protocol for git hosting provider operations."""

    @property
    def name(self) -> GitProviderType: ...

    def clone_command(self, repo: str, dest: str) -> list[str]: ...

    def remote_url(self, repo: str) -> str: ...

    def credential_helper_config(self, token: str) -> list[list[str]]:
        """Return git config commands to set up credential helper."""
        ...

    def env_vars(self, token: str) -> dict[str, str]: ...

    def default_branch(self, repo: str, cwd: str | None = None) -> str | None: ...

    def create_pr(
        self,
        *,
        repo: str,
        branch: str,
        base: str,
        title: str,
        body: str,
        token: str,
        cwd: str | None = None,
    ) -> str | None:
        """Create a pull request. Returns the PR URL or None on failure."""
        ...

    def view_pr(self, *, repo: str, branch: str, token: str, cwd: str | None = None) -> dict | None:
        """View PR metadata for a branch. Returns dict with url, baseRefName, etc."""
        ...

    def comment_pr(self, *, repo: str, pr_id: str, body: str, token: str) -> bool:
        """Add a comment to a PR. Returns True on success."""
        ...

    def token_patterns(self) -> list[tuple[str, str]]:
        """Return (name, regex_pattern) pairs for secret scanning."""
        ...

    def host_domain(self) -> str: ...


class GitHubProvider:
    """GitHub implementation — wraps `gh` CLI."""

    @property
    def name(self) -> GitProviderType:
        return "github"

    def clone_command(self, repo: str, dest: str) -> list[str]:
        return ["gh", "repo", "clone", repo, dest]

    def remote_url(self, repo: str) -> str:
        return f"https://github.com/{repo}.git"

    def credential_helper_config(self, token: str) -> list[list[str]]:
        return [
            ["git", "config", "--local", "credential.helper", ""],
            ["git", "config", "--local", "credential.helper", "!gh auth git-credential"],
        ]

    def env_vars(self, token: str) -> dict[str, str]:
        return {"GITHUB_TOKEN": token, "GH_TOKEN": token}

    def default_branch(self, repo: str, cwd: str | None = None) -> str | None:
        try:
            cmd = [
                "gh",
                "repo",
                "view",
                repo,
                "--json",
                "defaultBranchRef",
                "-q",
                ".defaultBranchRef.name",
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=cwd,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except (subprocess.SubprocessError, OSError):
            pass
        return None

    def create_pr(
        self,
        *,
        repo: str,
        branch: str,
        base: str,
        title: str,
        body: str,
        token: str,
        cwd: str | None = None,
    ) -> str | None:
        cmd = [
            "gh",
            "pr",
            "create",
            "--repo",
            repo,
            "--head",
            branch,
            "--base",
            base,
            "--title",
            title,
            "--body",
            body,
        ]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=cwd,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except (subprocess.SubprocessError, OSError):
            pass
        return None

    def view_pr(self, *, repo: str, branch: str, token: str, cwd: str | None = None) -> dict | None:
        cmd = [
            "gh",
            "pr",
            "view",
            branch,
            "--repo",
            repo,
            "--json",
            "url,baseRefName,headRefName,number,state",
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=cwd)
            if result.returncode == 0:
                return json.loads(result.stdout)
        except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
            pass
        return None

    def comment_pr(self, *, repo: str, pr_id: str, body: str, token: str) -> bool:
        cmd = ["gh", "pr", "comment", pr_id, "--repo", repo, "--body", body]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            return result.returncode == 0
        except (subprocess.SubprocessError, OSError):
            return False

    def token_patterns(self) -> list[tuple[str, str]]:
        return [
            ("GITHUB_PAT", r"ghp_[A-Za-z0-9_]{36,}"),
            ("GITHUB_OAUTH", r"gho_[A-Za-z0-9_]{36,}"),
            ("GITHUB_APP", r"ghs_[A-Za-z0-9_]{36,}"),
            ("GITHUB_USER", r"ghu_[A-Za-z0-9_]{36,}"),
            ("GITHUB_REFRESH", r"ghr_[A-Za-z0-9_]{36,}"),
            ("GITHUB_FINE_GRAINED", r"github_pat_[A-Za-z0-9_]{22,}"),
        ]

    def host_domain(self) -> str:
        return "github.com"


class BitbucketProvider:
    """Bitbucket implementation — uses git + Bitbucket REST API 2.0."""

    @property
    def name(self) -> GitProviderType:
        return "bitbucket"

    def clone_command(self, repo: str, dest: str) -> list[str]:
        return ["git", "clone", f"https://bitbucket.org/{repo}.git", dest]

    def remote_url(self, repo: str) -> str:
        return f"https://bitbucket.org/{repo}.git"

    def credential_helper_config(self, token: str) -> list[list[str]]:
        helper_script = f'!f() {{ echo "username=x-token-auth"; echo "password={token}"; }}; f'
        return [
            ["git", "config", "--local", "credential.helper", ""],
            ["git", "config", "--local", "credential.helper", helper_script],
        ]

    def env_vars(self, token: str) -> dict[str, str]:
        return {"BITBUCKET_TOKEN": token}

    def default_branch(self, repo: str, cwd: str | None = None) -> str | None:
        try:
            result = subprocess.run(
                ["git", "remote", "show", "origin"],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=cwd,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if "HEAD branch:" in line:
                        return line.split(":")[-1].strip()
        except (subprocess.SubprocessError, OSError):
            pass
        return None

    def create_pr(
        self,
        *,
        repo: str,
        branch: str,
        base: str,
        title: str,
        body: str,
        token: str,
        cwd: str | None = None,
    ) -> str | None:
        import urllib.error
        import urllib.request

        url = f"https://api.bitbucket.org/2.0/repositories/{repo}/pullrequests"
        data = json.dumps(
            {
                "title": title,
                "description": body,
                "source": {"branch": {"name": branch}},
                "destination": {"branch": {"name": base}},
                "close_source_branch": False,
            }
        ).encode()
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310  # nosemgrep: dynamic-urllib-use-detected -- URL built from validated repo slug, not arbitrary user input
                result = json.loads(resp.read())
                links = result.get("links", {}).get("html", {})
                return links.get("href")
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return None

    def view_pr(
        self,
        *,
        repo: str,
        branch: str,
        token: str,
        cwd: str | None = None,
    ) -> dict | None:
        import urllib.error
        import urllib.parse
        import urllib.request

        query = urllib.parse.quote(
            f'source.branch.name="{branch}" AND state="OPEN"',
        )
        url = f"https://api.bitbucket.org/2.0/repositories/{repo}/pullrequests?q={query}"
        req = urllib.request.Request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310  # nosemgrep: dynamic-urllib-use-detected -- URL built from validated repo slug, not arbitrary user input
                result = json.loads(resp.read())
                values = result.get("values", [])
                if not values:
                    return None
                pr = values[0]
                return {
                    "url": pr.get("links", {}).get("html", {}).get("href", ""),
                    "baseRefName": pr.get("destination", {}).get("branch", {}).get("name", ""),
                    "headRefName": pr.get("source", {}).get("branch", {}).get("name", ""),
                    "number": pr.get("id"),
                    "state": pr.get("state", "").lower(),
                }
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return None

    def comment_pr(
        self,
        *,
        repo: str,
        pr_id: str,
        body: str,
        token: str,
    ) -> bool:
        import http
        import urllib.error
        import urllib.request

        url = f"https://api.bitbucket.org/2.0/repositories/{repo}/pullrequests/{pr_id}/comments"
        data = json.dumps({"content": {"raw": body}}).encode()
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310  # nosemgrep: dynamic-urllib-use-detected -- URL built from validated repo slug, not arbitrary user input
                return resp.status == http.HTTPStatus.CREATED
        except (urllib.error.URLError, OSError):
            return False

    def token_patterns(self) -> list[tuple[str, str]]:
        return [
            ("BITBUCKET_TOKEN_IN_URL", r"x-token-auth:[^\s@\"']+@bitbucket\.org"),
        ]

    def host_domain(self) -> str:
        return "bitbucket.org"


def get_provider(provider_type: str = "github") -> GitProvider:
    """Factory: return the appropriate provider instance."""
    if provider_type == "bitbucket":
        return BitbucketProvider()
    return GitHubProvider()
