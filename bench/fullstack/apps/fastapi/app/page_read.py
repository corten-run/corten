"""Marketplace page reads owned by the native ASGI request, including body reads."""
import asyncio

from fastapi import HTTPException
import httpx


async def read_page_record(request, source, record_id):
    async def disconnected():
        while (await request.receive())["type"] != "http.disconnect":
            pass

    read = asyncio.create_task(source.get(record_id))
    gone = asyncio.create_task(disconnected())
    try:
        # Keep the marketplace client's existing ten-second budget, but bound the
        # whole read as well as inactivity. A trickling response must also end.
        done, _ = await asyncio.wait({read, gone}, timeout=10, return_when=asyncio.FIRST_COMPLETED)
        if gone in done:
            raise HTTPException(status_code=503, detail="Request cancelled", headers={"Cache-Control": "private, no-store"})
        if read not in done:
            raise HTTPException(status_code=504, detail="Record source timed out", headers={"Cache-Control": "private, no-store"})
        try:
            return read.result()
        except httpx.TimeoutException as error:
            raise HTTPException(status_code=504, detail="Record source timed out", headers={"Cache-Control": "private, no-store"}) from error
    finally:
        for task in (read, gone):
            task.cancel()
        await asyncio.gather(read, gone, return_exceptions=True)
