"""Request-owned work for record JSON only, including the entire upstream body read."""
import asyncio
from contextvars import ContextVar
import json
import os
import sys
import time
import traceback

from fastapi import HTTPException, Request
from fastapi.routing import APIRoute
from pydantic_core import PydanticSerializationError


_tracing = os.environ.get("RECORD_JSON_TRACE") == "1"
_trace_context = ContextVar("record_json_trace", default={})


def _trace(event, **details):
    if _tracing:
        context = _trace_context.get()
        value = {"record_trace": event, "at": time.time(), "monotonic": time.monotonic(),
                 **{key: value for key, value in context.items() if not key.startswith("_")}, **details}
        events = context.get("_events", [])
        failed = (event.endswith(".failed") or event == "caller.disconnect"
                  or (event == "wait.complete" and not details.get("read_done")))
        if failed:
            context["_emitted"] = True
            for previous in events:
                print(json.dumps(previous), file=sys.stderr, flush=True)
            events.clear()
        elif not context.get("_emitted"):
            events.append(value)
            return
        print(json.dumps(value), file=sys.stderr, flush=True)


def _error_trace(error):
    return {"type": f"{type(error).__module__}.{type(error).__name__}",
            "traceback": "".join(traceback.format_exception(error))}


async def _trace_httpx(request):
    if not _tracing:
        return

    async def trace(event, info):
        if not _tracing:
            return
        details = {key: value for key, value in info.items() if isinstance(value, (str, int, float, bool, type(None)))}
        if isinstance(info.get("exception"), BaseException):
            details["error"] = _error_trace(info["exception"])
        stream = info.get("return_value")
        if hasattr(stream, "get_extra_info"):
            details["client_addr"] = stream.get_extra_info("client_addr")
            details["server_addr"] = stream.get_extra_info("server_addr")
        _trace("httpx." + event, **details)

    request.extensions["trace"] = trace
    _trace("httpx.request", method=request.method, upstream_path=request.url.path)


class RecordJsonRoute(APIRoute):
    def get_route_handler(self):
        native_handler = super().get_route_handler()

        async def handle(request: Request):
            token = None
            if _tracing:
                token = _trace_context.set({"trace": f"{time.monotonic_ns():x}", "path": request.url.path,
                                            "record_id": request.path_params.get("record_id"), "_events": []})
            try:
                return await native_handler(request)
            except PydanticSerializationError as error:
                if _tracing:
                    _trace("serialization.failed", error=_error_trace(error))
                raise HTTPException(status_code=502, detail="Record source unavailable") from error
            finally:
                if token is not None:
                    try:
                        _trace("request.cleanup")
                    finally:
                        _trace_context.reset(token)

        return handle


async def read_record(request: Request, source, record_id: str):
    if _tracing:
        if _trace_httpx not in source.client.event_hooks["request"]:
            source.client.event_hooks["request"].append(_trace_httpx)
        _trace("source.start", source=type(source).__name__)

    async def disconnected():
        while (await request.receive())["type"] != "http.disconnect":
            pass
        _trace("caller.disconnect")

    read = asyncio.create_task(source.get(record_id))
    gone = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait({read, gone}, timeout=10, return_when=asyncio.FIRST_COMPLETED)
        _trace("wait.complete", read_done=read in done, disconnect_done=gone in done)
        if gone in done:
            raise HTTPException(status_code=503, detail="Request cancelled")
        if read not in done:
            raise HTTPException(status_code=504, detail="Record source timed out")
        try:
            record = read.result()
        except Exception as error:
            if _tracing:
                _trace("source.failed", error=_error_trace(error))
            raise HTTPException(status_code=502, detail="Record source unavailable") from error
        if record is None:
            raise HTTPException(status_code=404, detail="Record not found")
        _trace("source.complete")
        return record
    finally:
        for task in (read, gone):
            task.cancel()
        await asyncio.gather(read, gone, return_exceptions=True)
        _trace("source.cleanup", read_cancelled=read.cancelled(), disconnect_cancelled=gone.cancelled())
