# Error Handling

> Which failures protobus retries, which it answers, and how each one reaches the caller.

**Read this if** you are writing a handler and need to decide what to throw — or you have a message stuck in a retry loop.

| | |
|---|---|
| **Prerequisites** | [Getting Started](./getting-started.md) |
| **Next** | [Delivery Guarantees](../concepts/delivery-guarantees.md) — the mechanism · [Errors reference](../reference/errors.md) — every class |
| **Source** | [`lib/errors.ts`](../../lib/errors.ts) · [`lib/message_service.ts`](../../lib/message_service.ts) · [`lib/connection.ts`](../../lib/connection.ts) |

**On this page** — [The one decision](#the-one-decision) · [Terminal failures](#terminal-failures-handlederror) · [Retriable failures](#retriable-failures-anything-else) · [What the caller sees](#what-the-caller-sees) · [Tuning the ladder](#tuning-the-retry-ladder) · [Events are different](#events-are-different) · [Anti-patterns](#anti-patterns)

---

## The one decision

Every throw from a handler answers a single question: **would running this again produce a different result?**

| Answer | Throw | What protobus does |
|---|---|---|
| No — the same input fails the same way | `HandledError` | replies to the caller immediately, rejects the message without requeue. **No retry.** |
| Maybe — a dependency was briefly unavailable | any other `Error` | parks the message on `<Service>.Retry` and redelivers it, up to `maxRetries` times, then dead-letters it |

Getting this wrong is expensive in both directions. A validation failure thrown as
a plain `Error` retries four times over fifteen seconds and dead-letters a message
that was never going to succeed; a genuine outage thrown as a `HandledError`
fails a request that a second attempt would have served.

---

## Terminal failures: `HandledError`

<!-- doc-check: compile -->
```typescript
import { HandledError, RunnableService } from 'protobus';

export class OrderService extends RunnableService {
    public get ServiceName(): string { return 'Orders.Service'; }

    async createOrder(request: { orderId?: string }): Promise<{ ok: boolean }> {
        if (!request.orderId) {
            throw new HandledError('orderId is required', 'VALIDATION_ERROR');
        }
        return { ok: true };
    }
}
```

Use it for anything the caller could fix and a retry could not: invalid input, a
resource that does not exist, a permission denial, a business rule violation.

Subclass it when you want the code in one place:

<!-- doc-check: compile -->
```typescript
import { HandledError } from 'protobus';

export class ValidationError extends HandledError {
    constructor(message: string) { super(message, 'VALIDATION_ERROR'); }
}

export class NotFoundError extends HandledError {
    constructor(resource: string, id: string) {
        super(`${resource} ${id} not found`, 'NOT_FOUND');
    }
}
```

> [!NOTE]
> `isHandledError(err)` is duck-typed — it accepts anything with
> `isHandled === true` ([`lib/errors.ts`](../../lib/errors.ts)). An error crossing
> a module boundary, or one from a differently-installed copy of protobus, still
> classifies correctly.

---

## Retriable failures: anything else

<!-- doc-check: compile -->
```typescript
import { RunnableService } from 'protobus';

export class ReportService extends RunnableService {
    public get ServiceName(): string { return 'Reports.Service'; }

    async build(request: { id: string }): Promise<{ url: string }> {
        const upstream = await fetch('https://example.invalid/' + request.id);
        if (upstream.status >= 500) {
            // Plain Error: the upstream may well be back in five seconds.
            throw new Error(`upstream returned ${upstream.status}`);
        }
        return { url: await upstream.text() };
    }
}
```

The failure then climbs the retry ladder: `<Service>.Retry` holds the message for
`retryDelayMs`, its TTL expires, the dead-letter exchange returns it to the
service's own queue, and the handler runs again. After `maxRetries` failures the
message goes to `<Service>.DLQ` carrying headers that say why.

> [!IMPORTANT]
> **The caller stays parked for the whole ladder.** No reply is published while a
> message is being retried, so with the defaults — `maxRetries: 3`,
> `retryDelayMs: 5000` — a permanently failing call blocks its caller for roughly
> **15 seconds** before it is told anything. The full mechanism, the six `x-*`
> headers, and how this interacts with `RPC_CALL_TIMEOUT_MS` are in
> [Delivery Guarantees](../concepts/delivery-guarantees.md).

---

## What the caller sees

A `ServiceProxy` call rejects with a **plain `Error`** carrying `message` and
`code` — not an instance of your class. The class does not survive the wire; the
`code` you set on `HandledError` does.

<!-- doc-check: compile -->
```typescript
import { ServiceProxy } from 'protobus';

interface Orders {
    createOrder(request: { orderId?: string }): Promise<{ ok: boolean }>;
}

export async function create(proxy: ServiceProxy & Orders, orderId?: string) {
    try {
        return await proxy.createOrder({ orderId });
    } catch (error) {
        // Switch on the code you set, not on the error's class or its text.
        switch ((error as { code?: string }).code) {
            case 'VALIDATION_ERROR': return null;
            case 'NOT_FOUND': return null;
            default: throw error;
        }
    }
}
```

> [!WARNING]
> **Do not match on `error.message` text, and do not `JSON.parse` it.** An earlier
> version of this page suggested both. The message is a plain string, never JSON,
> and matching substrings breaks the first time someone rewords a message. `code`
> exists precisely so you do not have to.

What reaches the caller for a *non*-`HandledError` depends on
`PROTOBUS_EXPOSE_INTERNAL_ERRORS`, which defaults to `true` — the unhandled
error's own message is sent. Set it to `false` and the caller gets an
`InternalServiceError` carrying a correlation id instead. See
[Security](../operations/security.md) and [Configuration](../reference/configuration.md).

---

## Tuning the retry ladder

<!-- doc-check: compile -->
```typescript
import { RunnableService, IContext } from 'protobus';

export class OrdersService extends RunnableService {
    public get ServiceName(): string { return 'Orders.Service'; }

    constructor(context: IContext) {
        super(context, {
            maxConcurrent: 4,
            retry: {
                maxRetries: 5,      // default 3
                retryDelayMs: 2000, // default 5000
            },
        });
    }
}
```

| Option | Default | Effect |
|---|---:|---|
| `maxRetries` | `3` | attempts after the first failure. **`0` disables retry entirely** — no `.Retry` or `.DLQ` queue is declared, and a failure is answered and rejected |
| `retryDelayMs` | `5000` | the TTL on `<Service>.Retry`, so the delay is fixed, not exponential |
| `messageTtlMs` | none | a total lifetime for the message; past it the broker discards it regardless of retries left |

> [!CAUTION]
> `retryDelayMs` becomes the retry queue's `x-message-ttl`, and RabbitMQ refuses
> to redeclare a queue with different arguments. Changing it against an existing
> deployment raises `RetryQueueMismatchError`. See
> [Queue Migration](../operations/queue-migration.md).

---

## Events are different

> [!CAUTION]
> **A failing event handler is not retried, and the event is not dead-lettered —
> it is discarded.** `EventListener` never supplies retry options
> ([`lib/event_listener.ts`](../../lib/event_listener.ts), and the base
> `getRetryOptions()` in [`lib/base_listener.ts`](../../lib/base_listener.ts)
> returns `undefined`), so a throw takes the reject-without-requeue branch in
> [`lib/connection.ts`](../../lib/connection.ts) and leaves only a logged error
> behind. The `<Service>.Events` queue being durable does not change this.

That makes an event handler's error policy your responsibility:

<!-- doc-check: compile -->
```typescript
import { RunnableService } from 'protobus';

export class OrderProjection extends RunnableService {
    public get ServiceName(): string { return 'Orders.Projection'; }

    async init(): Promise<void> {
        await super.init();
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.project(event);
            } catch (error) {
                // Nothing downstream will retry this. Persist enough to
                // reprocess deliberately, and do not rethrow expecting a requeue.
                await this.recordFailure(event, error);
            }
        });
    }

    private async project(_event: unknown): Promise<void> { /* ... */ }
    private async recordFailure(_event: unknown, _error: unknown): Promise<void> { /* ... */ }
}
```

If an event genuinely needs at-least-once processing with retries, model it as an
RPC to a service that owns the work, and let the request queue's ladder do its
job.

---

## Anti-patterns

**Republishing the event to retry it yourself.** An earlier version of this page
showed incrementing an `event._retryCount` field and republishing. There is no
`_retryCount` on the wire, the republished event is a new message that every
other subscriber also receives again, and it competes with nothing. If you need
delayed reprocessing, write the failure down and reprocess from your own store.

**Wrapping everything in `try/catch` and returning a success shape.** A handler
that swallows a failure and returns `{ ok: false }` is invisible to the retry
ladder, to the DLQ, and to every metric derived from them. Throw.

**Catching an error only to rethrow a `HandledError`.** That converts a
transient failure into a permanent one. Only do it when you have established the
failure is not transient.

**A hand-rolled circuit breaker around a proxy call.** Reasonable in general, but
it belongs in your application code and is not protobus-specific — see
[Patterns](./patterns.md#resilience-patterns).

---

<div align="center">

**[← Events](./events.md)** · **[Docs index](../README.md)** · **[Delivery Guarantees →](../concepts/delivery-guarantees.md)**

</div>
