# ProtoBus

**RabbitMQ-native microservices for TypeScript, with Protocol Buffers on the wire.**

[![npm version](https://img.shields.io/npm/v/protobus.svg?logo=npm)](https://www.npmjs.com/package/protobus)
[![node](https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-%E2%89%A53.8-FF6600?logo=rabbitmq&logoColor=white)](https://www.rabbitmq.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![CI](https://github.com/ArielLaub/protobus/actions/workflows/ci.yml/badge.svg)](https://github.com/ArielLaub/protobus/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/protobus.svg)](https://github.com/ArielLaub/protobus/blob/master/LICENSE)

Define a service in a `.proto` file, implement it as a class, and call it from
anywhere on the bus as if it were local. ProtoBus turns each service into **one
durable RabbitMQ queue with N processes competing for it** — so load balancing,
failover, backpressure, retries and dead-lettering are the broker's, not
JavaScript's.

It is deliberately **not** transport-agnostic. There is no pluggable-transport
abstraction to keep RabbitMQ's features out of reach.

> Ports: [protobus-py](https://github.com/ArielLaub/protobus-py) (Python, stable) ·
> [protobus-go](https://github.com/ArielLaub/protobus-go) (Go, experimental).
> The `.proto` files are the contract, so they interoperate.

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

`RunnableService.start` handles SIGINT/SIGTERM, drains in-flight messages on
shutdown, and exits non-zero if startup fails.

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

Full walkthrough, including events and the project layout:
**[Getting Started](https://github.com/ArielLaub/protobus/blob/master/docs/guide/getting-started.md)**.

---

## Why ProtoBus

### RabbitMQ-native, not RabbitMQ-compatible

Most Node microservice frameworks (Moleculer, Seneca, NestJS transports) abstract
the broker away so several transports can be swapped in. The cost is that they
reimplement routing, load balancing and retries *above* the broker, and cannot
use what it already does better.

| | Transport-agnostic frameworks | ProtoBus |
|---|---|---|
| Load balancing | app-level round-robin | broker-level competing consumers |
| Routing | app-level pattern matching | native topic exchanges |
| Redelivery | select, send, hope | queue, ack, redeliver on loss |
| Persistence | often none | durable queues |
| Dead letters | hand-rolled | native DLX |
| Priority | rarely | native priority queues |

What that difference looks like when a process dies mid-request:

```
Transport-agnostic:
  request -> framework picks instance A -> send -> A crashes -> message lost

ProtoBus:
  request -> queue -> A pulls -> A crashes before ack -> redelivered -> B pulls -> reply
```

App-level routing also means your event loop does the switching as well as your
business logic: every message crosses your Node process twice. RabbitMQ's Erlang
runtime was built for exactly that job.

### Protocol Buffers, not JSON

| | JSON | Protocol Buffers |
|---|---|---|
| Size | verbose text | compact binary |
| Decode | parse strings at runtime | generated decoders |
| Types | runtime surprises | compile-time signatures |
| Schema | hope the docs are right | contract-first `.proto` |
| Versioning | breaking changes propagate | field numbers, forward/backward compatible |

### Polyglot without a proprietary protocol

Because the schema is Protobuf and the routing is AMQP, a client in another
language needs no reverse-engineering — only a protobuf library and an AMQP
client. That is how [protobus-py](https://github.com/ArielLaub/protobus-py) and
[protobus-go](https://github.com/ArielLaub/protobus-go) exist, and why services
written in different languages share one bus.

| | Transport-agnostic frameworks | ProtoBus |
|---|---|---|
| Protocol | custom, must be reimplemented | standard Protobuf over AMQP |
| Schema | framework-specific or none | language-agnostic `.proto` |
| Routing logic | embedded in every SDK | in RabbitMQ |

The detailed comparison, with the reasoning:
**[Why ProtoBus](https://github.com/ArielLaub/protobus/blob/master/docs/why-protobus.md)**.

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
registered**; registering either again is a no-op. Details, and the
rules that make this work:
**[Custom Types](https://github.com/ArielLaub/protobus/blob/master/docs/reference/custom-types.md)**.

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

All three keys are optional; the defaults above are what the CLI uses.
**[CLI reference](https://github.com/ArielLaub/protobus/blob/master/docs/reference/cli.md)**.

---

## Documentation

Full index: **[docs/](https://github.com/ArielLaub/protobus/blob/master/docs/README.md)**

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

## License

MIT — Copyright (c) 2018 Remarkable Games Ltd.
See [LICENSE](https://github.com/ArielLaub/protobus/blob/master/LICENSE).
