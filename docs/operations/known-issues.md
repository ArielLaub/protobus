# Known Issues

Current limitations and potential improvements for ProtoBus.

## Minor Issues

### Cancellation and shutdown are cooperative

**Severity:** Low

**Description:**
Neither the processing timeout nor a stream cancellation can stop a handler
that is already running, because JavaScript cannot preempt one. Both abort the
handler's `AbortSignal` and stop the framework acting on a late result; a
handler that never checks its signal runs to completion regardless, and its
output is discarded.

A graceful shutdown waits for handlers to finish, so a handler that ignores its
signal and runs long will hold shutdown until `SHUTDOWN_DRAIN_TIMEOUT_MS`
elapses, at which point its messages stay unacknowledged and are redelivered.

**Workaround:**
Watch the signal in anything long-running:

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
async generateReport(request: Request, actor: string, id: string, ctx?: MessageHandlerContext) {
    for (const chunk of workItems) {
        if (ctx?.signal.aborted) { throw new Error('cancelled'); }
        await process(chunk);
    }
}
```

Graceful shutdown itself is built in: `RunnableService.start()` installs signal
handlers that stop consuming, drain in-flight work, run your `cleanup()` hook
and then disconnect. See [RunnableService](../reference/api/runnable-service.md).

---

### A failing event handler loses the event, unless retry is turned on

**Severity:** Medium

**Description:**
By default an event listener registers no retry options, so a handler that
throws takes the no-retry branch: the delivery is rejected without requeue and
the event is gone. It does not climb the retry ladder and never reaches a DLQ.

Rejecting is what keeps the consumer alive: leaving the delivery unacknowledged
would hold the prefetch (**1** unless `maxConcurrent` is set) and stall the
listener completely behind the first permanently-failing event. The default is
measured against a real broker in
[`test/integration/event_failure_semantics.test.ts`](../../test/integration/event_failure_semantics.test.ts)
and set out in full under
[Ack ordering](../concepts/delivery-guarantees.md#ack-ordering).

It stays listed here because the consequence is easy to miss when reading events
as "fire and forget": with the default there is no retry, no dead letter, and no
record afterwards that anything was dropped.

**Workaround:**
Set `eventRetry` on the service to give events the same ladder RPC requests
climb: park, redeliver, then `<Service>.Events.DLQ`. It is opt-in because it
declares new topology and because a retry re-runs every handler that matched the
event, not only the one that threw. See
[Turning retry on](../guide/events.md#turning-retry-on).

Left off, make the handler responsible for its own work: catch and record the
failure somewhere you can replay from, or model the work as an RPC instead.

---

### No Request Tracing

**Description:**
No built-in support for distributed tracing (e.g., OpenTelemetry, Jaeger).

**Workaround:**
Add tracing manually in your service methods:

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
async myMethod(request: any, actor?: string, correlationId?: string) {
    const span = tracer.startSpan('myMethod', { correlationId });
    try {
        const result = await this.doWork(request);
        span.end();
        return result;
    } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
    }
}
```

---

## Reporting Issues

If you encounter issues not listed here:

1. Check existing issues on GitHub
2. Include in your report:
   - ProtoBus version
   - Node.js version
   - RabbitMQ version
   - Minimal reproduction code
   - Error messages and stack traces

---

Next: [Troubleshooting](./troubleshooting.md) | [Architecture](../concepts/architecture.md)
