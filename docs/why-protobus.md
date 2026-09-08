# Why ProtoBus

> The case for choosing it, the case against, and what it deliberately does not do.

**Read this if** you are deciding whether to adopt protobus, or explaining that decision to someone else.

| | |
|---|---|
| **Prerequisites** | none |
| **Next** | [Getting Started](./guide/getting-started.md) · [Architecture](./concepts/architecture.md) |
| **Source** | [`lib/`](../lib) |

**On this page** — [The choice](#the-choice) · [Porting](#porting-to-another-language) · [What it is not](#what-protobus-is-not) · [When to choose it](#when-to-choose-protobus) · [Performance](#performance)

---

## The choice

Most Node microservice frameworks are **transport-agnostic**: they abstract the
message broker so that RabbitMQ, Redis, NATS or Kafka can be swapped underneath
the same application code. That is a real feature, and if you need it, protobus
is the wrong library.

ProtoBus makes the opposite trade. It targets **RabbitMQ only**, and the things
a broker is good at are left to the broker rather than implemented above it:

| Concern | Where it lives in protobus |
|---|---|
| Load balancing | competing consumers on one queue |
| Routing | topic exchange bindings (`REQUEST.<Service>.*`) |
| Redelivery on consumer loss | late ack — an unacked delivery returns to the queue |
| Retry delay | the retry queue's `x-message-ttl`, drained by DLX |
| Persistence | durable queues, persistent messages |
| Dead letters | a real `<Service>.DLQ` |
| Priority | native queue priorities |

Two consequences follow from that, and they are the whole argument for the
library:

**There is less protobus in the path.** A message goes from a publisher to a
RabbitMQ exchange to a queue to a consumer. No process holds a registry of live
instances, so no process has a stale one. When a consumer dies mid-request, its
delivery was never acked and the broker gives it to another consumer — that is
queue behaviour, not recovery code.

**There is less protobus to reimplement.** See below.

What this costs you is written down honestly elsewhere: read
[Delivery Guarantees](./concepts/delivery-guarantees.md) before relying on any
of it, in particular [the one hop protobus does not
confirm](./concepts/delivery-guarantees.md#where-a-message-can-still-be-lost)
and [where duplicates come
from](./concepts/delivery-guarantees.md#where-duplicates-come-from).

---

## Porting to another language

This is the advantage that holds up best, and it comes from two connected
choices rather than from any single feature.

**A small dependency surface.** Three runtime dependencies: `amqplib`,
`protobufjs`, `source-map-support`. Pure logic translates to another language
fairly mechanically and can be checked against shared tests. A dependency
boundary does not — different API shapes, concurrency models, error handling and
lifecycle semantics all have to be re-established, and preserving behaviour
across that boundary is where the work actually is. Protobus has one such
boundary that matters, the AMQP client, and a port swaps `amqplib` for `pika`,
`amqp091-go` or whatever the target language uses.

**Broker-owned messaging behaviour.** Queueing, consumer distribution, retry
delays and dead-lettering are not translated at all, because they are not in the
library. They stay in RabbitMQ while you change the service language. Service
discovery and failure recovery — the parts hardest to validate in a port — are
not code a port inherits.

So the accurate claim is: *a small dependency surface plus broker-owned
messaging behaviour reduces the code and integration work another language
implementation requires.* Not that there is nothing to implement.

### There is an application protocol, and you do implement it

Protobuf over AMQP is not self-describing. A peer has to speak protobus's own
conventions:

- three envelope messages — `RequestContainer`, `ResponseContainer`,
  `EventContainer`
- the routing-key scheme, `REQUEST.<Service>.<method>`, and the rule that the
  envelope's `method` must agree with it
- the three exchanges — `proto.bus`, `proto.bus.callback`, `proto.bus.events` —
  and how replies are addressed by `replyTo` with `correlationId` echoed
- the error encoding on `ResponseContainer`
- for streaming, the `x-protobus-*` headers

That is a small protocol and it is written down in
[Message Flow](./concepts/message-flow.md), envelope definitions included. It is
not a protocol you can skip.

### The evidence

- [protobus-py](https://github.com/ArielLaub/protobus-py) and
  [protobus-go](https://github.com/ArielLaub/protobus-go) exist and interoperate
  with this implementation.
- `test/integration/cross-language.test.ts` runs a TypeScript client against a
  Python server over a real broker.

> [!WARNING]
> **The cross-language test is not part of CI.** The integration job runs with
> `--testPathIgnorePatterns "cross-language"`, because the test needs a sibling
> `protobus-py` checkout that the runner does not have
> ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). Interoperability
> is therefore checked by hand, not on every commit. Neither port is covered by
> this repository's test suite.

---

## What ProtoBus is not

- **Not transport-portable.** RabbitMQ is not an implementation detail here; it
  is the design. There is no adapter layer to point at Kafka.
- **Not a web framework.** No HTTP, no GraphQL, no WebSockets, no DI container,
  no API gateway. It moves messages between services.
- **Not schemaless.** Every call is a `.proto` contract. If you want to send an
  ad-hoc object, this is friction, not a feature.
- **Not exactly-once, and not lossless.** See
  [Delivery Guarantees](./concepts/delivery-guarantees.md).
- **Not a retry system for events.** A failed event handler drops its event —
  a deliberate default with real consequences. See
  [Known Issues](./operations/known-issues.md).

### Other options

If you are comparing, read their own documentation rather than a summary
written by a competitor:

- [Moleculer](https://moleculer.services/) — transport-agnostic, batteries
  included (API gateway, caching, tracing, metrics)
- [NestJS microservices](https://docs.nestjs.com/microservices/rabbitmq) — a
  full application framework; its RabbitMQ transport exposes broker settings
  including manual acknowledgements, prefetch and queue options
- [Seneca](https://senecajs.org/) — pattern-matching rather than
  service-and-method
- [MassTransit](https://masstransit.io/) — .NET, and closest in philosophy to
  protobus in that it leans on the broker rather than abstracting it

---

## When to choose ProtoBus

Choose it when:

- **RabbitMQ is already your broker**, or you are happy to commit to it
- **You want the broker's behaviour rather than a reimplementation of it** —
  competing consumers, topic routing, DLX, priorities
- **Contracts matter more than convenience** — `.proto` files as the interface
  between teams, and generated types that fail the build when they drift
- **You expect more than one language on the bus**
- **You want a small dependency footprint** you can read end to end

Choose something else when:

- **You may need to change brokers**
- **You want one framework for HTTP, GraphQL and messaging**
- **JSON is fine** and a schema step is overhead you do not want
- **Your messages are ad-hoc** and pinning them to a contract would slow you down
- **Losing a failed event is unacceptable and you want the library to solve it**

---

## Performance

> [!WARNING]
> **The numbers below are not reproducible from this repository.** The benchmark
> harness that produced them was never committed — `find . -iname "*bench*"`
> returns nothing, and `sample/` holds only `combatGame` and `tokenStream`. An
> earlier version of this page said "benchmark code available in the
> repository", which was not true.
>
> Treat the table as a recorded result from the authors, on their hardware, at
> an unrecorded version of both libraries. Nothing here has been re-measured.
> Measure your own workload before it matters to you: payload shape dominates,
> and the gap on a 100-byte message is not the gap on a 139 KB one.
>
> Contributing a runnable harness — ideally alongside
> [`scripts/run-combat-sample.sh`](../scripts/run-combat-sample.sh), so CI could
> run it — would close this, and is welcome.

Reported by the authors, both libraries on the same hardware against the same
RabbitMQ, using a single shared publisher context:

| Scenario | Payload | ProtoBus | Moleculer | Difference |
|----------|---------|----------|-----------|------------|
| **Simple RPC** | ~100 bytes | 15,698 msg/sec | 12,269 msg/sec | +28% |
| **Complex Order** | ~5 KB | 8,880 msg/sec | 8,032 msg/sec | +10% |
| **Metrics Batch** | ~139 KB | 637 msg/sec | 567 msg/sec | +12% |

Method, as recorded: RabbitMQ 3.x for both; a single shared publisher context;
10 competing consumer instances; 50 warm-up messages; 10,000 measured messages
(simple and complex), 5,000 (metrics). The "Complex Order" payload is a
realistic e-commerce order with nested objects, arrays and a ~3 KB text field;
"Metrics" simulates time-series ingestion with 3,200 data points per message.
No latency distribution or resource use was recorded, and no confidence
interval can be given from a single run.

### What the architecture would predict

Separately from the measurement above, and not evidence for it:

- Protobuf encodes to fewer bytes than the equivalent JSON, so there is less to
  write and read.
- Protobus caches per-message-type analysis and skips the encode preprocessing
  walk entirely when a schema declares no custom types
  ([`lib/message_factory.ts`](../lib/message_factory.ts),
  `messageNeedsPreprocess`).
- Routing decisions happen in the broker, so they do not run on your event loop.

Whether any of that is visible in your workload is an empirical question these
numbers do not settle.

---

<div align="center">

**[← Docs index](./README.md)** · **[Docs index](./README.md)** · **[Getting Started →](./guide/getting-started.md)**

</div>
