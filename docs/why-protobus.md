# Why ProtoBus

> The case for choosing it, the case against, and how it compares with direct gRPC, NestJS, Moleculer, Seneca and raw AMQP.

**Read this if** you are deciding whether to adopt ProtoBus, or explaining that decision to someone else.

| | |
|---|---|
| **Prerequisites** | none |
| **Next** | [Design Principles](./design-principles.md) · [Getting Started](./guide/getting-started.md) · [Architecture](./concepts/architecture.md) |
| **Source** | [`lib/`](../lib) |

**On this page:** [The short version](#the-short-version) · [Not the application](#the-other-half-of-the-idea-do-not-become-the-application) · [Why not NestJS](#why-not-just-use-nestjs-microservices) · [Why not gRPC](#why-not-direct-grpc) · [Why not raw AMQP](#why-not-raw-amqplib--protobufjs) · [Framework comparison](#framework-comparison) · [Reliability philosophy](#reliability-philosophy) · [The intended niche](#the-intended-niche) · [Performance](#performance)

---

ProtoBus is for developers who like **small composable libraries** and want
**Protobuf-style RPC with RabbitMQ semantics**.

It is not trying to be NestJS, Moleculer, gRPC, or a generic broker abstraction.
Those projects solve different problems.

## The short version

Direct gRPC gives you an excellent schema-first, cross-language RPC model:

```text
Service A ───── HTTP/2 + Protobuf ─────> Service B
```

ProtoBus keeps the Protobuf contract but inserts a durable broker:

```text
Service A ─────> RabbitMQ ─────> Service B
                    │
                    ├─ queue owns outstanding work
                    ├─ competing consumers
                    ├─ acknowledgements / redelivery
                    ├─ topic routing
                    ├─ retry / DLQ topology
                    └─ publisher confirms
```

That makes ProtoBus useful when "the callee is temporarily unavailable" should
not necessarily mean "the work ceased to exist."

## The other half of the idea: do not become the application

A messaging library should not force a dependency-injection container, controller
model, ORM, logger, HTTP framework or module system on the application.

ProtoBus deliberately stops at the messaging boundary.

```text
your application
├─ your DI choice
├─ your HTTP choice
├─ your database choice
├─ your validation choice
├─ your logger/metrics choice
└─ ProtoBus
   ├─ RabbitMQ transport semantics
   └─ Protobuf contracts
```

This boundary is deliberate; it does not mean the framework is incomplete.

## Why not just use NestJS microservices?

NestJS is a much broader application framework. Its strengths are exactly the
things ProtoBus chooses not to own: modules, DI, decorators, controllers,
interceptors, guards, application lifecycle and a large integrated ecosystem.

If you want those conventions, Nest is a strong choice.

If you want messaging to be one replaceable library among other independently
chosen libraries, ProtoBus is intentionally a better fit.

The RabbitMQ difference matters too. ProtoBus is not designed around a
lowest-common-denominator transport abstraction. RabbitMQ topology and settlement
semantics are part of the model.

## Why not direct gRPC?

Use gRPC when direct point-to-point RPC is the right architecture. It is mature,
fast, polyglot and has built-in Protobuf support.

ProtoBus is interesting when you additionally want:

- durable broker ownership of queued work
- competing consumers without client-side discovery/load balancing
- broker acknowledgements and redelivery
- topic-based events
- RabbitMQ priority and DLQ features
- caller and callee decoupling in time

The shorthand "gRPC on steroids" is useful conversationally, but the precise
description is:

> **gRPC-style contracts over a durable message bus.**

ProtoBus is not wire-compatible with gRPC and does not claim to replace it.

## Why not raw `amqplib + protobufjs`?

That is the real lower bound, and for some systems it is the right answer.

Raw libraries give you maximum control, but every application then has to decide
and implement:

- service/routing conventions
- RPC correlation
- request timeouts
- reply publication
- publisher confirms
- unroutable messages
- reconnect restoration
- graceful draining
- retry hand-off
- errors
- streams and cancellation
- cross-language protocol details

ProtoBus exists so those invariants can be implemented once, tested once and
documented once without adding an application framework around them.

## Why RabbitMQ-native?

RabbitMQ is more than a byte pipe. Its useful semantics include queues, competing
consumers, topic exchanges, acknowledgements, redelivery, priorities, TTL/DLX and
publisher confirms.

A transport-agnostic abstraction has to either hide those features or model them
indirectly. ProtoBus makes the opposite trade: it intentionally commits to
RabbitMQ so it can use RabbitMQ correctly.

There is also a performance angle: app-level routing in JavaScript means routing
logic runs on your event loop, competing with your business logic for CPU time.
RabbitMQ's Erlang runtime was purpose-built for message switching.

## Why Protobuf-native?

The schema does three jobs at once:

1. wire encoding
2. service contract
3. language-neutral type definition

That is more important than "binary is smaller than JSON." The real benefit is
that the contract is external to any one runtime.

The same `.proto` is consumed by TypeScript, Python, Go and C++ implementations.

## Cross-language is a core property

ProtoBus does not call itself cross-language only because another language
could theoretically publish AMQP messages.

There are first-party compatible implementations:

- [protobus](https://github.com/ArielLaub/protobus) (TypeScript)
- [protobus-py](https://github.com/ArielLaub/protobus-py) (Python)
- [protobus-go](https://github.com/ArielLaub/protobus-go) (Go)
- [protobus-cpp](https://github.com/ArielLaub/protobus-cpp) (C++)

That constraint is healthy for the TypeScript implementation: wire behavior
cannot casually depend on JavaScript-only object conventions. Where the ports
differ, the difference is recorded per feature; see
[Priority → Cross-language](./guide/priority.md#cross-language).

Interoperability is tested: protobus-go's CI runs Go, TypeScript
and Python services and clients against each other, in both directions, on a
real RabbitMQ 3 and 4, with replicas in different languages sharing one queue.
protobus-cpp's CI runs C++ against the TypeScript, Python and Go ports the same
way.
This repository's own cross-language test is not part of its CI, because it
needs the other ports checked out beside it.

---

## Framework comparison

| Aspect | ProtoBus | Moleculer | NestJS | Seneca |
|--------|----------|-----------|--------|--------|
| **Philosophy** | RabbitMQ-native | Transport-agnostic | Full framework | Pattern-based |
| **Transport** | RabbitMQ only | 10+ transporters | 7+ transporters | Pluggable |
| **Serialization** | Protocol Buffers | JSON (default) | JSON (default) | JSON |
| **Schema** | Required `.proto` | Optional | Optional (DTOs) | None |
| **Routing** | Broker-native | App-level | App-level | Pattern matching |
| **Load balancing** | Broker-level | App-level | App-level | App-level |
| **Cross-language** | Native (proto + AMQP) | Reimplement protocol | Reimplement protocol | Reimplement protocol |
| **App framework included** | No | Partly (gateway, caching) | Yes | No |

"At-least-once, broker-acknowledged" is defined precisely in
[Delivery Guarantees](./concepts/delivery-guarantees.md); it is not "guaranteed
delivery" and this documentation avoids that phrase.

## What ProtoBus is not

[Moleculer](https://moleculer.services/) is one of the most popular Node.js
microservices frameworks, known for its extensive feature set and transport
flexibility.

**How it works:** Moleculer implements its own service registry, load balancer
and routing layer. The transporter (RabbitMQ, NATS, Redis, etc.) is a message
pipe; Moleculer handles everything else in application code.

| Aspect | Moleculer | ProtoBus |
|--------|-----------|----------|
| Routing | App-level service registry | Native RabbitMQ topic exchanges |
| Load balancing | Tracks instances, picks one | Competing consumers on a queue |
| On consumer crash | Message may be lost | Redelivered to another consumer |
| Serialization | JSON by default | Protobuf binary |
| Schema | Runtime validation (optional) | Compile-time `.proto` contracts |
| Persistence | Depends on transporter config | Native durable queues |

**When to choose Moleculer:** you need to switch brokers without code changes,
you want batteries included (API gateway, caching, tracing), or you are building
a monolith that might become microservices later.

### NestJS microservices

[NestJS](https://nestjs.com/) is a full-featured framework for server-side
applications, with a microservices module that supports multiple transports.

**How it works:** request-response or event-based patterns over various
transports, with routing and load balancing at the application level, inside an
opinionated architecture of decorators, modules and dependency injection.

| Aspect | NestJS | ProtoBus |
|--------|--------|----------|
| Scope | Full framework | Messaging only |
| Architecture | Opinionated (modules, decorators) | Ordinary classes, your DI or none |
| Transport usage | Abstracted | Native RabbitMQ features |
| Serialization | JSON | Protobuf binary |
| Message reliability | Transport-dependent | Broker-acknowledged, at-least-once |

**When to choose NestJS:** you want one framework for everything (HTTP API plus
microservices), you like Angular-style architecture, or you need its ecosystem
and community.

### Seneca

[Seneca](https://senecajs.org/) is a microservices toolkit focused on pattern
matching and a plugin architecture.

**How it works:** messages are routed by pattern matching rather than service
names. You define patterns like `{ role: 'math', cmd: 'sum' }` and Seneca routes
to matching handlers. Transport is pluggable.

| Aspect | Seneca | ProtoBus |
|--------|--------|----------|
| Routing | Pattern matching (app-level) | Topic exchanges (broker-level) |
| Schema | None (dynamic patterns) | Required `.proto` contracts |
| Type safety | Runtime only | Compile-time |
| Serialization | JSON | Protobuf binary |

**When to choose Seneca:** you prefer pattern-based over service-based thinking,
you are decomposing a monolith incrementally, or you want maximum flexibility in
message routing.

### MassTransit (.NET)

While not a Node.js framework, [MassTransit](https://masstransit.io/) deserves
mention because it shares ProtoBus's philosophy: primarily RabbitMQ-native, with
other transports added later, and using broker features directly. If you
are in the .NET ecosystem, it is the closest equivalent, and it proves the
broker-native approach works at scale.

---

## Reliability philosophy

ProtoBus asks a simple question repeatedly:

> **What does success actually prove?**

Examples:

- A publish resolving should mean the broker confirmed it, not only that bytes
  entered a local buffer.
- Retry hand-off should not acknowledge the old delivery before the replacement
  publication is confirmed.
- Reconnection should mean topology/consumers are restored, not only that a TCP
  socket exists.
- Graceful shutdown should stop intake and drain in-flight settlement before
  disconnecting.
- Ambiguous outcomes should stay ambiguous instead of being mislabeled success or
  failure.

This does not create exactly-once execution. RabbitMQ systems remain at-least-once
where redelivery is possible, and idempotency is still an application concern,
which is why a caller can pin a stable `messageId` on a publish and deduplicate
on it.

See [Delivery Guarantees](./concepts/delivery-guarantees.md).

## The intended niche

Choose ProtoBus when these statements sound like you:

- "The `.proto` should be the contract."
- "I want RabbitMQ because I actually want a broker."
- "I want the same service contract across languages."
- "I care what an acknowledgement or publisher confirm really means."
- "I do not want my messaging library to choose my DI/HTTP/ORM/logger."
- "I prefer a small dependency graph and a small conceptual surface."

Choose something broader when you want a framework to make many of those choices
for you.

Choose direct gRPC when you do not need broker semantics.

Choose raw AMQP when ProtoBus's RPC conventions themselves are more abstraction
than you want.

That boundary is the point.

---

## Performance

> [!WARNING]
> **The numbers below are not reproducible from this repository.** The benchmark
> harness that produced them was never committed: `find . -iname "*bench*"`
> returns nothing, and `sample/` holds only `combatGame` and `tokenStream`. An
> earlier version of this page said "benchmark code available in the
> repository", which was not true.
>
> Treat the table as a recorded result from the authors, on their hardware, at
> an unrecorded version of both libraries. Nothing here has been re-measured.
> Measure your own workload before it matters to you: payload shape dominates,
> and the gap on a 100-byte message is not the gap on a 139 KB one.
>
> Contributing a runnable harness (ideally alongside
> [`scripts/run-combat-sample.sh`](../scripts/run-combat-sample.sh), so CI could
> run it) would close this, and is welcome.

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

**[← Docs index](./README.md)** · **[Design Principles →](./design-principles.md)** · **[Getting Started →](./guide/getting-started.md)**

</div>
