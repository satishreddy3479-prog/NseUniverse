"""Access control for operational (state-changing) endpoints.

Phase 1 has no user accounts, so control endpoints are accepted only from a
loopback client AND (when the browser sends one) an allow-listed Origin.
The server also refuses to bind to a non-loopback host (see app.__main__).
"""

from __future__ import annotations

import ipaddress

from fastapi import HTTPException, Request, status


def _is_loopback(host: str | None) -> bool:
    if host == "localhost":
        return True
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def require_local_control(request: Request) -> None:
    client_host = request.client.host if request.client else None
    if not _is_loopback(client_host):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            {"code": "forbidden", "message": "control endpoints are local-only"},
        )
    origin = request.headers.get("origin")
    allowed: list[str] = request.app.state.settings.origins()
    if origin is not None and origin not in allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, {"code": "forbidden_origin", "message": "origin not allowed"}
        )
