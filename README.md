# ProtoBus

**Schema-first RPC over RabbitMQ. Protobuf on the wire. No application framework attached.**

[![npm version](https://img.shields.io/npm/v/protobus.svg?logo=npm)](https://www.npmjs.com/package/protobus)
[![node](https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-%E2%89%A53.8-FF6600?logo=rabbitmq&logoColor=white)](https://www.rabbitmq.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![CI](https://github.com/ArielLaub/protobus/actions/workflows/ci.yml/badge.svg)](https://github.com/ArielLaub/protobus/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/protobus.svg)](https://github.com/ArielLaub/protobus/blob/master/LICENSE)

ProtoBus takes the part of gRPC that works exceptionally well — a language-neutral
`.proto` contract, compact binary messages, typed RPC and streaming — and puts it
on a durable message bus instead of a direct HTTP/2 connection.

```text
                    RabbitMQ
                ┌──────┴──────┐
 TypeScript ────┤             ├──── Python
                │ Protobuf    │
                │ queues      │
                │ routing     │
                │ confirms    │
                │ redelivery  │
                └──────┬──────┘
                       │
                      Go
```

A service is defined once in Protobuf, implemented as an ordinary class, and can
be called from another process or another language. RabbitMQ owns routing, queueing,
competing consumers, backpressure and redelivery. ProtoBus owns the RPC contract,
serialization, correlation, streaming and lifecycle around that broker.

**ProtoBus solves messaging. It does not own your application.** Bring your own DI,
HTTP server, logger, validation, database layer, config system, tracing stack and
project layout. There is no container, module system or framework runtime you have
to adopt.

> **Cross-language:** [protobus-py](https://github.com/ArielLaub/protobus-py)
> (Python, stable) and [protobus-go](https://github.com/ArielLaub/protobus-go)
> (Go, stable) speak the same wire protocol and use the same `.proto`
> contracts.

---

## Install

```bash
npm install protobus
```

You also need a RabbitMQ 3.8+ broker:

```bash
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management-alpine
```

---

## Quick start

Four steps to a working RPC. Every snippet here is compiled and executed against
a real broker by [CI](https://github.com/ArielLaub/protobus/blob/master/scripts/check-doc-snippets.js)
on each commit.

### 1. Describe the service

<!-- doc-check: proto -->
```protobuf
// proto/Calculator.proto
syntax = "proto3";
package Calculator;

message AddRequest {
    int32 a = 1;
    int32 b = 2;
}

message AddResponse {
    int32 result = 1;
}

service Math {
    rpc add(Calculator.AddRequest) returns(Calculator.AddResponse);
}
```

Package plus service name is the service's name on the bus: `Calculator.Math`.

### 2. Implement it

<!-- doc-check: compile id=rm-service -->
```typescript
// src/calculator-service.ts
import { RunnableService } from 'protobus';

export class CalculatorService extends RunnableService {
    public get ServiceName(): string { return 'Calculator.Math'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}
```

No controller, DI container or module registration is required. `RunnableService`
is just the process-owning service base class; your other application dependencies
remain ordinary constructor dependencies.

### 3. Run it

<!-- doc-check: daemon id=rm-server needs=rm-service ready="Calculator.Math is up" broker -->
```typescript
// src/server.ts
import { Context, RunnableService } from 'protobus';
import { CalculatorService } from './calculator-service';

async function main() {
    const context = new Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto']);

    await RunnableService.start(context, CalculatorService);
    console.log('Calculator.Math is up');
}

main().catch((error) => { console.error(error); process.exit(1); });
```

`RunnableService.start` handles SIGINT/SIGTERM, stops consuming new work, drains
in-flight work, disconnects cleanly, and exits non-zero if startup fails.

### 4. Call it

<!-- doc-check: run id=rm-client with=rm-server broker expect="5 + 3 = 8" -->
```typescript
// src/client.ts
import { Context, ServiceProxy } from 'protobus';

interface CalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

async function main() {
    const context = new Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto']);

    const calculator = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calculator.init();

    const response = await calculator.add({ a: 5, b: 3 });
    console.log(`5 + 3 = ${response.result}`);

    // A client must close, or the open AMQP socket keeps the process alive.
    await context.connection.disconnect();
}

main().catch((error) => { console.error(error); process.exit(1); });
```

```
$ npx tsx src/client.ts
5 + 3 = 8
```

For generated interfaces instead of the handwritten type above, run
`npx protobus generate` — see [CLI](#cli) below.

Full walkthrough, including events and the project layout:
**[Getting Started](https://github.com/ArielLaub/protobus/blob/master/docs/guide/getting-started.md)**.

---

## Why ProtoBus exists

There are already excellent ways to build distributed systems. ProtoBus exists
for a narrower case:

> **You want Protobuf-style RPC, but you want RabbitMQ semantics rather than a
> direct point-to-point connection — and you do not want a full application
> framework deciding the rest of your stack.**

That leads to a few deliberate choices.

### 1. The `.proto` is the contract

The service definition is not a TypeScript decorator, a JSON pattern or a runtime
registration object. It is a language-neutral Protobuf schema — the
`Calculator.proto` above is the whole contract for `Calculator.Math`.

The same contract can be consumed from TypeScript, Python, Go, or any future port.
Schema changes can be checked at build time instead of being discovered after two
services disagree in production.

### 2. Protobuf is the actual wire format

ProtoBus does not wrap your payload in a JSON-first transport abstraction. Request,
response, event and stream payloads are encoded as Protocol Buffers.

That gives you a compact binary representation, explicit compatibility rules and
one schema that serves documentation, runtime serialization and generated types.

### 3. RabbitMQ is part of the design, not an interchangeable pipe

ProtoBus is deliberately RabbitMQ-native. It does not pretend RabbitMQ, Redis,
Kafka, NATS and TCP are equivalent transports.

A service maps naturally to a durable queue with competing consumers:

```text
                         ┌─ worker 1
caller ──> RabbitMQ queue├─ worker 2
                         └─ worker 3
```

RabbitMQ therefore handles the work it was built for:

- durable queues
- competing-consumer load distribution
- acknowledgements and redelivery
- topic routing
- dead-letter exchanges
- message priority
- flow control and broker-side backpressure

If a worker disappears before settlement, the broker still owns the delivery.
ProtoBus builds its retry, reply and shutdown rules around that fact instead of
reimplementing a service registry and load balancer in JavaScript.

If you may need to swap RabbitMQ for another broker, use a transport-agnostic
framework instead. That is a real feature and ProtoBus does not have it.

### 4. A resolved Promise should mean something

A recurring design question in ProtoBus is:

> **What does this Promise resolving actually prove?**

For publishing, success is coupled to a RabbitMQ publisher confirmation rather
than merely handing bytes to a local socket buffer. Retry hand-off confirms the
replacement publication before acknowledging the original. Reconnection restores
required topology and consumers before the connection is considered usable.
Graceful shutdown stops new work and drains in-flight work before disconnecting.

Distributed systems still have unavoidable ambiguous outcomes — for example a
connection can disappear while a publisher confirmation is in flight. ProtoBus
surfaces those cases rather than inventing certainty it does not have. See
[Delivery Guarantees](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/delivery-guarantees.md).

### 5. Bring your own application stack

ProtoBus intentionally does **not** provide:

- dependency injection
- HTTP routing
- an ORM or database abstraction
- validation middleware
- application modules
- a configuration framework
- a required logger
- a required tracing/metrics system

Those are not missing features. They are outside the library's responsibility.

Use constructor injection, Awilix, Inversify, tsyringe or no DI library at all.
Use Fastify, Express, Koa or no HTTP server. Use Pino, Winston or your own logger.
A messaging choice should not dictate your application architecture.

### 6. Keep the dependency and conceptual surface small

ProtoBus has three runtime dependencies:

```text
protobus
├── amqplib
├── protobufjs
└── source-map-support
```

The public mental model is similarly small:

```text
.proto contract
Context
MessageService / RunnableService
ServiceProxy
events / streaming
RabbitMQ
```

If you want an ecosystem that owns the whole server application, use one. ProtoBus
is for the opposite preference: small composable libraries with explicit boundaries.

---

## ProtoBus in one table

| | ProtoBus | Direct gRPC | Full microservice frameworks | Raw `amqplib + protobuf` |
|---|---|---|---|---|
| Contract | **Protobuf** | **Protobuf** | framework-specific / optional | whatever you build |
| Wire payload | **Protobuf** | **Protobuf** | commonly JSON or selectable | Protobuf if you build it |
| Connection model | **brokered** | point-to-point | varies | brokered |
| Durable queue | **yes** | no | transport-dependent | yes |
| Broker redelivery | **yes** | no | transport-dependent | yes |
| Events | **yes** | not the core model | usually | build it |
| Streaming RPC | **yes** | **yes** | varies | build it |
| Cross-language contract | **yes** | **yes** | varies | possible, you own protocol |
| App framework included | **no** | no | usually yes / broad | no |
| RPC/lifecycle semantics supplied | **yes** | **yes** | yes | no |

A useful shorthand is **"gRPC-style contracts over a durable message bus."** It is
not gRPC-compatible and it is not trying to replace gRPC everywhere. If direct,
low-latency point-to-point RPC is exactly what you need, gRPC is a strong choice.
ProtoBus is for systems where broker ownership of outstanding work is valuable.

The longer comparison, including Moleculer, NestJS and Seneca, and the cases
where you should choose something else:
**[Why ProtoBus](https://github.com/ArielLaub/protobus/blob/master/docs/why-protobus.md)**.

---

## RPC, events and streaming share one schema

Unary RPC:

<!-- doc-check: ignore why="excerpt of a service block, not a complete schema" -->
```protobuf
rpc getOrder(Orders.GetRequest) returns (Orders.Order);
```

Server streaming:

<!-- doc-check: ignore why="excerpt of a service block, not a complete schema" -->
```protobuf
rpc watchOrder(Orders.WatchRequest) returns (stream Orders.Update);
```

Events are ordinary Protobuf messages published by their fully-qualified message
type. The result is one vocabulary for synchronous-looking calls, asynchronous
notifications and streams without switching serialization formats or contract
systems.

- [Events](https://github.com/ArielLaub/protobus/blob/master/docs/guide/events.md)
- [Streaming RPC](https://github.com/ArielLaub/protobus/blob/master/docs/guide/streaming.md)
- [Message Priority](https://github.com/ArielLaub/protobus/blob/master/docs/guide/priority.md)

---

## Custom types

Protobuf's scalars do not cover everything. Register a custom type and it becomes
usable as a field type in your schemas, encoded and decoded transparently:

<!-- doc-check: compile -->
```typescript
import { Context, ICustomType } from 'protobus';

const UuidType: ICustomType<string> = {
    name: 'uuid',                 // how it is written in the .proto
    wireType: 'string',           // how it travels
    tsType: 'string',             // what generated types call it
    encode: (value: string) => value,
    decode: (data: string) => data,
};

async function main() {
    const context = new Context();

    // Register before init(): init() parses your .proto files, and a schema
    // using `uuid` cannot be parsed until the type exists.
    context.factory.registerType(UuidType);

    await context.init('amqp://localhost', ['./proto']);
}
```

<!-- doc-check: ignore why="uses a custom type, so it only parses in a process that has registered it first" -->
```protobuf
// The schema MUST declare syntax = "proto3" or protobufjs rejects the
// custom type with: illegal token 'uuid'
syntax = "proto3";
package Accounts;

message Account {
    uuid id = 1;
}
```

`BigIntType` and `TimestampType` ship with the library and are **already
registered**; registering either again is a no-op. A custom type is a convention
on top of a standard Protobuf wire type, so every language that consumes the
schema has to agree on it. Details, and the rules that make this work:
**[Custom Types](https://github.com/ArielLaub/protobus/blob/master/docs/reference/custom-types.md)**.

---

## Cross-language by design

Cross-language support is not an adapter bolted onto a TypeScript object protocol.
The shared pieces are intentionally language-neutral:

```text
contract      = Protocol Buffers
serialization = Protocol Buffers
broker        = RabbitMQ / AMQP
routing       = RabbitMQ topology + documented ProtoBus conventions
```

Current ports:

| Language | Implementation | Status |
|---|---|---|
| TypeScript / Node.js | [protobus](https://github.com/ArielLaub/protobus) | stable |
| Python | [protobus-py](https://github.com/ArielLaub/protobus-py) | stable |
| Go | [protobus-go](https://github.com/ArielLaub/protobus-go) | stable |

Wire compatibility matters more than matching APIs character-for-character. The
`.proto` stays the source of truth across languages.

---

## Reliability model

ProtoBus is intentionally explicit about what RabbitMQ can and cannot guarantee.
The important properties include:

- consumers acknowledge work after the relevant processing/settlement path
- publications use publisher-confirm channels
- unroutable RPC requests are surfaced as an error, not a timeout
- retry publication is confirmed before the original delivery is acknowledged
- disconnects reject or interrupt pending work rather than silently pretending it completed
- reconnection restores required topology/consumers before readiness
- graceful process shutdown drains work already in flight
- definite failures and ambiguous outcomes are raised as distinct error types
- callers can supply a stable `messageId` for deduplication across ambiguous retries

This is **at-least-once territory**, not magical exactly-once execution. Handlers
with side effects should be idempotent where duplicates matter.

Read **[Delivery Guarantees](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/delivery-guarantees.md)** before
relying on any stronger interpretation.

---

## CLI

```bash
npx protobus generate               # .proto -> TypeScript types
npx protobus generate:service Name  # a runnable service stub
npx protobus init                   # print project setup instructions
```

Configured from `package.json`:

```json
{
  "protobus": {
    "protoDir": "./proto",
    "typesOutput": "./common/types/proto.ts",
    "servicesDir": "./services"
  }
}
```

All three keys are optional; the defaults above are what the CLI uses. Generated
code is a convenience; the `.proto` remains authoritative.
**[CLI reference](https://github.com/ArielLaub/protobus/blob/master/docs/reference/cli.md)**.

---

## Documentation

Full index: **[docs/](https://github.com/ArielLaub/protobus/blob/master/docs/README.md)**

| Decide | |
|---|---|
| [Why ProtoBus](https://github.com/ArielLaub/protobus/blob/master/docs/why-protobus.md) | the case for it, the case against, and the comparisons |
| [Design Principles](https://github.com/ArielLaub/protobus/blob/master/docs/design-principles.md) | what belongs in ProtoBus, and what intentionally does not |

| Start | |
|---|---|
| [Getting Started](https://github.com/ArielLaub/protobus/blob/master/docs/guide/getting-started.md) | zero to a working RPC, plus events |
| [Schema Design](https://github.com/ArielLaub/protobus/blob/master/docs/guide/schema.md) | writing the `.proto` that is your contract |
| [Events](https://github.com/ArielLaub/protobus/blob/master/docs/guide/events.md) | publish/subscribe and wildcard topics |
| [Error Handling](https://github.com/ArielLaub/protobus/blob/master/docs/guide/error-handling.md) | retriable vs terminal, the retry ladder, the DLQ |
| [Testing](https://github.com/ArielLaub/protobus/blob/master/docs/guide/testing.md) | unit, integration and end-to-end |

| Understand it | |
|---|---|
| [Architecture](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/architecture.md) | what a service creates in the broker, and why |
| [Message Flow](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/message-flow.md) | the wire format and the round trip |
| [Delivery Guarantees](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/delivery-guarantees.md) | acks, confirms, duplicates, the parked caller |

| Look it up | |
|---|---|
| [Configuration](https://github.com/ArielLaub/protobus/blob/master/docs/reference/configuration.md) | every environment variable and its default |
| [API reference](https://github.com/ArielLaub/protobus/blob/master/docs/reference/api) | Context, MessageService, RunnableService, ServiceProxy |
| [Errors](https://github.com/ArielLaub/protobus/blob/master/docs/reference/errors.md) | every exported error class and when it is thrown |
| [Custom Types](https://github.com/ArielLaub/protobus/blob/master/docs/reference/custom-types.md) | extending the type system |

| Run it | |
|---|---|
| [Troubleshooting](https://github.com/ArielLaub/protobus/blob/master/docs/operations/troubleshooting.md) | symptom, cause, fix |
| [Security](https://github.com/ArielLaub/protobus/blob/master/docs/operations/security.md) | what `actor` does and does not prove |
| [Logging](https://github.com/ArielLaub/protobus/blob/master/docs/operations/logging.md) | levels, structured records, your own sink |
| [Queue Migration](https://github.com/ArielLaub/protobus/blob/master/docs/operations/queue-migration.md) | changing settings on live queues |
| [Known Issues](https://github.com/ArielLaub/protobus/blob/master/docs/operations/known-issues.md) | current limitations |
| [Migration Guide](https://github.com/ArielLaub/protobus/blob/master/docs/migration.md) | upgrading, including 1.x to 2.x |

---

## See a real system in a minute

```bash
git clone https://github.com/ArielLaub/protobus && cd protobus && npm install
npm run docker:up
bash scripts/run-combat-sample.sh
```

Six services fight a battle royale over the bus — RPC, published events and
graceful shutdown in one run — and the script asserts exactly one player
survived. The source is
[`sample/combatGame`](https://github.com/ArielLaub/protobus/tree/master/sample/combatGame).

---

## Requirements

- Node.js 20+ (enforced by `engines`; CI runs 20, 22 and 24)
- RabbitMQ 3.8+

## Development

```bash
npm test                          # unit suite
npm run test:integration          # integration suite (starts RabbitMQ via Docker)
node scripts/check-doc-snippets.js  # compile and run every example in the docs
bash scripts/run-combat-sample.sh   # end-to-end sample
```

## Design principle

> **Do the messaging job completely; leave the rest of the application alone.**

That is the boundary ProtoBus is intended to keep.

## License

MIT — Copyright (c) 2018 Remarkable Games Ltd.
See [LICENSE](https://github.com/ArielLaub/protobus/blob/master/LICENSE).
