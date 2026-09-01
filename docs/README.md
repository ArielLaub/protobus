<div align="center">

# ProtoBus Documentation

**RabbitMQ-native microservices with Protocol Buffers.**

[![npm](https://img.shields.io/npm/v/protobus.svg?logo=npm)](https://www.npmjs.com/package/protobus)
[![node](https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-%E2%89%A53.8-FF6600?logo=rabbitmq&logoColor=white)](https://www.rabbitmq.com)
[![license](https://img.shields.io/npm/l/protobus.svg)](../LICENSE)

</div>

---

## Start here

| I want to… | Go to | Time |
|---|---|---|
| **See it work before I read anything** | [Run the sample](#run-the-sample-in-60-seconds) | 1 min |
| **Decide whether to adopt it** | [Why ProtoBus](./why-protobus.md) → [Architecture](./concepts/architecture.md) | 15 min |
| **Build my first service** | [Getting Started](./guide/getting-started.md) → [CLI](./reference/cli.md) → [Configuration](./reference/configuration.md) | 30 min |
| **Understand why it is reliable** | [Delivery Guarantees](./concepts/delivery-guarantees.md) | 15 min |
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

Read in order. Each page assumes the ones above it.

| # | Page | What it gives you |
|---|---|---|
| 1 | **[Getting Started](./guide/getting-started.md)** | A running service, a client that calls it, and an event that arrives |
| 2 | **[Schema Design](./guide/schema.md)** | Writing the `.proto` that is your contract |
| 3 | **[Events](./guide/events.md)** | Publish/subscribe, topics and wildcards |
| 4 | **[Error Handling](./guide/error-handling.md)** | Retriable vs terminal, the retry ladder, the DLQ |
| 5 | **[Testing](./guide/testing.md)** | Unit, integration and end-to-end, without a broker where possible |
| 6 | **[Patterns](./guide/patterns.md)** | Worked examples assembled from all of the above |
| — | [Streaming RPC](./guide/streaming.md) | `returns (stream Chunk)`, backpressure, cancellation |
| — | [Message Priority](./guide/priority.md) | Letting control messages overtake a bulk backlog |

---

## Concepts

How it works. Read once, refer back.

| Page | |
|---|---|
| **[Architecture](./concepts/architecture.md)** | What a service creates in the broker, and why the design is one queue with N consumers |
| **[Message Flow](./concepts/message-flow.md)** | The wire format and one round trip in detail |
| **[Delivery Guarantees](./concepts/delivery-guarantees.md)** | Acks, publish confirms, the retry ladder's headers, duplicates, and the parked caller |

---

## Reference

| Page | |
|---|---|
| **[Configuration](./reference/configuration.md)** | Every environment variable and its real default |
| **[CLI](./reference/cli.md)** | `generate`, `generate:service`, and what they actually emit |
| **[Errors](./reference/errors.md)** | Every exported error class and the condition that throws it |
| **[Custom Types](./reference/custom-types.md)** | `BigIntType`, `TimestampType`, and registering your own |

**API**

| Class | Use it to | |
|---|---|---|
| [Context](./reference/api/context.md) | hold the connection and the proto registry — one per process | |
| [MessageService](./reference/api/message-service.md) | implement a service | base class |
| [RunnableService](./reference/api/runnable-service.md) | implement a service that owns its process | preferred |
| [ServiceProxy](./reference/api/service-proxy.md) | call a remote service | |

---

## Operations

Running it in production. None of this is advanced; it is mandatory.

| Page | |
|---|---|
| **[Troubleshooting](./operations/troubleshooting.md)** | Symptom, cause, fix — start from the error text |
| **[Security](./operations/security.md)** | What `actor` does *not* prove, and what leaves the process |
| **[Logging](./operations/logging.md)** | Levels, your own sink, structured records, payload diagnostics |
| **[Queue Migration](./operations/queue-migration.md)** | Changing settings on a live queue without losing messages |
| **[Known Issues](./operations/known-issues.md)** | Current limitations |

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

If you change a documented behaviour, one of those will tell you.

---

## Other languages

The `.proto` files are the contract and RabbitMQ does the routing, so a port
needs only protobuf and an AMQP client.

| Language | Repo | Status |
|---|---|---|
| TypeScript / Node | [protobus](https://github.com/ArielLaub/protobus) | stable |
| Python | [protobus-py](https://github.com/ArielLaub/protobus-py) | stable |
| Go | [protobus-go](https://github.com/ArielLaub/protobus-go) | experimental |

Differences between ports are recorded per feature — see
[Priority → Cross-language](./guide/priority.md#cross-language).

---

<div align="center">

Documentation for **protobus 2.2.x** · [CHANGELOG](../CHANGELOG.md) · [Report a docs issue](https://github.com/ArielLaub/protobus/issues)

</div>
