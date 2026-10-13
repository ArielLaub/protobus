<p align="center">
  <img src="https://raw.githubusercontent.com/ArielLaub/protobus/master/docs/assets/banner.jpg" alt="ProtoBus: many languages, one message bus. A thin layer over Protocol Buffers and RabbitMQ." width="100%">
</p>

# ProtoBus for TypeScript

**RabbitMQ-native microservices for Node.js and Bun, with Protocol Buffers on the wire.**

[![npm version](https://img.shields.io/npm/v/protobus.svg?logo=npm)](https://www.npmjs.com/package/protobus)
[![node](https://img.shields.io/badge/node-%E2%89%A522-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![bun](https://img.shields.io/badge/bun-compatible-000000?logo=bun&logoColor=white)](https://bun.sh)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-%E2%89%A53.8-FF6600?logo=rabbitmq&logoColor=white)](https://www.rabbitmq.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![CI](https://github.com/ArielLaub/protobus/actions/workflows/ci.yml/badge.svg)](https://github.com/ArielLaub/protobus/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/protobus.svg)](https://github.com/ArielLaub/protobus/blob/master/LICENSE)

Define a service in a `.proto` file, implement it as an ordinary class, and
call it from anywhere on the bus as if it were local. ProtoBus turns each
service into **one durable RabbitMQ queue with N processes competing for it**,
so load balancing, failover, backpressure, retries and dead-lettering are
handled by the broker.

**ProtoBus solves messaging. It does not own your application.** Bring your own
DI, HTTP server, logger, validation, database layer, config system, tracing
stack and project layout. There is no container, module system or framework
runtime you have to adopt.

This is the reference implementation, in TypeScript, for Node.js and Bun. Its
ports are **wire-compatible**: a service written in one language serves callers
in all the others, with streaming, events, custom types and error codes
included. They are listed under [Wire compatibility](#wire-compatibility).

**Status: stable.** 2.5.0 is the current release. Every port runs its own
cross-language suite against this library, in both directions, on RabbitMQ.

---

## Install

```bash
npm install protobus
# or, on Bun
bun add protobus
```

ProtoBus is fully compatible with [Bun](https://bun.sh) as well as Node.js:
the same package, with no flags or shims. `.proto` files are parsed at
runtime, so there is no `protoc` to install; `npx protobus generate` writes
TypeScript interfaces for them when you want generated types (see
[CLI](https://github.com/ArielLaub/protobus/blob/master/docs/reference/cli.md)).
The runtime depends on [amqplib](https://github.com/amqp-node/amqplib) for
AMQP and [protobufjs](https://github.com/protobufjs/protobuf.js) for the wire.

You also need a RabbitMQ 3.8+ broker:

```bash
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management-alpine
export AMQP_URL=amqp://guest:guest@localhost:5672/
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

The package plus the service name is the service's name on the bus:
`Calculator.Math`. The file is an ordinary protobus schema, shared as-is with
the other languages.

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
is the process-owning service base class; your other application dependencies
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

A call is bounded by `RPC_CALL_TIMEOUT_MS` (10 minutes by default, as in the
other ports) unless you pass a timeout. For generated interfaces instead of the
handwritten type above, run `npx protobus generate`.

The full walkthrough adds events, error handling and the project layout:
**[Getting Started](https://github.com/ArielLaub/protobus/blob/master/docs/guide/getting-started.md)**.

---

## Why ProtoBus

### RabbitMQ only, on purpose

ProtoBus is built for one broker, so the things a broker is good at stay in the
broker instead of being reimplemented above it:

| Concern | Where it lives |
|---|---|
| Load balancing | competing consumers on one queue |
| Routing | topic exchange bindings (`REQUEST.<Service>.*`) |
| Redelivery on consumer loss | late ack: an unacked delivery returns to the queue |
| Retry delay | the retry queue's `x-message-ttl`, drained by a dead-letter exchange |
| Persistence | durable queues, persistent messages |
| Dead letters | a real `<Service>.DLQ` |
| Priority | native queue priorities |

A request goes publisher → exchange → queue → consumer. Nothing tracks live
instances, so nothing holds a stale one, and a consumer that dies mid-request
leaves its delivery unacked for the next consumer to take.

If you may need to swap RabbitMQ for another broker, use a transport-agnostic
framework instead. That is a real feature and protobus does not have it.

### Protocol Buffers, not JSON

- **Contract-first.** The `.proto` file is the interface between teams and
  languages, not a decorator, a JSON pattern or a runtime registration object,
  and the generated types tell you when the two drift apart.
- **Versioning by field number.** Adding a field does not break an old peer.
- **Usually smaller on the wire**, since fields travel as numbers and packed
  binary rather than text.

### A small protocol, a small library

The protocol protobus adds on top of AMQP is small and documented: five
envelope messages, a routing-key convention, an error encoding and two
streaming headers. Because queueing, consumer distribution and retry delays
belong to the broker, the library is small too: three runtime dependencies
(`amqplib`, `protobufjs`, `source-map-support`) and a short mental model, a
`.proto` contract, a `Context`, a service, a proxy, events and streams.

It intentionally provides **no** dependency injection, HTTP routing, ORM,
validation middleware, application modules, configuration framework, required
logger or required tracing stack. Use constructor injection, Awilix, Inversify
or tsyringe; Fastify, Express or Koa; Pino, Winston or your own logger. A
messaging choice should not dictate your application architecture.

The longer case, the case against, and how it compares with direct gRPC,
NestJS, Moleculer, Seneca and raw AMQP:
**[Why ProtoBus](https://github.com/ArielLaub/protobus/blob/master/docs/why-protobus.md)**.

---

## Features

- **Retries and dead-lettering.** An unhandled error or a processing timeout
  parks the request on `<Service>.Retry` and redelivers it; after `maxRetries`
  (3 by default, 5 seconds apart) it lands on `<Service>.DLQ`, and the caller
  is answered with the final error. A `HandledError` is an answer and is never
  retried. See
  [Error Handling](https://github.com/ArielLaub/protobus/blob/master/docs/guide/error-handling.md).
- **Server streaming.** A method declared `returns (stream T)` is implemented
  as an async generator and consumed with `for await`. Leaving the loop, or
  firing an `AbortSignal`, stops the producer on the server. See
  [Streaming](https://github.com/ArielLaub/protobus/blob/master/docs/guide/streaming.md).
- **Events.** `publishEvent` publishes on a topic exchange; `subscribeEvent`
  receives events by message type, topic pattern (`*`, `#`) or both, with
  optional per-listener retries and a dead-letter queue. See
  [Events](https://github.com/ArielLaub/protobus/blob/master/docs/guide/events.md).
- **Custom types.** `bigint` (unsigned 256-bit) and `timestamp` (milliseconds
  since the epoch) are built in as `BigIntType` and `TimestampType`, already
  registered. Register your own with `context.factory.registerType` and it
  becomes a field type in your schemas. See
  [Custom Types](https://github.com/ArielLaub/protobus/blob/master/docs/reference/custom-types.md).
- **Priority.** `maxPriority` makes a service queue a priority queue, and a
  call's `priority` lets a control message overtake a bulk backlog. See
  [Priority](https://github.com/ArielLaub/protobus/blob/master/docs/guide/priority.md).
- **Instance-named services.** Many instances can serve one contract under
  their own names (`Combat.Player.player6`), each addressed by its own proxy.
- **Processing timeout.** `processingTimeoutMs` caps one attempt at a unary
  request; the handler's signal fires and the attempt counts as failed.
- **Reconnection.** A lost connection is re-established with capped
  exponential backoff, and every queue, binding and consumer is restored
  before the connection reports itself ready. Calls made meanwhile wait for
  it; calls in flight when it dropped fail with `DisconnectedError`.
- **Publisher confirms.** A resolved Promise means something: every publish
  waits for the broker's confirm. A failure is a `PublishError` that says
  whether the outcome is definite or ambiguous, and a caller-supplied
  `messageId` makes a republish safe to deduplicate. This is at-least-once
  territory, written down in
  [Delivery Guarantees](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/delivery-guarantees.md).
- **Logging, your way.** Structured records for your own sink, or plain lines
  through any logger you already have. See
  [Logging](https://github.com/ArielLaub/protobus/blob/master/docs/operations/logging.md).
- **CLI.** `npx protobus generate` writes TypeScript types from your schemas,
  `npx protobus generate:service Name` a runnable service stub, configured from
  the `protobus` key of `package.json`. See
  [CLI](https://github.com/ArielLaub/protobus/blob/master/docs/reference/cli.md).
- **Graceful shutdown.** `RunnableService` stops intake on SIGINT/SIGTERM, lets
  in-flight work finish, runs your `cleanup()`, then disconnects.

### A short tour

<!-- doc-check: compile -->
```typescript
import { CallOptions, Config, Context, RunnableService, ServiceProxy } from 'protobus';

class Calculator extends RunnableService {
    public get ServiceName(): string { return 'Calculator.Math'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}

interface CalculatorMath {
    add(request: { a: number; b: number }, actor?: string, rpc?: boolean, timeoutMs?: number, options?: CallOptions): Promise<{ result: number }>;
}

async function tour(context: Context) {
    // Options on a service: concurrency, retries, a processing timeout and a
    // priority queue.
    const service = await RunnableService.start(context, Calculator, {
        maxConcurrent: 16,
        retry: { maxRetries: 5, retryDelayMs: 10000 },
        processingTimeoutMs: 30000,
        maxPriority: Config.RECOMMENDED_MAX_PRIORITY,
    });

    // Options on a call: an actor, a timeout and a priority.
    const calculator = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calculator.init();
    await calculator.add({ a: 1, b: 2 }, 'billing-job', true, 5000, { priority: Config.PRIORITY_HIGH });

    // Events: subscribe by type, publish from anywhere on the bus.
    await service.subscribeEvent('Calculator.Calculated', async (event) => {
        console.log(event.operation);
    });
    await service.publishEvent('Calculator.Calculated', { operation: 'add', at: Date.now() });
}
```

<!-- doc-check: compile -->
```typescript
import { MessageHandlerContext, MessageService } from 'protobus';

// Streaming, server side: an async generator; each yield is one chunk.
class Assistant extends MessageService {
    public get ServiceName(): string { return 'Chat.Assistant'; }
    public get ProtoFileName(): string { return 'chat.proto'; }

    async *generate(request: { prompt: string }, actor: string, correlationId: string, context: MessageHandlerContext): AsyncIterable<{ index: number; text: string }> {
        const words = ['hello', 'from', 'typescript'];
        for (let index = 0; index < words.length; index++) {
            if (context.signal.aborted) return; // the caller has gone: stop producing
            yield { index, text: words[index] };
        }
    }
}

interface ChatAssistant {
    generate(request: { prompt: string }): AsyncIterable<{ index: number; text: string }>;
}

// Client side: `for await` over the proxy's stream.
async function read(assistant: ChatAssistant) {
    for await (const token of assistant.generate({ prompt: 'hi' })) {
        process.stdout.write(token.text + ' ');
        if (token.index === 1) break; // leaving the loop tells the server to stop
    }
}
```

---

## Concurrency

One process is one event loop. Handlers run concurrently as promises, never in
parallel, so they share state freely; a handler that blocks the loop stalls
every other in-flight message on that replica, so keep CPU-bound work off it
or run more replicas. The number in flight is bounded by the consumer's
prefetch: `maxConcurrent` for a service (default 1, one request at a time),
`DEFAULT_PREFETCH` for event handling (also 1). A streaming handler holds its
slot for the life of its stream.

Create one `Context` per process and share it between services and proxies.
See
[Architecture](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/architecture.md).

---

## Wire compatibility

The ports speak this library's wire protocol exactly: the same exchanges,
queues, envelopes (byte for byte), headers and error codes, and the same
environment variables for configuration. Replicas of one service in different
languages can share its queue and climb one retry ladder together. Every port
runs a cross-language suite against this library over a real broker, in both
directions.

| Language | Repo | Status |
|---|---|---|
| TypeScript | [protobus](https://github.com/ArielLaub/protobus) (this repository) | stable (reference) |
| Python | [protobus-py](https://github.com/ArielLaub/protobus-py) | stable |
| Go | [protobus-go](https://github.com/ArielLaub/protobus-go) | stable |
| C++ | [protobus-cpp](https://github.com/ArielLaub/protobus-cpp) | new |
| Java | [protobus-java](https://github.com/ArielLaub/protobus-java) | new |
| C# | [protobus-csharp](https://github.com/ArielLaub/protobus-csharp) | new |
| Rust | [protobus-rs](https://github.com/ArielLaub/protobus-rs) | new |

The wire format and the round trip are in
**[Message Flow](https://github.com/ArielLaub/protobus/blob/master/docs/concepts/message-flow.md)**.

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
| [Streaming](https://github.com/ArielLaub/protobus/blob/master/docs/guide/streaming.md) | server streaming and cancellation |
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
| [CLI](https://github.com/ArielLaub/protobus/blob/master/docs/reference/cli.md) | `generate`, `generate:service`, `init` |

| Run it | |
|---|---|
| [Troubleshooting](https://github.com/ArielLaub/protobus/blob/master/docs/operations/troubleshooting.md) | symptom, cause, fix |
| [Security](https://github.com/ArielLaub/protobus/blob/master/docs/operations/security.md) | what `actor` does and does not prove |
| [Logging](https://github.com/ArielLaub/protobus/blob/master/docs/operations/logging.md) | levels, structured records, your own sink |
| [Queue Migration](https://github.com/ArielLaub/protobus/blob/master/docs/operations/queue-migration.md) | changing settings on live queues |
| [Known Issues](https://github.com/ArielLaub/protobus/blob/master/docs/operations/known-issues.md) | current limitations |
| [Migration Guide](https://github.com/ArielLaub/protobus/blob/master/docs/migration.md) | upgrading, including 1.x to 2.x |

---

## Examples

| Example | Shows |
|---|---|
| [`sample/combatGame`](https://github.com/ArielLaub/protobus/tree/master/sample/combatGame) | Six instances of one service playing a game over RPC and events, with graceful shutdown |
| [`sample/tokenStream`](https://github.com/ArielLaub/protobus/tree/master/sample/tokenStream) | Streaming tokens like a language model, with cancellation stopping the producer |

```bash
git clone https://github.com/ArielLaub/protobus && cd protobus && npm install
npm run docker:up
bash scripts/run-combat-sample.sh   # asserts that exactly one player survived
```

---

## License

MIT. Copyright (c) 2018 Remarkable Games Ltd.
See [LICENSE](https://github.com/ArielLaub/protobus/blob/master/LICENSE).
