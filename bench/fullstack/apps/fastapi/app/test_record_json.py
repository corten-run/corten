"""Opt-in trace evidence must preserve the JSON boundary's existing outcomes."""
import asyncio
from contextlib import redirect_stderr
from io import StringIO
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import APIRouter, FastAPI, HTTPException, Request
import httpx

from . import record_json
from .catalog import CatalogRecord


class TraceTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, get, *, tracing=True, disconnect=False):
        started = asyncio.Event()

        async def read(record_id):
            started.set()
            return await get(record_id)

        async def receive():
            await started.wait()
            if disconnect:
                return {"type": "http.disconnect"}
            await asyncio.Future()

        source = SimpleNamespace(get=read, client=SimpleNamespace(event_hooks={"request": []}))
        request = SimpleNamespace(url=SimpleNamespace(path="/api/catalog/record_1"), receive=receive,
                                  path_params={"record_id": "record_1"})

        async def native_handler(request):
            return await record_json.read_record(request, source, "record_1")

        with patch.object(record_json.APIRoute, "get_route_handler", return_value=native_handler):
            handler = record_json.RecordJsonRoute("/api/catalog/{record_id}", endpoint=native_handler).get_route_handler()
        output = StringIO()
        result = error = None
        with patch.object(record_json, "_tracing", tracing), redirect_stderr(output):
            try:
                result = await handler(request)
            except HTTPException as caught:
                error = caught
        # IsolatedAsyncioTestCase's debug loop can also write slow-task warnings here.
        events = [json.loads(line) for line in output.getvalue().splitlines()
                  if line.startswith('{"record_trace":')]
        self.assertEqual(record_json._trace_context.get(), {})
        return result, error, events, source

    async def test_success_is_unchanged_and_does_not_emit_trace(self):
        value = object()

        async def get(_):
            return value

        result, error, events, source = await self.exercise(get)
        self.assertIs(result, value)
        self.assertIsNone(error)
        self.assertEqual(events, [])
        self.assertEqual(source.client.event_hooks["request"], [record_json._trace_httpx])

    async def test_error_keeps_original_exception_and_flushes_context(self):
        original = httpx.RemoteProtocolError("diagnostic disconnect")

        async def get(_):
            request = httpx.Request("GET", "http://upstream/catalog/records/record_1")
            await record_json._trace_httpx(request)
            trace = request.extensions["trace"]
            await trace("http11.receive_response_headers.started", {})
            await trace("http11.receive_response_headers.failed", {"exception": original})
            raise original

        _, error, events, _ = await self.exercise(get)
        self.assertEqual(error.status_code, 502)
        self.assertIs(error.__cause__, original)
        failed = next(event for event in events if event["record_trace"] == "source.failed")
        self.assertEqual(failed["error"]["type"], "httpx.RemoteProtocolError")
        self.assertIn("diagnostic disconnect", failed["error"]["traceback"])
        self.assertEqual(len({event["trace"] for event in events}), 1)
        self.assertTrue(all(event["path"] == "/api/catalog/record_1" for event in events))
        upstream = next(event for event in events if event["record_trace"] == "httpx.request")
        self.assertEqual(upstream["upstream_path"], "/catalog/records/record_1")
        self.assertTrue(any(event["record_trace"].endswith("receive_response_headers.failed") for event in events))
        self.assertTrue(next(event for event in events if event["record_trace"] == "source.cleanup")["disconnect_cancelled"])
        self.assertEqual(events[-1]["record_trace"], "request.cleanup")

    async def test_caller_disconnect_cancels_owned_read(self):
        cancelled = asyncio.Event()

        async def get(_):
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        _, error, events, _ = await self.exercise(get, disconnect=True)
        self.assertEqual(error.status_code, 503)
        self.assertTrue(cancelled.is_set())
        self.assertTrue(any(event["record_trace"] == "caller.disconnect" for event in events))
        self.assertTrue(next(event for event in events if event["record_trace"] == "source.cleanup")["read_cancelled"])
        self.assertEqual(events[-1]["record_trace"], "request.cleanup")

    async def test_disabled_trace_does_not_attach_hook_or_log(self):
        original = httpx.ReadError("diagnostic read error")

        async def get(_):
            raise original

        with patch.object(record_json, "_error_trace", wraps=record_json._error_trace) as formatter:
            _, error, events, source = await self.exercise(get, tracing=False)
        formatter.assert_not_called()
        self.assertEqual(error.status_code, 502)
        self.assertIs(error.__cause__, original)
        self.assertEqual(events, [])
        self.assertEqual(source.client.event_hooks["request"], [])

    async def test_native_serialization_error_retains_request_trace(self):
        record = CatalogRecord(id="record_1", title="\ud800", subtitle="", description="",
                               tags=[], fields=[], related=[])

        async def get(_):
            return record

        source = SimpleNamespace(get=get, client=SimpleNamespace(event_hooks={"request": []}))
        app = FastAPI()
        routes = APIRouter(route_class=record_json.RecordJsonRoute)

        @routes.get("/api/catalog/{record_id}")
        async def endpoint(request: Request, record_id: str) -> CatalogRecord:
            return await record_json.read_record(request, source, record_id)

        app.include_router(routes)
        output = StringIO()
        with patch.object(record_json, "_tracing", True), redirect_stderr(output):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                response = await client.get("/api/catalog/record_1")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "Record source unavailable"})
        self.assertEqual(record_json._trace_context.get(), {})
        events = [json.loads(line) for line in output.getvalue().splitlines()
                  if line.startswith('{"record_trace":')]
        failed = [event for event in events if event["record_trace"] == "serialization.failed"]
        self.assertEqual(len(failed), 1, events)
        self.assertIn("PydanticSerializationError", failed[0]["error"]["type"])
        self.assertIn("PydanticSerializationError", failed[0]["error"]["traceback"])
        self.assertIn("serialize", failed[0]["error"]["traceback"])
        self.assertEqual(len({event["trace"] for event in events}), 1)
        self.assertTrue(all(event["record_id"] == "record_1" for event in events))
        self.assertTrue(any(event["record_trace"] == "source.complete" for event in events))
        self.assertEqual(events[-1]["record_trace"], "request.cleanup")

        with patch.object(record_json, "_tracing", False), redirect_stderr(StringIO()), \
                patch.object(record_json, "_error_trace", wraps=record_json._error_trace) as formatter:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                untraced = await client.get("/api/catalog/record_1")
        formatter.assert_not_called()
        self.assertEqual(untraced.status_code, response.status_code)
        self.assertEqual(untraced.content, response.content)
        self.assertEqual(record_json._trace_context.get(), {})

    async def test_route_restores_context_on_errors_and_cancellation(self):
        request = SimpleNamespace(url=SimpleNamespace(path="/api/catalog/record_1"),
                                  path_params={"record_id": "record_1"})
        for error in (HTTPException(status_code=404), ValueError("native failure"), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__):
                async def native_handler(request):
                    context = record_json._trace_context.get()
                    self.assertEqual(context["record_id"], "record_1")
                    self.assertIn("trace", context)
                    raise error

                with patch.object(record_json.APIRoute, "get_route_handler", return_value=native_handler):
                    handler = record_json.RecordJsonRoute("/api/catalog/{record_id}", endpoint=native_handler).get_route_handler()
                previous = {"trace": "outer"}
                token = record_json._trace_context.set(previous)
                try:
                    with patch.object(record_json, "_tracing", True), self.assertRaises(type(error)) as caught:
                        await handler(request)
                    self.assertIs(caught.exception, error)
                    self.assertIs(record_json._trace_context.get(), previous)
                finally:
                    record_json._trace_context.reset(token)

    async def test_disabled_httpx_trace_does_not_format(self):
        request = httpx.Request("GET", "http://upstream/catalog/records/record_1")
        with patch.object(record_json, "_tracing", True):
            await record_json._trace_httpx(request)
        with patch.object(record_json, "_tracing", False), \
                patch.object(record_json, "_error_trace", wraps=record_json._error_trace) as formatter:
            await request.extensions["trace"]("receive.failed", {"exception": httpx.ReadError("test")})
        formatter.assert_not_called()
