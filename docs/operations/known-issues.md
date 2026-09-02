# Known Issues

Current limitations and potential improvements for ProtoBus.

## Minor Issues

### Cancellation and shutdown are cooperative

**Severity:** Low

**Description:**
Neither the processing timeout nor a stream cancellation can stop a handler
that is already running — JavaScript cannot preempt one. Both abort the
handler's `AbortSignal` and stop the framework acting on a late result; a
handler that never checks its signal runs to completion regardless, and its
output is simply discarded.

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

Graceful shutdown itself is built in — `RunnableService.start()` installs signal
handlers that stop consuming, drain in-flight work, run your `cleanup()` hook
and then disconnect. See [RunnableService](../reference/api/runnable-service.md).

---

### A failing event handler loses the event

**Severity:** Medium

**Description:**
Event listeners ack late, but they register no retry options
([`lib/event_listener.ts`](../../lib/event_listener.ts) never overrides
`getRetryOptions`), so a handler that throws takes the no-retry branch: the
delivery is rejected without requeue and the event is gone. Events do not climb
the retry ladder and never reach a DLQ. RPC requests do both — this asymmetry
applies to events only.

This is deliberate, not a defect. Rejecting is what keeps the consumer alive:
leaving the delivery unacknowledged would hold the prefetch — **1** unless
`maxConcurrent` is set — and stall the listener completely behind the first
permanently-failing event. Losing that event is the trade for not deadlocking
the subscriber. The behaviour is measured against a real broker in
[`test/integration/event_failure_semantics.test.ts`](../../test/integration/event_failure_semantics.test.ts)
and set out in full under
[Ack ordering](../concepts/delivery-guarantees.md#ack-ordering).

It is listed here because the consequence is easy to miss when reading events as
"fire and forget": there is no retry, no dead letter, and no record afterwards
that anything was dropped.

**Workaround:**
If an event handler's work matters, make the handler responsible for it —
retry inside the handler, or write the work to a store the handler owns and
drive it from there. For work that must not be lost, use an RPC, which does
retry and does dead-letter.

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
