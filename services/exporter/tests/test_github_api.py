"""Test the GitHubClient against a respx-mocked GitHub API."""

import httpx
import pytest
import respx

from codeclone_exporter.github_api import GitHubClient


@respx.mock
def test_list_user_repos_paginates():
    page1 = [
        {
            "full_name": f"Sanjays2402/repo{i}",
            "clone_url": f"https://github.com/Sanjays2402/repo{i}.git",
            "default_branch": "main",
            "fork": False,
            "size": 100,
            "archived": False,
            "private": False,
        }
        for i in range(100)
    ]
    page2 = [
        {
            "full_name": "Sanjays2402/repoLast",
            "clone_url": "https://github.com/Sanjays2402/repoLast.git",
            "default_branch": "main",
            "fork": False,
            "size": 100,
            "archived": False,
            "private": False,
        }
    ]
    respx.get("https://api.github.com/users/Sanjays2402/repos").mock(
        side_effect=[httpx.Response(200, json=page1), httpx.Response(200, json=page2)]
    )
    with GitHubClient(token="t") as gh:
        repos = gh.list_user_repos("Sanjays2402")
    assert len(repos) == 101
    assert repos[-1].full_name == "Sanjays2402/repoLast"


@respx.mock
def test_list_user_repos_skips_forks_by_default():
    payload = [
        {
            "full_name": "Sanjays2402/fork-of-x",
            "clone_url": "https://github.com/Sanjays2402/fork-of-x.git",
            "default_branch": "main",
            "fork": True,
            "size": 1,
            "archived": False,
            "private": False,
        },
        {
            "full_name": "Sanjays2402/owned",
            "clone_url": "https://github.com/Sanjays2402/owned.git",
            "default_branch": "main",
            "fork": False,
            "size": 1,
            "archived": False,
            "private": False,
        },
    ]
    respx.get("https://api.github.com/users/Sanjays2402/repos").mock(
        return_value=httpx.Response(200, json=payload)
    )
    with GitHubClient(token="t") as gh:
        repos = gh.list_user_repos("Sanjays2402")
    assert [r.full_name for r in repos] == ["Sanjays2402/owned"]
