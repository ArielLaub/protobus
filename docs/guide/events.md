# Events

> Publish/subscribe on the bus: emitting an event, receiving one, and the four things about it that catch people out.

**Read this if** you want one service to tell others that something happened without waiting for them to deal with it.

| | |
|---|---|
| **Prerequisites** | [Getting Started](./getting-started.md) — a service that runs · [Schema](./schema.md) |
| **Next** | [Error Handling](./error-handling.md) · [Message Flow](../concepts/message-flow.md) — the event on the wire |
| **Source** | [`lib/event_dispatcher.ts`](../../lib/event_dispatcher.ts) · [`lib/event_listener.ts`](../../lib/event_listener.ts) · [`lib/message_service.ts`](../../lib/message_service.ts) · [`lib/trie.ts`](../../lib/trie.ts) |

**On this page** — [The shape of it](#the-shape-of-it) · [A subscriber needs a service block](#a-subscriber-still-needs-a-service-block) · [Publishing](#publishing) · [Subscribing](#subscribing) · [Topics route, types do not](#topics-route-types-do-not) · [Wildcards](#wildcard-patterns) · [Several handlers](#several-handlers-one-topic) · [When a handler throws](#when-a-handler-throws) · [What survives what](#what-survives-what) · [A subscriber that is not a service](#a-subscriber-that-is-not-a-service) · [Worked example](#worked-example)

---

## The shape of it

An event is one-way. The publisher does not know who is listening, does not wait, and is never told whether anyone processed it.

```mermaid
flowchart LR
    S["OrderService<br/>publishEvent"] --> X{{"proto.bus.events<br/>topic exchange"}}
    X -->|"EVENT.Orders.OrderCreated"| Q1[("Notifications.Service.Events")]
    X -->|"EVENT.Orders.OrderCreated"| Q2[("Analytics.Service.Events")]
    X -->|"no matching binding"| N["dropped by the broker"]
    Q1 --> H1["handler"]
    Q2 --> H2["handler"]

    style N fill:#9a6700,color:#fff,stroke:#9a6700
```

Each subscribing **service** has one durable queue named `<ServiceName>.Events`, and its replicas compete for it — an event is handled once per service, not once per replica. Events published while every replica of a service is down are waiting in that queue when one comes back.

> [!NOTE]
> Events are published without AMQP's `mandatory` flag, deliberately. An event nobody has subscribed to is discarded by the broker in silence, and that is normal rather than an error. Publishing an event proves nothing about it having been received.

---

## A subscriber still needs a `service` block

This is the first thing that goes wrong, and until recently it appeared nowhere in these docs.

Protobus resolves a class's contract by looking `ServiceName` up in the loaded schema — `resolveContract` in [`lib/message_service.ts`](../../lib/message_service.ts) trims segments from the right until one names a `service`. A class with no matching `service` anywhere throws at `init()`:

```
MissingProto: no service in the schema matches 'Notifications.Service' or any
prefix of it; the .proto must declare the service this class serves
```

That holds even when the class implements no RPCs at all and only ever subscribes. An empty block is enough:

<!-- doc-check: proto id=ev-proto -->
```protobuf
syntax = "proto3";
package Notifications;

// No rpcs. It exists so resolveContract can find 'Notifications.Service'.
service Service {
}
```

and the class alongside it:

<!-- doc-check: compile id=ev-subscriber-class -->
```typescript
import { RunnableService } from 'protobus';

class NotificationService extends RunnableService {
    public get ServiceName(): string { return 'Notifications.Service'; }

    public async init(): Promise<void> {
        // Must come first. subscribeEvent binds a queue that does not exist
        // until MessageService.init() has declared it.
        await super.init();

        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            console.log(`order ${event.order_id} for user ${event.user_id}`);
        });
    }
}
```

> [!IMPORTANT]
> **Order matters.** `subscribeEvent` binds a routing key on the listener's queue and channel, both of which are created by `MessageService.init()`. Calling it before `super.init()` throws.

---

## Publishing

`publishEvent` is a method on `MessageService`, so it is available anywhere inside a service.

```
publishEvent(type: string, content: any, topic?: string): Promise<void>
```

| Argument | Meaning |
|---|---|
| `type` | the fully qualified **message** type — `<Package>.<MessageType>`. It must be a message in the loaded schema; it is not part of any `service` block. |
| `content` | a plain object matching that message. Field names follow the `.proto` exactly: protobus parses with `keepCase: true`, so `order_id` stays `order_id`. |
| `topic` | the routing key. Omit it and it defaults to `EVENT.<type>`. |

<!-- doc-check: compile id=ev-order-service -->
```typescript
import { RunnableService } from 'protobus';

class OrderService extends RunnableService {
    public get ServiceName(): string { return 'Orders.Service'; }

    async createOrder(request: { user_id: string }): Promise<{ order_id: string }> {
        const orderId = 'ord-123';

        // Default topic: EVENT.Orders.OrderCreated
        await this.publishEvent('Orders.OrderCreated', {
            order_id: orderId,
            user_id: request.user_id,
        });

        return { order_id: orderId };
    }

    async shipOrder(request: { order_id: string; region: string }): Promise<{ ok: boolean }> {
        // Custom topic, so subscribers can filter by region without decoding.
        await this.publishEvent(
            'Orders.OrderShipped',
            { order_id: request.order_id },
            `ORDERS.${request.region}.SHIPPED`,
        );

        return { ok: true };
    }
}
```

The publish resolves once the broker has confirmed the message. It does **not** wait for any subscriber. A failure to encode the event throws `InvalidMessageError` and the payload never reaches the log.

> [!TIP]
> Put everything a subscriber needs *in* the event. A subscriber that has to call back to ask "and what were the line items?" has turned an event into a slower RPC, and couples the two services in the direction the event was meant to decouple.

---

## Subscribing

```
subscribeEvent(type: string, handler: EventHandler, topic?: string): Promise<any>
```

The handler takes **three** arguments, not one:

<!-- doc-check: compile -->
```typescript
// lib/event_listener.ts. Not exported from the package root, so declare it
// yourself if you need a named handler rather than an inline arrow function.
type EventHandler = (event: any, type: string, topic: string) => Promise<void>;
```

| Argument | What it is |
|---|---|
| `event` | the decoded payload |
| `type` | the event type as carried in the envelope, e.g. `Orders.OrderShipped` |
| `topic` | the topic **from the envelope body**, which is not always the routing key the delivery matched |

An inline arrow function may take fewer arguments; TypeScript contextually types the ones it declares.

<!-- doc-check: compile id=ev-subscriptions -->
```typescript
import { RunnableService } from 'protobus';

class AnalyticsService extends RunnableService {
    public get ServiceName(): string { return 'Analytics.Service'; }

    public async init(): Promise<void> {
        await super.init();

        // Default topic: binds EVENT.Orders.OrderCreated.
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            console.log('created', event.order_id);
        });

        // Explicit topic with a wildcard: binds ORDERS.*.SHIPPED.
        await this.subscribeEvent('Orders.OrderShipped', async (event, type, topic) => {
            console.log(`${type} on ${topic}: ${event.order_id}`);
        }, 'ORDERS.*.SHIPPED');
    }
}
```

Each call does two things: it binds `topic` on this service's `.Events` queue, and it registers the handler under `topic` in an in-process [`Trie`](../../lib/trie.ts). The binding decides which messages reach the process; the trie decides which handlers run.

---

## Topics route, types do not

The single most misleading thing about the API is that `type` looks like a filter. It is not.

> [!WARNING]
> **When you pass a `topic`, the `type` argument to `subscribeEvent` is ignored for routing.** It is used only to compute the default topic when you omit one ([`lib/event_listener.ts`](../../lib/event_listener.ts), `subscribe`). Nothing anywhere compares an arriving event's type against the type you subscribed with. `subscribeEvent('Orders.OrderShipped', h, 'ORDERS.#')` runs `h` for **every** event published under a topic beginning `ORDERS.` — including `Orders.OrderCancelled`, and including a type from another team's package.

Two consequences worth designing around:

- **Guard on `type` inside a broad handler**, or give each event type a topic prefix that no other type shares.
- **A wildcard subscriber must have every type it can receive in its own schema.** The listener decodes with the type carried in the envelope, so an unknown type makes `lookupType` throw — and that throw is a handler failure, with the consequences in [When a handler throws](#when-a-handler-throws).

There is a matching asymmetry on the two `topic` values in play:

| | Value |
|---|---|
| the delivery matched on | the AMQP routing key — what the trie matches, and what the broker used |
| the handler's 3rd argument | the `topic` field inside the envelope body |

They agree for anything published by protobus. The listener prefers the routing key precisely because the body does not have to: it is publisher-controlled, and trusting it would let a publisher reach handlers its routing key was never permitted to reach.

---

## Wildcard patterns

The grammar is RabbitMQ's, and the matching is protobus's own trie.

| Token | Matches |
|---|---|
| `*` | exactly one word |
| `#` | zero or more words |

Words are separated by `.`. Every row below was executed against the real matcher:

| Pattern | Matches | Does not match |
|---|---|---|
| `ORDERS.*` | `ORDERS.US`, `ORDERS.EU` | `ORDERS.US.CA` |
| `ORDERS.*.SHIPPED` | `ORDERS.US.SHIPPED`, `ORDERS.EU.SHIPPED` | `ORDERS.SHIPPED`, `ORDERS.US.CA.SHIPPED` |
| `ORDERS.#` | `ORDERS`, `ORDERS.US`, `ORDERS.US.CA.SHIPPED` | `SALES.US` |
| `ORDERS.#.SHIPPED` | `ORDERS.SHIPPED`, `ORDERS.US.SHIPPED`, `ORDERS.US.CA.SHIPPED` | `ORDERS.US` |

> [!WARNING]
> `*` is **exactly one** word, never "one or more". `ORDERS.*.SHIPPED` reads as "any shipped order" but describes a strictly three-word topic, so a four-word `ORDERS.US.CA.SHIPPED` does not match it. Use `#` wherever the number of words can vary. The worked example in [Message Flow](../concepts/message-flow.md#wildcard-matching) is pinned by a unit test for exactly this reason.

Design topics so the varying part is one segment, and put the stable discriminator at a fixed position:

```
ORDERS.<region>.<status>      ORDERS.*.SHIPPED works, ORDERS.US.# works
ORDERS.<status>.<region>      you now need two patterns to say "shipped"
```

---

## Several handlers, one topic

Subscribing twice to the same topic registers both handlers. Both run, in registration order, and each is awaited before the next starts.

<!-- doc-check: compile id=ev-multiple -->
```typescript
import { RunnableService } from 'protobus';

class ReportingService extends RunnableService {
    public get ServiceName(): string { return 'Reporting.Service'; }

    public async init(): Promise<void> {
        await super.init();

        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.store(event);
        });

        // Same topic. Both handlers run for every delivery.
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.countIt(event);
        });
    }

    private async store(_event: any): Promise<void> { /* ... */ }
    private async countIt(_event: any): Promise<void> { /* ... */ }
}
```

> [!CAUTION]
> They are **not** independent. The handlers share one delivery and one acknowledgement, and they are awaited in a plain loop — so if the first throws, the second never runs and the whole delivery is lost. Independent side effects that must not take each other down belong in separate services with separate queues.

Two more limits on this shape:

- Events are processed **one at a time per process**. The event listener uses late acknowledgement with a prefetch of `DEFAULT_PREFETCH`, which is **1**. `maxConcurrent` on `IMessageServiceOptions` is passed only to the RPC listener, so raising it does not widen the event path.
- There is no `unsubscribe`. The trie has no remove, and the `unbindQueue` path in `event_listener.ts` is commented out for that reason.

---

## When a handler throws

This is the section to read before you rely on events for anything that must not be lost.

```mermaid
flowchart TD
    D[("Orders.Service.Events delivers")] --> H["run every matching handler"]
    H --> OK{"did they all resolve?"}
    OK -->|yes| A["ack — done"]
    OK -->|"no, one threw"| R["reject, requeue = false"]
    R --> G["the event is discarded"]

    style G fill:#a40e26,color:#fff,stroke:#a40e26
```

> [!CAUTION]
> **A failed event handler does not retry, and there is no event DLQ.** `MessageListener` declares `<Service>.Retry`, `<Service>.Retry.Exchange` and `<Service>.DLQ` for the RPC queue. `EventListener` declares none of them and does not override `getRetryOptions()`, so the connection layer takes its no-retry branch: the delivery is rejected without requeue and the message is gone. There is also no caller to reply to, so nothing anywhere records that it happened beyond one `rejecting message` line in the log.

Corollaries, all of which contradict what this page used to say:

- **`HandledError` changes nothing on the event path.** On the RPC path it is the difference between an immediate error reply and three retries. Here both branches end in the same reject-without-requeue. Throwing it is harmless and communicates intent, but it does not prevent a retry, because there is no retry.
- **"Unacknowledged events are redelivered" is true only for a crash.** Late acknowledgement means an event whose process dies mid-handler is unacked and comes back. An event whose handler *returned a rejected promise* is settled, not unacked.

So the durability of an event's *effects* is yours to arrange. Either catch inside the handler and record the failure somewhere you can replay from:

<!-- doc-check: compile id=ev-catch -->
```typescript
import { RunnableService } from 'protobus';

class BillingService extends RunnableService {
    public get ServiceName(): string { return 'Billing.Service'; }

    public async init(): Promise<void> {
        await super.init();

        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.charge(event);
            } catch (error) {
                // Nothing above this line will retry, so failure has to be
                // recorded here or it is recorded nowhere.
                await this.parkForReplay(event, error);
            }
        });
    }

    private async charge(_event: any): Promise<void> { /* ... */ }
    private async parkForReplay(_event: any, _error: unknown): Promise<void> { /* ... */ }
}
```

or, when the work genuinely must not be lost, do not model it as an event at all. An RPC has the retry ladder and the DLQ — see [Delivery Guarantees](../concepts/delivery-guarantees.md).

---

## What survives what

| Failure | Event in flight |
|---|---|
| Broker restarts | **survives** — published `deliveryMode: 2`, and `<Service>.Events` is durable |
| Every replica of a subscriber is down | **survives** — the queue is durable and not auto-delete, so it accumulates |
| A replica is killed mid-handler | **redelivered** — late ack, so the delivery was never settled |
| The handler rejects | **lost** — rejected without requeue, no retry, no DLQ |
| Nobody has ever subscribed | **lost** — no binding matches, and events are not published `mandatory` |

> [!WARNING]
> The second row is a real operational hazard in the other direction. `<Service>.Events` is durable and never auto-deletes, so the event queue of a service you deleted keeps filling forever. See [Queue Migration](../operations/queue-migration.md).

---

## A subscriber that is not a service

A process that only listens does not need `RunnableService.start` and its signal handling; it can own its own lifecycle. It still needs the same `service` block, and it must close its connection.

<!-- doc-check: compile id=ev-standalone needs=ev-subscriber-class -->
```typescript
import { Context } from 'protobus';

async function main(): Promise<void> {
    const context = new Context();
    await context.init(
        process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/',
        [__dirname + '/proto/'],
    );

    const subscriber = new NotificationService(context);
    await subscriber.init();

    await subscriber.subscribeEvent('Orders.OrderShipped', async (event) => {
        console.log('shipped', event.order_id);
    }, 'ORDERS.*.SHIPPED');

    console.log('listening');

    // A long-lived listener stays here. A short-lived script must disconnect,
    // or the process never exits.
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    await context.connection.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
```

> [!IMPORTANT]
> **There is no `Context.close()`.** The connection is reached through the context: `await context.connection.disconnect()`. Without it an open AMQP socket and its heartbeat timer keep the event loop alive and the process hangs forever. `RunnableService.start` does this for you on SIGINT/SIGTERM; a script you wrote yourself does not.

> [!NOTE]
> If you also want to *call* a service from the same process, note that `ServiceProxy` has no index signature — it builds its methods from the schema at `init()`, so TypeScript cannot know them. `proxy.someMethod(...)` is a compile error unless you intersect the shape you expect: `new ServiceProxy(context, 'Orders.Service') as ServiceProxy & IOrdersService`. `npx protobus generate` writes that interface for you.

---

## Worked example

One publisher, two independent subscribers, and the schema all three share.

<!-- doc-check: proto id=ev-worked-proto -->
```protobuf
syntax = "proto3";
package Orders;

message CreateOrderRequest {
    string user_id = 1;
    repeated string skus = 2;
}

message CreateOrderResponse {
    string order_id = 1;
}

message ShipOrderRequest {
    string order_id = 1;
    string region = 2;
    string carrier = 3;
}

message ShipOrderResponse {
    bool ok = 1;
}

message OrderCreated {
    string order_id = 1;
    string user_id = 2;
    int64  created_at = 3;
    repeated string skus = 4;
}

message OrderShipped {
    string order_id = 1;
    string carrier = 2;
    string region = 3;
}

service Service {
    rpc createOrder(Orders.CreateOrderRequest) returns(Orders.CreateOrderResponse);
    rpc shipOrder(Orders.ShipOrderRequest) returns(Orders.ShipOrderResponse);
}
```

<!-- doc-check: compile id=ev-worked -->
```typescript
import { RunnableService } from 'protobus';

class OrdersService extends RunnableService {
    public get ServiceName(): string { return 'Orders.Service'; }

    async createOrder(
        request: { user_id: string; skus: string[] },
    ): Promise<{ order_id: string }> {
        const orderId = 'ord-123';

        // Everything a subscriber could want, in the event itself.
        await this.publishEvent('Orders.OrderCreated', {
            order_id: orderId,
            user_id: request.user_id,
            created_at: Date.now(),
            skus: request.skus,
        });

        return { order_id: orderId };
    }

    async shipOrder(
        request: { order_id: string; region: string; carrier: string },
    ): Promise<{ ok: boolean }> {
        // The region goes in the TOPIC, so a subscriber can filter on it
        // without decoding anything.
        await this.publishEvent('Orders.OrderShipped', {
            order_id: request.order_id,
            carrier: request.carrier,
            region: request.region,
        }, `ORDERS.${request.region}.SHIPPED`);

        return { ok: true };
    }
}

class EmailService extends RunnableService {
    public get ServiceName(): string { return 'Email.Service'; }

    public async init(): Promise<void> {
        await super.init();

        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.send(event.user_id, event.order_id);
            } catch (error) {
                // No retry exists above this line.
                console.error('email failed for', event.order_id, error);
            }
        });
    }

    private async send(_userId: string, _orderId: string): Promise<void> { /* ... */ }
}

class ShipmentTracker extends RunnableService {
    public get ServiceName(): string { return 'Tracking.Service'; }

    public async init(): Promise<void> {
        await super.init();

        // Region-scoped: ORDERS.US.SHIPPED matches, ORDERS.EU.SHIPPED does not.
        await this.subscribeEvent('Orders.OrderShipped', async (event, type) => {
            // The topic decides which handler runs; the type never does.
            if (type !== 'Orders.OrderShipped') return;
            console.log('US shipment', event.order_id, event.carrier);
        }, 'ORDERS.US.SHIPPED');
    }
}
```

`EmailService` and `ShipmentTracker` each get their own durable queue, so one being down does not affect the other, and neither affects `OrdersService`.

---

<div align="center">

**[← Schema](./schema.md)** · **[Docs index](../README.md)** · **[Error Handling →](./error-handling.md)**

</div>
