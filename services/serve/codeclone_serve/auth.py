"""API key auth dependency."""

from __future__ import annotations

from fastapi import Header, HTTPException, status

from codeclone_config.settings import get_settings


def verify_api_key(authorization: str | None = Header(default=None)) -> str:
    """Accepts `Authorization: Bearer <key>` or `Authorization: <key>`.

    Raises 401 on mismatch.
    """
    expected = get_settings().api_key
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid api key",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token
