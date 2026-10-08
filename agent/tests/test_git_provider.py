# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for the git_provider abstraction."""

from __future__ import annotations

import pytest

from git_provider import (
    BitbucketProvider,
    GitHubProvider,
    GitProvider,
    get_provider,
)


class TestGetProvider:
    """Factory function tests."""

    def test_default_returns_github(self):
        provider = get_provider()
        assert isinstance(provider, GitHubProvider)

    def test_github_explicit(self):
        provider = get_provider("github")
        assert isinstance(provider, GitHubProvider)

    def test_bitbucket_explicit(self):
        provider = get_provider("bitbucket")
        assert isinstance(provider, BitbucketProvider)


class TestGitHubProvider:
    """GitHub provider implementation tests."""

    @pytest.fixture()
    def provider(self) -> GitHubProvider:
        return GitHubProvider()

    def test_name(self, provider: GitHubProvider):
        assert provider.name == "github"

    def test_clone_command(self, provider: GitHubProvider):
        cmd = provider.clone_command("owner/repo", "/tmp/dest")
        assert cmd == ["gh", "repo", "clone", "owner/repo", "/tmp/dest"]

    def test_remote_url(self, provider: GitHubProvider):
        url = provider.remote_url("owner/repo")
        assert url == "https://github.com/owner/repo.git"

    def test_env_vars(self, provider: GitHubProvider):
        env = provider.env_vars("my-token")
        assert env == {"GITHUB_TOKEN": "my-token", "GH_TOKEN": "my-token"}

    def test_host_domain(self, provider: GitHubProvider):
        assert provider.host_domain() == "github.com"

    def test_satisfies_protocol(self, provider: GitHubProvider):
        assert isinstance(provider, GitProvider)


class TestBitbucketProvider:
    """Bitbucket provider implementation tests."""

    @pytest.fixture()
    def provider(self) -> BitbucketProvider:
        return BitbucketProvider()

    def test_name(self, provider: BitbucketProvider):
        assert provider.name == "bitbucket"

    def test_clone_command(self, provider: BitbucketProvider):
        cmd = provider.clone_command("owner/repo", "/tmp/dest")
        assert cmd == ["git", "clone", "https://bitbucket.org/owner/repo.git", "/tmp/dest"]

    def test_remote_url(self, provider: BitbucketProvider):
        url = provider.remote_url("owner/repo")
        assert url == "https://bitbucket.org/owner/repo.git"

    def test_env_vars(self, provider: BitbucketProvider):
        env = provider.env_vars("bb-token")
        assert env == {"BITBUCKET_TOKEN": "bb-token"}

    def test_host_domain(self, provider: BitbucketProvider):
        assert provider.host_domain() == "bitbucket.org"

    def test_satisfies_protocol(self, provider: BitbucketProvider):
        assert isinstance(provider, GitProvider)
