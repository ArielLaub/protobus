<div align="center">

# ProtoBus Documentation

**Schema-first RPC over RabbitMQ, without adopting an application framework.**

[![npm](https://img.shields.io/npm/v/protobus.svg?logo=npm)](https://www.npmjs.com/package/protobus)
[![node](https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-%E2%89%A53.8-FF6600?logo=rabbitmq&logoColor=white)](https://www.rabbitmq.com)
[![license](https://img.shields.io/npm/l/protobus.svg)](../LICENSE)

</div>

---

ProtoBus has one job: make Protobuf-defined services communicate reliably through
RabbitMQ while leaving the rest of your application architecture alone.

If you remember only five things, remember these:

1. **The `.proto` is the contract.** It is shared across languages.
2. **Protobuf is the wire format.** Payloads are compact binary messages, not a JSON-first framework envelope.
3. **RabbitMQ is part of the architecture.** Queues, routing, competing consumers, acknowledgements and redelivery belong in the broker.
4. **Delivery semantics are explicit.** Publisher confirms, retries, reconnect and shutdown are treated as distributed-systems invariants.
5. **Bring your own stack.** ProtoBus does not bundle DI, HTTP, persistence, validation, logging or application modules.

---

## Start here

| I want to… | Go to | Time |
|---|---|---|
| **See it work before I read anything** | [Run the sample](#run-the-sample-in-60-seconds) | 1 min |
| **Understand the idea** | [Why ProtoBus](./why-protobus.md) → [Design Principles](./design-principles.md) | 10 min |
| **Decide whether to adopt it** | [Why ProtoBus](./why-protobus.md) → [Architecture](./concepts/architecture.md) | 15 min |
| **Build my first service** | [Getting Started](./guide/getting-started.md) → [CLI](./reference/cli.md) → [Configuration](./reference/configuration.md) | 30 min |
| **Understand what success proves** | [Delivery Guarantees](./concepts/delivery-guarantees.md) | 15 min |
| **Add events or streaming** | [Events](./guide/events.md) · [Streaming RPC](./guide/streaming.md) | — |
| **Operate it in production** | [Operations](#operations) | — |
| **Look something up** | [Reference](#reference) · [Troubleshooting](./operations/troubleshooting.md) | — |
| **Upgrade an existing service** | [Migration](./migration.md) · [CHANGELOG](../CHANGELOG.md) | — |

### Run the sample in 60 seconds

```bash
git clone https://github.com/ArielLaub/protobus && cd protobus && npm install
npm run docker:up
bash scripts/run-combat-sample.sh
```

Six services fight a battle royale over the bus — RPC, pub/sub events, and clean
shutdown in one run — and the script asserts exactly one player survived. Open
<http://localhost:15672> (`guest`/`guest`) to watch the queues while it runs.
The source is [`sample/combatGame`](../sample/combatGame).

---

## Guide

Task-oriented, and read in order: each page assumes the ones above it. Nothing
here introduces a framework container — a service stays an ordinary class.

| # | Page | What it gives you |
|---|---|---|
| 1 | **[Getting Started](./guide/getting-started.md)** | `.proto` → service → process → client, and an event that arrives |
| 2 | **[Schema Design](./guide/schema.md)** | Writing the `.proto` that is your language-neutral contract |
| 3 | **[Events](./guide/events.md)** | Publish/subscribe on RabbitMQ topic routing, wildcards included |
| 4 | **[Error Handling](./guide/error-handling.md)** | Terminal vs retriable failures, the retry ladder, the DLQ |
| 5 | **[Testing](./guide/testing.md)** | Unit, integration and end-to-end, without a broker where possible |
| 6 | **[Patterns](./guide/patterns.md)** | Worked examples composed from all of the above |
| — | [Streaming RPC](./guide/streaming.md) | `returns (stream Chunk)`, bounded buffering, cancellation |
| — | [Message Priority](./guide/priority.md) | Broker-native priority: letting control messages overtake a bulk backlog |

---

## Concepts

*Why* it behaves the way it does. Read once, refer back.

| Page | Question it answers |
|---|---|
| **[Why ProtoBus](./why-protobus.md)** | When is this the right tool, and when is gRPC, a framework, or raw AMQP better? |
| **[Design Principles](./design-principles.md)** | What belongs in ProtoBus, and what intentionally does not? |
| **[Architecture](./concepts/architecture.md)** | What does a service create in the broker, and why one queue with N consumers? |
| **[Message Flow](./concepts/message-flow.md)** | What happens between `proxy.method()` and the reply, on the wire? |
| **[Delivery Guarantees](./concepts/delivery-guarantees.md)** | What does success prove, what can duplicate, and what is ambiguous? |

---

## Reference

Reference pages are boring and exact. They document the library as it is.

| Page | |
|---|---|
| **[Configuration](./reference/configuration.md)** | Every environment variable and its real default — the few messaging knobs ProtoBus owns |
| **[CLI](./reference/cli.md)** | `generate`, `generate:service`, and what they actually emit; the `.proto` stays authoritative |
| **[Errors](./reference/errors.md)** | Every exported error class, and whether it means a definite failure or an ambiguous outcome |
| **[Custom Types](./reference/custom-types.md)** | `BigIntType`, `TimestampType`, registering your own, and what that means for other languages |

**API**

| Class | Use it to | |
|---|---|---|
| [Context](./reference/api/context.md) | hold the connection and the proto registry — one per process | |
| [MessageService](./reference/api/message-service.md) | implement a service | base class |
| [RunnableService](./reference/api/runnable-service.md) | implement a service that owns its process — a lifecycle helper, not an application host | preferred |
| [ServiceProxy](./reference/api/service-proxy.md) | call a remote service through its schema | |

---

## Operations

RabbitMQ is durable infrastructure, so operating it correctly is part of using
ProtoBus correctly. None of this is advanced; it is mandatory.

| Page | |
|---|---|
| **[Troubleshooting](./operations/troubleshooting.md)** | Symptom, cause, fix — start from the error text |
| **[Security](./operations/security.md)** | What `actor` does *not* prove, why topic permissions matter, and what leaves the process |
| **[Logging](./operations/logging.md)** | ProtoBus supplies a hook, not a logging stack: levels, your own sink, structured records |
| **[Queue Migration](./operations/queue-migration.md)** | Topology is persistent infrastructure; changing a live queue without losing messages |
| **[Known Issues](./operations/known-issues.md)** | Current limitations, stated plainly |

---

## How this documentation is kept honest

Every code block that carries a `doc-check` directive is compiled — and where it
claims an output, executed against a real broker — on every commit:

```bash
node scripts/check-doc-snippets.js     # compile and run the examples
node scripts/check-doc-links.js        # resolve every relative link and anchor
```

Both run in [CI](../.github/workflows/ci.yml). Claims a snippet cannot assert
about itself (that a recipe does *nothing* without a second line, that a method
does not exist) are pinned in
[`test/unit/documented_behaviour.test.ts`](../test/unit/documented_behaviour.test.ts)
and [`test/unit/trie_documented_examples.test.ts`](../test/unit/trie_documented_examples.test.ts).

Reliability claims link to [Delivery Guarantees](./concepts/delivery-guarantees.md)
rather than using shorthand like "guaranteed delivery". If you change a documented
behaviour, one of the checks above will tell you.

---

## Other languages

The contract is deliberately not TypeScript-specific. The `.proto` files are the
contract and RabbitMQ does the routing, so a port needs only protobuf and an AMQP
client.

| Language | Repo | Status |
|---|---|---|
| TypeScript / Node | [protobus](https://github.com/ArielLaub/protobus) | stable |
| Python | [protobus-py](https://github.com/ArielLaub/protobus-py) | stable |
| Go | [protobus-go](https://github.com/ArielLaub/protobus-go) | experimental |

The goal of a port is wire compatibility and equivalent messaging semantics, not
a line-for-line copy of the TypeScript API. Differences between ports are recorded
per feature — see [Priority → Cross-language](./guide/priority.md#cross-language).

---

<div align="center">

Documentation for **protobus 2.3.x** · [CHANGELOG](../CHANGELOG.md) · [Report a docs issue](https://github.com/ArielLaub/protobus/issues)

</div>
