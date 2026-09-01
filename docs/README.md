<div align="center">

# ProtoBus Documentation

**RabbitMQ-native microservices with Protocol Buffers.**

[![npm](https://img.shields.io/npm/v/protobus.svg)](https://www.npmjs.com/package/protobus)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![rabbitmq](https://img.shields.io/badge/rabbitmq-3.8%2B-orange.svg)](https://www.rabbitmq.com)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

</div>

---

## Start here

| I want to… | Go to | Time |
|---|---|---|
| **See it work before I read anything** | [Run the sample](#run-the-sample-in-60-seconds) | 1 min |
| **Decide whether to adopt it** | [Why ProtoBus](../README.md#why-protobus) → [Architecture](./architecture.md) → [Similar Libraries](./similar-libraries.md) | 15 min |
| **Build my first service** | [Getting Started](./getting-started.md) → [CLI](./cli.md) → [Configuration](./configuration.md) | 30 min |
| **Look something up** | [API Reference](#api-reference) · [Troubleshooting](./troubleshooting.md) | — |
| **Upgrade an existing service** | [Migration Guide](./migration.md) · [CHANGELOG](../CHANGELOG.md) | — |

### Run the sample in 60 seconds

```bash
git clone https://github.com/ArielLaub/protobus && cd protobus && npm install
npm run docker:up
bash scripts/run-combat-sample.sh
```

Six services fight a battle royale over the bus — RPC, pub/sub events, and clean
shutdown in one run — and the script asserts exactly one player survived. Open
<http://localhost:15672> (`guest`/`guest`) to watch the queues while it runs.

---

## Learn

Read in this order. Each page assumes the ones above it.

| # | Page | What it gives you |
|---|---|---|
| 1 | **[Getting Started](./getting-started.md)** | A running service and a client that calls it |
| 2 | **[Architecture](./architecture.md)** | What that service created in the broker, and why |
| 3 | **[Protobuf Schema Design](./advanced/protobuf-schema.md)** | How to write the `.proto` that is your contract |
| 4 | **[CLI](./cli.md)** | Generating types and service stubs from it |
| 5 | **[Configuration](./configuration.md)** | Timeouts, concurrency, reconnection, heartbeats |
| 6 | **[Error Handling](./advanced/error-handling.md)** | Retriable vs. terminal, the retry ladder, the DLQ |
| 7 | **[Examples](./examples.md)** | Patterns assembled from all of the above |

---

## API reference

| Class | Use it to | |
|---|---|---|
| **[Context](./api/context.md)** | hold the connection and the proto registry — one per process | |
| **[MessageService](./api/message-service.md)** | implement a service | base class |
| **[RunnableService](./api/runnable-service.md)** | implement a service that owns its process | preferred |
| **[ServiceProxy](./api/service-proxy.md)** | call a remote service | |
| **[Events](./api/events.md)** | publish and subscribe | |
| **[Custom Types](./advanced/protobuf-schema.md#built-in-custom-types)** | serialise `BigInt`, timestamps, your own types | |

---

## Going further

<table>
<tr><td width="50%" valign="top">

**Capabilities**

- [Streaming RPC](./advanced/streaming.md) — `returns (stream Chunk)`, backpressure, cancellation
- [Message Priority](./advanced/priority.md) — letting control messages overtake a bulk backlog
- [Structured Logging](./advanced/structured-logging.md) — machine-readable log records
- [Custom Logger](./advanced/custom-logger.md) — Winston, Pino, Bunyan

</td><td width="50%" valign="top">

**Operating it**

- [Security Model](./advanced/security.md) — what `actor` does *not* prove
- [Queue Migration](./advanced/queue-migration.md) — changing settings on live queues
- [Troubleshooting](./troubleshooting.md) — symptom → cause → fix
- [Known Issues](./known-issues.md) — current limitations

</td></tr>
</table>

---

## Other languages

The `.proto` files are the contract, and RabbitMQ does the routing — so a port
only needs protobuf and an AMQP client.

| Language | Repo | Status |
|---|---|---|
| TypeScript / Node | [protobus](https://github.com/ArielLaub/protobus) | stable |
| Python | [protobus-py](https://github.com/ArielLaub/protobus-py) | stable |
| Go | [protobus-go](https://github.com/ArielLaub/protobus-go) | experimental |

Differences between ports are recorded per feature — see
[Priority → Cross-language](./advanced/priority.md#cross-language).

---

<div align="center">

Documentation for **protobus 2.2.x** · [CHANGELOG](../CHANGELOG.md) · [Report a docs issue](https://github.com/ArielLaub/protobus/issues)

</div>
