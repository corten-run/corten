import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
import httpx

from .page_read import read_page_record


class PageReadTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, outcome):
        started, stopped, listener_stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
        incoming = asyncio.Queue()

        async def get(record_id):
            self.assertEqual(record_id, "item_1")
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        async def receive():
            try:
                return await incoming.get()
            finally:
                listener_stopped.set()

        before = asyncio.all_tasks()
        source, request = SimpleNamespace(get=get), SimpleNamespace(receive=receive)
        if outcome == "deadline":
            native_wait = asyncio.wait

            async def expired(tasks, *, timeout, return_when):
                self.assertEqual(timeout, 10)
                await started.wait()
                return await native_wait(tasks, timeout=0, return_when=return_when)

            with patch("app.page_read.asyncio.wait", side_effect=expired):
                with self.assertRaises(HTTPException) as caught:
                    await read_page_record(request, source, "item_1")
            self.assertEqual(caught.exception.status_code, 504)
        else:
            task = asyncio.create_task(read_page_record(request, source, "item_1"))
            await started.wait()
            if outcome == "disconnect":
                incoming.put_nowait({"type": "http.disconnect"})
                with self.assertRaises(HTTPException) as caught:
                    await task
                self.assertEqual(caught.exception.status_code, 503)
            else:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        self.assertTrue(stopped.is_set())
        self.assertTrue(listener_stopped.is_set())
        self.assertEqual(asyncio.all_tasks(), before)

    async def test_disconnect_cancels_and_joins_the_source(self):
        await self.exercise("disconnect")

    async def test_whole_read_deadline_cancels_and_joins_the_source(self):
        await self.exercise("deadline")

    async def test_outer_cancellation_also_joins_owned_tasks(self):
        await self.exercise("outer cancellation")

    async def test_transport_timeout_is_a_generic_native_deadline(self):
        async def get(_):
            raise httpx.ReadTimeout("private upstream details")

        async def receive():
            await asyncio.Future()

        with self.assertRaises(HTTPException) as caught:
            await read_page_record(SimpleNamespace(receive=receive), SimpleNamespace(get=get), "item_1")
        self.assertEqual(caught.exception.status_code, 504)
        self.assertNotIn("private", caught.exception.detail)
