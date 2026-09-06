# Design Principles

> What belongs in ProtoBus, what intentionally does not, and the rules a change is judged against.

**Read this if** you are proposing a feature, reviewing one, or deciding whether something you need should live in ProtoBus or next to it.

| | |
|---|---|
| **Prerequisites** | [Why ProtoBus](./why-protobus.md) |
| **Next** | [Architecture](./concepts/architecture.md) · [Delivery Guarantees](./concepts/delivery-guarantees.md) |
| **Source** | [`lib/`](../lib) |

**On this page** — [Messaging, not the application](#1-solve-messaging-not-the-application) · [Standards](#2-prefer-standards-over-proprietary-representations) · [RabbitMQ is not plumbing](#3-rabbitmq-is-not-replaceable-plumbing) · [A Promise means something](#4-a-resolved-promise-must-have-a-defined-meaning) · [Failure paths](#5-make-failure-paths-first-class) · [Small](#6-stay-small-enough-to-understand) · [Cross-language](#7-cross-language-compatibility-constrains-the-design) · [Schema is truth](#8-the-schema-is-the-source-of-truth) · [Idempotency](#9-at-least-once-means-idempotency-matters) · [Composition](#10-boring-composition-is-a-feature)

---

ProtoBus should be easy to describe because its boundary should be easy to see.

## 1. Solve messaging, not the application

ProtoBus owns:

- Protobuf schema loading and serialization
- service/RPC conventions
- RabbitMQ topology used by those conventions
- request/reply correlation
- events
- streaming
- publisher confirmation
- consumer settlement
- retries/DLQ behavior
- reconnect restoration
- graceful messaging shutdown

ProtoBus does **not** own:

- dependency injection
- HTTP APIs
- persistence
- validation
- application configuration
- business logging
- tracing vendors
- application modules
- project layout

A feature request that belongs in the second list should normally be solved by
composition, not by expanding ProtoBus.

## 2. Prefer standards over proprietary representations

The contract is Protocol Buffers. The broker is RabbitMQ/AMQP. Cross-language
ports should be able to implement the protocol from documented wire/topology
semantics without emulating JavaScript internals.

## 3. RabbitMQ is not replaceable plumbing

ProtoBus should use RabbitMQ's native strengths directly rather than reimplement
them in Node:

- queues for ownership of outstanding work
- competing consumers for load distribution
- exchanges/routing keys for routing
- acknowledgements/redelivery for consumer failure
- DLX/TTL/priority where appropriate
- publisher confirms for publish outcome

Transport portability is not a design goal if achieving it weakens those
semantics.

## 4. A resolved Promise must have a defined meaning

Async APIs should document the event that makes them resolve.

If the real world can produce an ambiguous outcome, expose ambiguity. Do not turn
uncertainty into a convenient boolean. [Delivery Guarantees](./concepts/delivery-guarantees.md)
is where those meanings are written down, and [Errors](./reference/errors.md)
is where definite failures and ambiguous outcomes get distinct types.

## 5. Make failure paths first-class

Reconnect, shutdown, broker backpressure, unroutable messages, duplicate delivery,
timeouts and partial failure are normal distributed-system states, not edge-case
afterthoughts.

Tests should spend disproportionate effort there.

## 6. Stay small enough to understand

A small dependency graph is valuable because messaging is infrastructure code.
Developers should be able to trace the path from a service call to the RabbitMQ
operation without crossing an application framework.

Small does not mean incomplete. The messaging invariants should be implemented
deeply even when the public API remains narrow.

## 7. Cross-language compatibility constrains the design

A TypeScript convenience is not worth silently making the wire protocol
JavaScript-specific.

New custom types, schema features and envelope changes should be reviewed for
Python/Go/other-runtime compatibility before becoming part of the protocol.
Where a port has to differ, the difference is recorded next to the feature, as
[Priority → Cross-language](./guide/priority.md#cross-language) does.

## 8. The schema is the source of truth

Generated TypeScript is derived output. Runtime dispatch is derived behavior.
Documentation examples should follow the `.proto`, not create a second competing
contract system.

## 9. At-least-once means idempotency matters

ProtoBus should provide stable message identity and precise delivery semantics,
but it should not claim magical exactly-once execution.

Applications with side effects should be able to build idempotency on top of the
identity and settlement guarantees ProtoBus exposes — a caller-supplied
`messageId` survives every redelivery and every retry hop for exactly that reason.

## 10. Boring composition is a feature

A ProtoBus service should remain an ordinary class. Constructor injection should
work. A plain test should work. A different HTTP framework should not matter.

The ideal integration story is:

```text
choose your libraries
        +
choose your infrastructure
        +
ProtoBus handles messaging
```

not:

```text
adopt ProtoBus
    ↓
adopt the ProtoBus way to build your whole application
```

---

<div align="center">

**[← Why ProtoBus](./why-protobus.md)** · **[Docs index](./README.md)** · **[Architecture →](./concepts/architecture.md)**

</div>
