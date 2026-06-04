#!/usr/bin/env python
"""
Long-running Python streaming-service fixture used by the cross-language
integration test (protobus/test/integration/cross-language.test.ts).

Implements the same `streaming_test.Counter` service the per-language tests
exercise, but as a standalone script so a TS test runner can spawn it,
drive it over RabbitMQ, and tear it down.

Signals readiness by printing "READY\\n" on stdout, then blocks until SIGTERM
or SIGINT.
"""

import asyncio
import os
import signal
import sys
from typing import AsyncIterator

from protobus import Context, MessageService
from protobus.errors import HandledError


RMQ = os.environ.get("PROTOBUS_TEST_AMQP", "amqp://guest:guest@127.0.0.1:5672/")
PROTO_DIR = os.environ.get(
    "PROTOBUS_TEST_PROTO_DIR",
    os.path.join(os.path.dirname(__file__), "proto"),
)


class CounterService(MessageService):
    @property
    def service_name(self) -> str:
        return "streaming_test.Counter"

    @property
    def proto_file_name(self) -> str:
        return "streaming_test.proto"

    @property
    def Proto(self) -> str:
        with open(os.path.join(PROTO_DIR, "streaming_test.proto")) as f:
            return f.read()

    async def add(self, data: dict, actor: str, correlation_id: str) -> dict:
        a = data.get("a", 0)
        b = data.get("b", 0)
        return {"sum": (a or 0) + (b or 0)}

    async def tick(self, data: dict, actor: str, correlation_id: str) -> AsyncIterator[dict]:
        count = int(data.get("count", 0) or 0)
        fail_at = int(data.get("fail_at", 0) or 0)
        emit_nothing = bool(data.get("emit_nothing", False))

        if emit_nothing:
            return

        for i in range(count):
            if fail_at and i >= fail_at:
                raise HandledError(
                    f"deliberate failure at chunk {i}", code="TEST_FAIL"
                )
            yield {"seq": i, "payload": f"chunk-{i}"}


async def main():
    ctx = Context()
    await ctx.init(RMQ, proto_dirs=[PROTO_DIR])
    svc = CounterService(ctx)
    await svc.init()

    # Single-line "READY" sentinel so the parent test runner can wait
    # deterministically instead of polling. Flush so it's visible immediately.
    print("READY", flush=True)

    stop = asyncio.Event()

    def _shutdown() -> None:
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _shutdown)

    await stop.wait()
    await ctx.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
