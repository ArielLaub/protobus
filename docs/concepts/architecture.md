# Architecture

> How a protobus service becomes RabbitMQ topology, and what happens to a message between `proxy.add(...)` and the promise resolving.

**Read this if** you are evaluating protobus, or you have a service running and want to understand what you are looking at in the RabbitMQ management UI.

| | |
|---|---|
| **Prerequisites** | [Getting Started](../guide/getting-started.md) — you have run one service |
| **Next** | [Configuration](../reference/configuration.md) · [Error Handling](../guide/error-handling.md) |
| **Source** | [`lib/context.ts`](../../lib/context.ts) · [`lib/connection.ts`](../../lib/connection.ts) · [`lib/message_listener.ts`](../../lib/message_listener.ts) |

**On this page** — [The one idea](#the-one-idea) · [What a service creates](#what-a-service-creates-in-the-broker) · [The RPC round trip](#the-rpc-round-trip) · [When a handler fails](#when-a-handler-fails) · [Exchanges](#exchange-reference) · [Queues](#queue-reference) · [Wire format](#wire-format) · [Components](#components)

---

## The one idea

A protobus service is **one durable queue** bound to a topic exchange, and **N processes competing for it**.

Everything else — load balancing, failover, backpressure, retry delay, priority — is a property RabbitMQ already gives that queue. Protobus does not implement any of it in JavaScript; it declares the topology and gets out of the way.

That is the whole design, and it is what makes the rest of this page short.

```mermaid
flowchart LR
    C1["caller"] --> X{{"proto.bus"}}
    C2["caller"] --> X
    X -->|"REQUEST.Orders.Service.*"| Q[("Orders.Service<br/>one durable queue")]
    Q --> R1["replica 1"]
    Q --> R2["replica 2"]
    Q --> R3["replica 3"]

    style Q fill:#1f6feb,color:#fff,stroke:#1f6feb
```

Add a replica and throughput goes up. Kill a replica mid-message and the unacked delivery returns to the queue for another replica. Neither is protobus code.

---

## What a service creates in the broker

Start one service named `Orders.Service` and four queues appear. Most people meet this diagram for the first time in the management UI, wondering what `Orders.Service.Retry` is.

```mermaid
flowchart LR
    subgraph caller["Caller process"]
        P["ServiceProxy"]
        CL["CallbackListener"]
    end

    subgraph broker["RabbitMQ"]
        direction TB
        BUS{{"proto.bus<br/>topic"}}
        CB{{"proto.bus.callback<br/>direct"}}
        EV{{"proto.bus.events<br/>topic"}}
        RX{{"Orders.Service.Retry.Exchange<br/>topic"}}

        Q[("Orders.Service<br/>durable")]
        QE[("Orders.Service.Events<br/>durable")]
        QR[("Orders.Service.Retry<br/>TTL, DLX to proto.bus")]
        QD[("Orders.Service.DLQ<br/>durable")]
        QC(["callback queue<br/>exclusive, auto-delete"])
    end

    subgraph svc["Orders.Service replicas"]
        R1["replica 1"]
        R2["replica 2"]
    end

    P -->|"REQUEST.Orders.Service.create"| BUS
    BUS -->|"binding REQUEST.Orders.Service.*"| Q
    Q --> R1
    Q --> R2

    R1 -->|"reply, key = correlationId"| CB
    CB --> QC
    QC --> CL
    CL --> P

    R1 -->|"publishEvent"| EV
    EV -->|"EVENT.Orders.OrderCreated"| QE
    QE --> R2

    R1 -.->|"handler threw"| RX
    RX -.-> QR
    QR -.->|"TTL expires, DLX replays<br/>the ORIGINAL routing key"| BUS
    R1 -.->|"attempts exhausted"| QD

    style Q fill:#1f6feb,color:#fff,stroke:#1f6feb
    style QD fill:#a40e26,color:#fff,stroke:#a40e26
```

> [!NOTE]
> Solid arrows are the happy path. Dashed arrows only ever carry a message whose handler threw.

Three things in that picture surprise people, so they are worth saying in words:

- **`Orders.Service.Events` is a queue, not a subscription.** It is durable and it is *not* auto-delete. Events published while every replica is down are still there when one comes back. It also means an event queue for a service you deleted keeps filling forever — see [Queue Migration](../operations/queue-migration.md).
- **The callback queue is per *client process*, exclusive and auto-deleting.** It vanishes when the client disconnects, which is why an in-flight RPC whose caller died is simply dropped rather than replied to.
- **The retry queue has no consumer.** Messages sit in it until their TTL expires and RabbitMQ dead-letters them back onto `proto.bus`. The delay *is* the TTL. Nothing sleeps in Node.

---

## The RPC round trip

```mermaid
sequenceDiagram
    autonumber
    participant C as ServiceProxy
    participant B as proto.bus
    participant Q as Orders.Service queue
    participant S as Service replica
    participant K as proto.bus.callback

    C->>C: encode CreateRequest, wrap in RequestContainer
    C->>B: publish, mandatory<br/>key REQUEST.Orders.Service.create<br/>correlationId + replyTo
    Note over C,B: mandatory means an unroutable request fails now with<br/>UnroutableError, not after the full RPC timeout
    B->>Q: matched by binding REQUEST.Orders.Service.*
    Q->>S: delivered, up to maxConcurrent unacked at once
    S->>S: decode container, decode inner message, run handler
    S->>K: publish reply, routing key = correlationId
    Note over S,Q: the reply is published BEFORE the request is acked —<br/>a crash in between redelivers rather than losing the answer
    S->>Q: ack
    K->>C: exclusive callback queue delivers
    C->>C: decode ResponseContainer, resolve or reject the promise
```

Two properties of that sequence are load-bearing and easy to miss:

> [!IMPORTANT]
> **The publish resolves on a broker confirm, not a local buffer write.** `await publish(...)` returning means RabbitMQ acknowledged the message. It costs a round trip, and it is the reason a resolved publish is worth anything.

> [!IMPORTANT]
> **The reply goes out before the ack.** The opposite order — ack, then reply — loses the response if the process dies in between, with the request already settled and unable to be redelivered.

---

## When a handler fails

This is the part with no equivalent in a transport-agnostic framework, and the part an operator ends up living in.

```mermaid
flowchart TD
    H["handler throws"] --> HE{"HandledError?"}
    HE -->|"yes — retrying cannot help"| REJ["reply the error to the caller<br/>reject, no requeue"]
    HE -->|no| N{"x-retry-count &lt; maxRetries?"}
    N -->|yes| RP["publish to Orders.Service.Retry.Exchange<br/>with the original routing key<br/>then ack the original"]
    RP --> W["Orders.Service.Retry<br/>message waits out retryDelayMs"]
    W --> DL["TTL expiry dead-letters it to proto.bus<br/>carrying its own original routing key"]
    DL --> RE["redelivered to Orders.Service"]
    RE --> H
    N -->|no| D["reply the error to the caller FIRST<br/>then publish to Orders.Service.DLQ<br/>then ack"]

    style REJ fill:#9a6700,color:#fff,stroke:#9a6700
    style D fill:#a40e26,color:#fff,stroke:#a40e26
```

> [!WARNING]
> **The caller stays parked for the whole ladder.** No reply is published while a message is being retried. With the defaults — `maxRetries: 3`, `retryDelayMs: 5000` — a permanently failing call blocks its caller for roughly 15 seconds before it throws. Size `RPC_CALL_TIMEOUT_MS` against `maxRetries × retryDelayMs`, not against one handler run.

Every hop stamps headers on the message. These are the ops surface — a message sitting in a DLQ can be read back without any application logging:

| Header | Set on | Meaning |
|---|---|---|
| `x-retry-count` | every retry and the DLQ copy | attempts made so far |
| `x-original-routing-key` | retry, DLQ | the key the message must be replayed with |
| `x-first-failure-time` | retry, DLQ | epoch ms of the *first* failure, preserved across hops |
| `x-last-error` | retry, DLQ | truncated summary of the throw that caused this hop |
| `x-original-queue` | DLQ | which service's queue gave up on it |
| `x-dlq-time` | DLQ | epoch ms it was dead-lettered |

`correlationId` and `messageId` are carried through unchanged, so a retried copy is recognisable as the same logical message.

<details>
<summary><b>Why the retry exchange exists at all</b> — a plain <code>sendToQueue</code> would be simpler</summary>

<br/>

A message parked on `Orders.Service.Retry` comes back via RabbitMQ's dead-letter mechanism, and the DLX republishes it **with the routing key it arrived carrying**. If the message had been put on the retry queue with `sendToQueue`, that key would be `Orders.Service.Retry` — which matches no binding on the main queue, so the redelivery would route nowhere and be dropped.

Publishing to a per-service *topic* exchange bound with `#` preserves the original `REQUEST.Orders.Service.create` key across the queue → TTL → DLX → `proto.bus` round trip, so the redelivery lands back on the service queue. That is the entire reason `<Service>.Retry.Exchange` exists.

See [`lib/connection.ts`](../../lib/connection.ts) around the retry ladder, and the comment in [`lib/message_listener.ts`](../../lib/message_listener.ts).

</details>

---

## Exchange reference

Five exchanges, three of them shared by the whole bus and two per service.

| Exchange | Type | Scope | Carries | Env override |
|---|---|---|---|---|
| `proto.bus` | topic | shared | RPC requests | `BUS_EXCHANGE_NAME` |
| `proto.bus.callback` | direct | shared | RPC replies, keyed by `correlationId` | `CALLBACKS_EXCHANGE_NAME` |
| `proto.bus.events` | topic | shared | published events | `EVENTS_EXCHANGE_NAME` |
| `proto.bus.cancel` | fanout | shared | stream cancellation notices ([Streaming](../guide/streaming.md#cancellation)) | `CANCEL_EXCHANGE_NAME` |
| `<Service>.Retry.Exchange` | topic | per service | failed messages awaiting redelivery | — |

### Routing keys

| Traffic | Key | Example |
|---|---|---|
| RPC request | `REQUEST.<Package>.<Service>.<method>` | `REQUEST.Orders.Service.create` |
| Service binding | `REQUEST.<Package>.<Service>.*` | one queue serves every method |
| RPC reply | the `correlationId` | `cjk8b9x0000001234567890` |
| Event, default | `EVENT.<Package>.<EventType>` | `EVENT.Orders.OrderCreated` |
| Event, custom topic | anything you pass | `ORDERS.US.SHIPPED`, matched by `ORDERS.*.SHIPPED` |

> [!NOTE]
> A service binds `REQUEST.<Service>.*` — **one queue for every method**. That is what makes [Message Priority](../guide/priority.md) necessary: a slow bulk method and a fast control method share a lane.

---

## Queue reference

| Queue | Durable | Auto-delete | Exclusive | Consumed by |
|---|---|---|---|---|
| `<Service>` | yes | no | no | every replica, competing |
| `<Service>.Events` | yes | no | no | every replica, competing |
| `<Service>.Retry` | yes | no | no | **nobody** — drained by TTL expiry |
| `<Service>.DLQ` | yes | no | no | **nobody** — you |
| callback queue | no | yes | yes | the one client process that declared it |
| cancel queue | no | yes | yes | the one service process that declared it |

**Persistence.** Every message is published `deliveryMode: 2`. Combined with durable queues, messages survive a broker restart.

**Acknowledgement.** Services ack late by default: the delivery is acked after the handler returns and its reply is away. Failures take the ladder above — protobus does **not** nack-with-requeue, because an immediate requeue of a message that just failed is a hot loop.

---

## Concurrency

> [!CAUTION]
> `maxConcurrent` is the consumer prefetch and it **defaults to `1`**. One replica handles one message at a time, holding the slot until the handler returns. This is deliberate and conservative — and it means a service that does I/O and was never configured is leaving almost all of its throughput on the table.

```typescript
// A service that awaits anything almost always wants this raised.
const service = new OrdersService(context, { maxConcurrent: 10 });
```

It bounds memory as well as throughput: with late ack the broker will push up to `maxConcurrent` unacked messages into the process. Scale out with more processes, not by co-locating services — Node is single-threaded, so co-location buys no parallelism and couples failure domains.

Full detail in [Configuration → Concurrency](../reference/configuration.md#concurrency).

---

## Wire format

Every message is **two layers of protobuf**: an outer container carrying routing metadata, and the opaque encoded bytes of your own message inside it.

```mermaid
flowchart LR
    subgraph outer["RequestContainer — protobuf"]
        M["method<br/>Orders.Service.create"]
        A["actor<br/>caller-supplied string"]
        D["data: bytes"]
    end
    D --> inner["CreateRequest — protobuf<br/>your schema, opaque to the bus"]

    style inner fill:#1f6feb,color:#fff,stroke:#1f6feb
```

The bus routes, retries, dead-letters and logs a message without ever needing your schema. Only the two endpoints decode the inner layer.

<details>
<summary><b>Container definitions</b> — from <code>lib/message_factory.ts</code></summary>

<br/>

```protobuf
message RequestContainer {
    string method = 1;   // Package.Service.method
    string actor  = 2;   // caller-supplied; see the Security model
    bytes  data   = 3;   // encoded request message
}

message ResponseContainer {
    oneof value {
        ResponseResult result = 1;
        ResponseError  error  = 2;
    }
}

message ResponseResult {
    string method = 1;
    bytes  data   = 2;   // encoded response message
}

message ResponseError {
    string method  = 1;
    string message = 2;
    string code    = 3;  // the code passed to HandledError
}

message EventContainer {
    string type  = 1;    // Package.EventType
    string topic = 2;    // routing topic
    bytes  data  = 3;    // encoded event message
}
```

</details>

> [!WARNING]
> `actor` is set by the caller and nothing verifies it. It is for tracing, never for authorisation — see the [Security model](../operations/security.md).

---

## Components

<details>
<summary><b>Object graph</b> — what holds what</summary>

<br/>

```mermaid
flowchart TD
    CTX["Context"]
    CTX --> CONN["Connection — one AMQP connection, n channels"]
    CTX --> MF["MessageFactory — proto load, encode, decode"]
    CTX --> MD["MessageDispatcher → proto.bus"]
    CTX --> ED["EventDispatcher → proto.bus.events"]
    CTX --> CBL["CallbackListener ← proto.bus.callback"]

    MS["MessageService"] --> ML["MessageListener ← service queue"]
    MS --> EL["EventListener ← events queue"]
    MS --> MD
    MS --> ED

    SP["ServiceProxy"] --> MD
    SP --> CBL
```

</details>

| Component | Responsibility | Source |
|---|---|---|
| **Context** | one AMQP connection, the proto registry, the shared dispatchers. Create one per process. | [`lib/context.ts`](../../lib/context.ts) |
| **Connection** | channels, declarations, bindings, reconnection, the retry ladder | [`lib/connection.ts`](../../lib/connection.ts) |
| **MessageFactory** | loads `.proto` files; encodes and decodes both layers | [`lib/message_factory.ts`](../../lib/message_factory.ts) |
| **MessageService** | serves a queue: dispatches RPCs to your methods, subscribes to events | [`lib/message_service.ts`](../../lib/message_service.ts) |
| **RunnableService** | `MessageService` plus process lifecycle — proto resolution by convention, SIGINT/SIGTERM, non-zero exit on boot failure | [`lib/runnable_service.ts`](../../lib/runnable_service.ts) |
| **ServiceProxy** | builds method stubs from the proto and calls them over the bus | [`lib/service_proxy.ts`](../../lib/service_proxy.ts) |
| **Trie** | wildcard topic matching for event subscriptions | [`lib/trie.ts`](../../lib/trie.ts) |

---

### See it for yourself

```bash
npm run docker:up
bash scripts/run-combat-sample.sh      # six services, RPC + events + shutdown
open http://localhost:15672            # guest / guest — the queues above, live
```

---

<div align="center">

**[← Getting Started](../guide/getting-started.md)** · **[Docs index](../README.md)** · **[Configuration →](../reference/configuration.md)**

</div>
