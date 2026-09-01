# Message Flow

> The bytes protobus puts on the wire, and one RPC round trip traced through them.

**Read this if** you are looking at a message in the RabbitMQ management UI, writing a client in another language, or you need to know exactly what ties a reply to the call that produced it.

| | |
|---|---|
| **Prerequisites** | [Architecture](./architecture.md) — the exchanges and queues this page moves messages through |
| **Next** | [Delivery Guarantees](./delivery-guarantees.md) · [Events](../guide/events.md) |
| **Source** | [`lib/message_factory.ts`](../../lib/message_factory.ts) · [`lib/message_dispatcher.ts`](../../lib/message_dispatcher.ts) · [`lib/event_dispatcher.ts`](../../lib/event_dispatcher.ts) · [`lib/trie.ts`](../../lib/trie.ts) |

**On this page** — [Two layers](#two-layers) · [The envelope messages](#the-envelope-messages) · [One RPC round trip](#one-rpc-round-trip) · [Correlation and timeouts](#correlation-and-timeouts) · [The event path](#the-event-path) · [Routing-key grammar](#routing-key-grammar) · [Wildcard matching](#wildcard-matching) · [What the envelope costs](#what-the-envelope-costs)

> [!NOTE]
> This page is about the **message**. The exchanges, the four queues a service declares, and the retry/DLQ ladder belong to [Architecture](./architecture.md) and [Delivery Guarantees](./delivery-guarantees.md), and are not repeated here.

---

## Two layers

Every protobus message is protobuf inside protobuf: a fixed **envelope** the bus understands, carrying the **payload** — the opaque bytes of a message from your own schema.

```mermaid
flowchart LR
    W["AMQP message body"] --> E{{"decode envelope<br/>RequestContainer"}}
    E --> MTH["method<br/>Orders.Service.create"]
    E --> ACT["actor<br/>caller-supplied string"]
    E --> DAT["data: bytes"]
    MTH -->|"names the schema to read data with"| P["decode payload<br/>CreateRequest"]
    DAT --> P

    style P fill:#1f6feb,color:#fff,stroke:#1f6feb
```

The bus routes, retries, dead-letters and logs a message without ever loading your `.proto`. Only the two endpoints decode the second layer.

That split has a security consequence, and it is the reason the two decodes are separate methods rather than one:

> [!IMPORTANT]
> **`method` is publisher-controlled, and it chooses the schema.** A service therefore decodes the envelope, checks the name it carries against the routing key the broker actually delivered on, and only then decodes the payload — [`lib/message_service.ts`](../../lib/message_service.ts), `_onMessage`. Decoding first would let a publisher pick which schema its bytes are parsed as, and hand one service's request to another service's handler.

<details>
<summary><b>The three checks a request passes before a handler sees it</b></summary>

<br/>

From [`lib/message_service.ts`](../../lib/message_service.ts), in order. Each failure is answered with an `InvalidMethodError` rather than retried.

1. The routing key starts with `REQUEST.<ServiceName>.` — the delivery belongs to this service, judged by what the broker did, not by what the body says.
2. The last segment of the routing key equals the last segment of `envelope.method` — a caller that can publish cannot route to one method and have another run. This is what keeps RabbitMQ topic permissions meaningful.
3. `envelope.method` splits as `<Package>.<Service>.<method>` where `<Package>.<Service>` is this service's contract, and `<method>` is one the contract declares **and** the subclass itself implements.

</details>

---

## The envelope messages

Five messages, none of which lives in a `.proto` file: they are declared in TypeScript with protobufjs decorators in [`lib/message_factory.ts`](../../lib/message_factory.ts). Written out as protobuf they read:

<!-- doc-check: proto -->
```protobuf
syntax = "proto3";

message RequestContainer {
    string method = 1;   // <Package>.<Service>.<method>
    string actor  = 2;   // caller-supplied; tracing only
    bytes  data   = 3;   // encoded request message
}

message ResponseResult {
    string method = 1;   // echoed back; selects the schema for data
    bytes  data   = 2;   // encoded response message
}

message ResponseError {
    string method  = 1;
    string message = 2;
    string code    = 3;  // the code carried by HandledError; "" otherwise
}

message ResponseContainer {
    oneof value {
        ResponseResult result = 1;
        ResponseError  error  = 2;
    }
}

message EventContainer {
    string type  = 1;    // <Package>.<MessageType>
    string topic = 2;    // the topic it was published under
    bytes  data  = 3;    // encoded event message
}
```

| Top-level envelope | Published to | Built by | Read by |
|---|---|---|---|
| `RequestContainer` | `proto.bus` | `buildRequest` | `decodeRequestEnvelope` then `decodeRequestPayload` |
| `ResponseContainer` | `proto.bus.callback` | `buildResponse` | `decodeResponse` |
| `EventContainer` | `proto.bus.events` | `buildEvent` | `decodeEvent` |

> [!WARNING]
> **`ResponseError` has no `external` field.** Older revisions of this page documented one and claimed it controlled requeueing. It never existed. The three fields above are the whole message ([`lib/message_factory.ts`](../../lib/message_factory.ts), `ResponseError`), and nothing on the wire decides retry behaviour — the *sending* service decides it, before encoding, by whether the throw was a `HandledError`. See [Delivery Guarantees](./delivery-guarantees.md#the-retry-ladder).

Two details worth knowing about `ResponseError`:

- **`code` is `HandledError`'s code.** `buildResponse` reads `(error as any).code || ''`, so an ordinary `Error` yields an empty string. `ServiceProxy` reconstructs an `Error` on the caller's side and re-attaches `code` only when it is non-empty.
- **The error path never looks the method up.** Every other encode resolves `method` against the schema; this one treats it as a label. Otherwise a failure that is *about* an unknown method would be impossible to report, and the caller would sit out its whole RPC timeout instead.

`ResponseResult.method` is not decoration either: `decodeResponse` uses it to find the response type to decode `data` with, so a response is self-describing without the caller having to remember what it asked for.

> [!NOTE]
> `actor` is a caller-supplied string that nothing verifies. It is for tracing, never authorisation — see the [Security model](../operations/security.md).

---

## One RPC round trip

```mermaid
sequenceDiagram
    autonumber
    participant P as ServiceProxy
    participant D as MessageDispatcher
    participant B as proto.bus
    participant Q as Orders.Service queue
    participant S as Service replica
    participant K as proto.bus.callback

    P->>P: buildRequest: encode CreateRequest, wrap in RequestContainer
    P->>D: publishMessage, key REQUEST.Orders.Service.create
    D->>D: id = randomUUID, register it, arm the reply timer
    D->>B: publish<br/>correlationId = id, replyTo = callback queue, mandatory
    B->>Q: matched by the binding REQUEST.Orders.Service.*
    Q->>S: delivered
    S->>S: decode envelope, check method against the routing key, decode payload
    S->>S: run the handler, then buildResponse
    S->>K: publish, routing key = replyTo, correlationId echoed
    S->>Q: ack
    K->>D: the caller's exclusive callback queue delivers
    D->>P: match correlationId, clear the timer, resolve
    P->>P: decodeResponse: throw on error, else return result.data
```

Three things in that sequence are routinely misremembered:

> [!IMPORTANT]
> **The reply's routing key is `replyTo` — the callback queue's name — not the `correlationId`.** `proto.bus.callback` is a *direct* exchange and each caller's queue is bound to it under its own name ([`lib/base_listener.ts`](../../lib/base_listener.ts), the `exchangeType === 'direct'` branch). The `correlationId` is an AMQP message property, and it selects the pending promise *inside* the caller's process. Two different mechanisms; only one of them is routing.

> [!IMPORTANT]
> **The reply timer is armed before the publish, not after.** `publish()` waits for a broker confirm, and a fast service can answer while that confirm is still in flight. Registering afterwards let `_onResult` find no entry for the `correlationId` and drop a reply that had already arrived ([`lib/message_dispatcher.ts`](../../lib/message_dispatcher.ts)).

> [!IMPORTANT]
> **RPC requests are published `mandatory`, events are not.** An RPC request that matches no binding means no service is listening, so it fails immediately with `UnroutableError` instead of after the full timeout. An event with no subscribers is normal, so setting `mandatory` there would break fan-out publishing.

<details>
<summary><b>Fire-and-forget: the same path with <code>rpc: false</code></b></summary>

<br/>

`proxy.method(request, actor, false)` publishes the identical `RequestContainer` to the identical routing key, and then:

- `replyTo` is left unset, so the service publishes no reply at all,
- `mandatory` is not set, so an unroutable message is silently dropped,
- no correlation entry and no timer are created, and `timeoutMs` is ignored,
- the returned promise resolves to `{}` as soon as the broker confirms the publish.

A failure in the handler is therefore invisible to the caller. It still takes the full retry ladder on the service side.

</details>

---

## Correlation and timeouts

| | |
|---|---|
| **Correlation id** | `randomUUID()`, minted per call in `MessageDispatcher.publish` |
| **Where it lives** | the AMQP `correlationId` property, echoed unchanged onto the reply |
| **What it selects** | one entry in the dispatcher's `callbacks` map — `{ resolve, reject, timer }` |
| **Reply queue** | one exclusive, auto-delete queue **per client process**, not per call |
| **Default timeout** | `Config.rpcCallTimeoutMs` — **600000 ms (10 minutes)**, `RPC_CALL_TIMEOUT_MS` |
| **Per-call override** | the 4th argument to a proxy method, `timeoutMs` |
| **On timeout** | the entry is deleted and the promise rejects with `RpcTimeoutError`, naming the routing key and the correlation id |
| **On disconnect** | every pending entry is rejected at once with `DisconnectedError` and the map is cleared |

The timer is created with `unref()`, so a pending RPC does not by itself keep a Node process alive.

> [!CAUTION]
> Ten minutes is a deliberately generous default, chosen so that upgrading protobus could not break a deployment with a legitimately slow handler. It is far too long for anything user-facing. Size it against the whole retry ladder rather than a single handler run: with the defaults a permanently failing call is retried three times at 5 s apart before the caller hears anything — see [The parked caller](./delivery-guarantees.md#the-parked-caller).

---

## The event path

An event is one-way. There is no `replyTo`, no correlation entry, no timer, and no acknowledgement that reaches the publisher.

```mermaid
sequenceDiagram
    autonumber
    participant S as Publishing service
    participant E as EventDispatcher
    participant X as proto.bus.events
    participant Q as Subscriber.Events queue
    participant L as EventListener
    participant H as Your handler

    S->>E: publishEvent(type, content, topic?)
    E->>E: topic defaults to EVENT.&lt;type&gt; when omitted
    E->>E: buildEvent: wrap the encoded message in EventContainer
    E->>X: publish, routing key = topic, persistent, NOT mandatory
    X->>Q: every queue whose binding matches the topic gets a copy
    Q->>L: delivered
    L->>L: decodeEvent, using the type carried in the body
    L->>L: Trie.match on the routing key the broker delivered on
    L->>H: await every handler registered on a matching pattern
```

Two asymmetries with the RPC path decide most event-related surprises:

- **The routing key is the topic, and the topic is what the `Trie` matches.** The listener deliberately prefers `context.routingKey` over the `topic` field inside the body: the body is publisher-controlled, and trusting it would let a publisher reach handlers its routing key was never permitted to reach. The body topic is used only as a fallback when no routing key is available.
- **The `type` field is used for decoding, not for routing.** `decodeEvent` looks `type` up in the loaded schema to decode `data`. A subscriber that matches a broad wildcard therefore needs every type it can receive present in its own schema, or the decode throws. See [Events](../guide/events.md#topics-route-types-do-not).

---

## Routing-key grammar

| Traffic | Key | Set by | Example |
|---|---|---|---|
| RPC request | `REQUEST.<Package>.<Service>.<method>` | `ServiceProxy`, from the proto | `REQUEST.Orders.Service.create` |
| Service binding | `REQUEST.<Package>.<Service>.*` | `MessageService.init` | one queue serves every method |
| RPC reply | the caller's callback queue name | `connection.ts`, from `replyTo` | `amq.gen-JzTY20BRgKO-HjmUJj0wLg` |
| Event, default | `EVENT.<Package>.<MessageType>` | `EventDispatcher.publish` | `EVENT.Orders.OrderCreated` |
| Event, custom topic | whatever you pass | you | `ORDERS.US.SHIPPED` |
| Retry hop | the original request key, preserved | `connection.ts` | `REQUEST.Orders.Service.create` |

> [!NOTE]
> **The routing key and the envelope's `method` are allowed to disagree, in one specific way.** `ServiceName` may carry more segments than the contract does: a class named `Combat.Player.player6` binds `REQUEST.Combat.Player.player6.*`, while the method it serves is still `Combat.Player.shoot` — the contract name, found by trimming segments from the right until one matches a `service` in the schema. That is why check 2 compares only the *last* segment of the routing key with the last segment of `method`.
>
> `ServiceProxy` cannot address such an instance: it derives the key as `REQUEST.<methodFullName>`, and `methodFullName` comes from the schema. Build the key yourself and call `context.publishMessage(buffer, key, true)` — [`sample/combatGame/BasePlayer.ts`](../../sample/combatGame/BasePlayer.ts), `callPlayerMethod`, is the worked example.

---

## Wildcard matching

Event subscriptions are matched by a [`Trie`](../../lib/trie.ts), not by RabbitMQ, because one queue can carry several subscriptions and the process still has to decide which handlers to run. The grammar is RabbitMQ's:

| Token | Matches |
|---|---|
| `*` | exactly one word |
| `#` | zero or more words |

Words are separated by `.`. A pattern with no wildcard matches only itself.

Register three patterns:

| Pattern | Handler |
|---|---|
| `ORDERS.*.CREATED` | A |
| `ORDERS.#` | B |
| `ORDERS.US.*.SHIPPED` | C |

and this is what the matcher does with them:

| Event | Words | Handlers | Why |
|---|---:|---|---|
| `ORDERS` | 1 | **B** | `#` stands for zero words too; `*` never does |
| `ORDERS.US.CREATED` | 3 | **A, B** | `*` binds the single word `US` |
| `ORDERS.US.123.CREATED` | 4 | **B** | `*` cannot cover `US.123` |
| `ORDERS.US.123.SHIPPED` | 4 | **B, C** | literal `US`, then `*` binds `123` |
| `ORDERS.EU.456.SHIPPED` | 4 | **B** | the literal `US` does not match `EU` |

> [!WARNING]
> The third row is the one that catches people. `ORDERS.*.CREATED` reads as "any order that was created", but `*` is **exactly one** word, so the pattern describes a three-word topic and that event has four. Reach for `#` whenever the number of words can vary.

Those five rows are executed against the real matcher by [`test/unit/trie_documented_examples.test.ts`](../../test/unit/trie_documented_examples.test.ts). They were wrong here once; the test exists so the page cannot drift again. If you change the table, change the test.

<details>
<summary><b>Two behaviours of the trie that are easy to assume wrong</b></summary>

<br/>

- **A pattern is not shadowed by a longer one.** Adding `a.b.c` does not stop `a.b` from matching, because a value is stored only on the node its own pattern ends at, and a node with children can still hold one.
- **Two subscriptions to the same pattern both fire.** Each node holds a list of values, not a slot. An earlier implementation kept one, so a second handler on the same topic was silently dropped.

Unsubscribing is not implemented. The `unbindQueue` code path in [`lib/event_listener.ts`](../../lib/event_listener.ts) is commented out because the trie has no remove.

</details>

---

## What the envelope costs

Measured, not estimated — encode a `RequestContainer` for the method `Orders.Service.create` (21 characters) and subtract the payload:

| Envelope | actor | Payload | Total | Overhead |
|---|---|---:|---:|---:|
| `RequestContainer` | `""` | 100 B | 125 B | **25 B** |
| `RequestContainer` | `"client-1"` | 100 B | 135 B | **35 B** |
| `ResponseContainer` (result) | — | 100 B | 127 B | **27 B** |
| `EventContainer` | — | 100 B | 150 B | **50 B** |

The overhead is the strings, and it does not grow with the payload: two bytes of protobuf framing plus the length of each string it carries, then one tag byte and a varint length for `data`. `EventContainer` costs more only because it carries two long strings — the type name and the topic — where a request carries one plus an empty `actor`, and proto3 omits a field equal to its default, so an empty `actor` is genuinely zero bytes.

Nothing in protobus compresses or batches. If your payloads are large enough for this to matter, the envelope is not what you should be looking at — see [Streaming](../guide/streaming.md).

---

<div align="center">

**[← Architecture](./architecture.md)** · **[Docs index](../README.md)** · **[Delivery Guarantees →](./delivery-guarantees.md)**

</div>
