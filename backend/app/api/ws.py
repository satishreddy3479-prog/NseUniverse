"""Application WebSocket: browser clients receive normalized updates from the single broker feed."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.security import _is_loopback
from app.stream.manager import StreamManager

router = APIRouter()
logger = logging.getLogger(__name__)
WS_IDLE_TIMEOUT_S = 30.0


@router.websocket("/ws/market-data")
async def market_data(ws: WebSocket) -> None:
    settings = ws.app.state.settings
    manager: StreamManager = ws.app.state.stream
    host = ws.client.host if ws.client else None
    origin = ws.headers.get("origin")
    if not _is_loopback(host) or (origin is not None and origin not in settings.origins()):
        await ws.close(code=1008)  # policy violation: remote client or foreign origin
        return
    sub = manager.hub.subscribe()
    if sub is None:
        await ws.close(code=1013)  # try again later: client limit reached
        return
    await ws.accept()
    try:
        await ws.send_json(manager.hello())

        async def sender() -> None:
            while True:
                msg = await sub.queue.get()
                await ws.send_json(msg)

        async def receiver() -> None:  # clients send nothing meaningful; this detects disconnects
            while True:
                await ws.receive_text()

        tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            with contextlib.suppress(WebSocketDisconnect, asyncio.CancelledError):
                t.result()
        if sub.dropped:
            await ws.close(code=1013)
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("ws_client_error", extra={"fields": {"exc_type": type(exc).__name__}})
    finally:
        manager.hub.unsubscribe(sub)
