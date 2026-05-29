"""GitHub REST API helpers (thin wrapper over httpx for testability)."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Iterator

import httpx


class GitHubError(RuntimeError):
    pass


@dataclass
class RepoSummary:
    full_name: str
    clone_url: str
    default_branch: str
    fork: bool
    size_kb: int
    archived: bool
    private: bool


class GitHubClient:
    """Minimal client for listing user repos and reading verified emails.

    Designed to be easy to swap with `respx` in tests.
    """

    BASE = "https://api.github.com"

    def __init__(
        self,
        token: str | None = None,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
        base_url: str | None = None,
    ) -> None:
        self.token = token
        self.base_url = base_url or self.BASE
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "codeclone/0.1",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "GitHubClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _get(self, path: str, params: dict[str, Any] | None = None) -> httpx.Response:
        resp = self._client.get(path, params=params)
        if resp.status_code == 403 and "rate limit" in resp.text.lower():
            reset = resp.headers.get("X-RateLimit-Reset")
            wait = max(0, int(reset) - int(time.time())) if reset else 30
            raise GitHubError(f"rate limited; resets in {wait}s")
        if resp.status_code >= 400:
            raise GitHubError(f"GET {path} -> {resp.status_code}: {resp.text[:200]}")
        return resp

    def list_user_repos(
        self,
        user: str,
        include_forks: bool = False,
        max_repos: int | None = None,
    ) -> list[RepoSummary]:
        out: list[RepoSummary] = []
        page = 1
        per_page = 100
        while True:
            resp = self._get(
                f"/users/{user}/repos",
                params={"per_page": per_page, "page": page, "type": "owner", "sort": "updated"},
            )
            data = resp.json()
            if not isinstance(data, list) or not data:
                break
            for r in data:
                if r.get("fork") and not include_forks:
                    continue
                out.append(
                    RepoSummary(
                        full_name=r["full_name"],
                        clone_url=r.get("clone_url", ""),
                        default_branch=r.get("default_branch") or "main",
                        fork=bool(r.get("fork")),
                        size_kb=int(r.get("size") or 0),
                        archived=bool(r.get("archived")),
                        private=bool(r.get("private")),
                    )
                )
                if max_repos is not None and len(out) >= max_repos:
                    return out
            if len(data) < per_page:
                break
            page += 1
        return out

    def verified_emails(self) -> list[str]:
        """Authenticated user's verified emails. Returns [] on unauthenticated."""
        if not self.token:
            return []
        try:
            resp = self._get("/user/emails")
        except GitHubError:
            return []
        out = []
        for entry in resp.json():
            if entry.get("verified") and entry.get("email"):
                out.append(entry["email"].lower())
        return out

    def iter_user_events(self, user: str) -> Iterator[dict[str, Any]]:
        page = 1
        while True:
            try:
                resp = self._get(
                    f"/users/{user}/events/public",
                    params={"per_page": 100, "page": page},
                )
            except GitHubError:
                return
            data = resp.json()
            if not isinstance(data, list) or not data:
                return
            for e in data:
                yield e
            if len(data) < 100 or page >= 10:
                return
            page += 1
