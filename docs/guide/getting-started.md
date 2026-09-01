# Getting Started

> From an empty directory to an RPC that returns the right answer, and an event that arrives.

**Read this if** you have never run a protobus service. Everything on this page is executed by CI on every commit, so it works as written.

| | |
|---|---|
| **Prerequisites** | Node 20+, Docker (for RabbitMQ), a terminal |
| **Next** | [Architecture](../concepts/architecture.md) — what you just created in the broker |
| **Source** | [`lib/context.ts`](../../lib/context.ts) · [`lib/message_service.ts`](../../lib/message_service.ts) · [`lib/service_proxy.ts`](../../lib/service_proxy.ts) |

**On this page** — [See it work first](#see-it-work-first) · [Set up](#set-up-the-project) · [1. Schema](#1-define-the-schema) · [2. Context](#2-create-the-context) · [3. Service](#3-implement-the-service) · [4. Server](#4-start-the-server) · [5. Client](#5-call-it) · [6. Events](#6-subscribe-to-events) · [Project layout](#project-layout) · [Where next](#where-next)

---

## See it work first

Before writing anything, watch a real system run. This takes about a minute and needs only Docker and Node:

```bash
git clone https://github.com/ArielLaub/protobus && cd protobus && npm install
npm run docker:up
bash scripts/run-combat-sample.sh
```

Six services fight a battle royale over the bus — RPC calls, published events and
a clean shutdown, all in one run — and the script asserts exactly one player
survived. Open <http://localhost:15672> (`guest` / `guest`) while it runs and you
can watch the queues fill and drain.

That sample is [`sample/combatGame`](../../sample/combatGame), and it is the best
worked example in this repository. Come back to it once the tutorial below makes
sense.

---

## Set up the project

```bash
mkdir calculator && cd calculator
npm init -y
npm install protobus
npm install --save-dev typescript tsx @types/node
```

> [!IMPORTANT]
> **Use `tsx`, not `ts-node`.** Earlier versions of this guide said `npx ts-node`,
> and that no longer works: `npx` fetches ts-node without a TypeScript peer, and
> even installed properly, ts-node 10.9.2 crashes against the TypeScript a fresh
> `npm install` resolves today. This repository does not use ts-node either —
> [`scripts/run-combat-sample.sh`](../../scripts/run-combat-sample.sh) compiles
> with plain `tsc`. `tsx` needs no configuration and works.

Start a broker:

```bash
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management-alpine
```

Create `tsconfig.json`. The `experimentalDecorators` line matters if you use the
`@Service` / `@Method` decorators later; the rest is an ordinary Node setup:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "commonjs",
        "moduleResolution": "node",
        "esModuleInterop": true,
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true,
        "strict": true,
        "outDir": "dist",
        "rootDir": "src"
    },
    "include": ["src/**/*"]
}
```

> [!WARNING]
> `"module": "commonjs"` means **top-level `await` is a syntax error**. Every
> snippet below is wrapped in an `async function main()` for that reason. If you
> paste a snippet from elsewhere that awaits at the top level, you will get
> `Top-level await is currently not supported with the "cjs" output format` —
> either wrap it, or set `"type": "module"` in `package.json` and
> `"module": "node16"` here.

---

## 1. Define the schema

The `.proto` file is the contract. Create `src/proto/Calculator.proto`:

<!-- doc-check: proto file=proto/Calculator.proto -->
```protobuf
syntax = "proto3";
package Calculator;

message AddRequest {
    int32 a = 1;
    int32 b = 2;
}

message AddResponse {
    int32 result = 1;
}

message CalculationEvent {
    string operation = 1;
    int32 result = 2;
}

service Math {
    rpc add(Calculator.AddRequest) returns(Calculator.AddResponse);
}

// A service that only subscribes to events still needs a service block.
// See "Subscribe to events" below for why.
service Subscriber {
}
```

Conventions worth knowing before you go further:

- **Package + service name is the full service name.** `package Calculator` plus
  `service Math` gives `Calculator.Math`, which is the name that appears on the
  queue, in the routing key, and in every `ServiceProxy` call.
- **Request and response types are fully qualified** in `rpc` declarations —
  `Calculator.AddRequest`, not `AddRequest`.
- **Events are plain messages**, not part of a `service` block.
  `CalculationEvent` above is published by type name.

> [!NOTE]
> **A subscribe-only service still needs a `service` block.** Protobus resolves a
> class's contract by looking its `ServiceName` up in the loaded schema
> ([`lib/message_service.ts`](../../lib/message_service.ts), `resolveContract`),
> and refuses to start if nothing matches:
>
> ```
> MissingProto: no service in the schema matches 'Calculator.Subscriber' or any
> prefix of it; the .proto must declare the service this class serves
> ```
>
> An empty `service Subscriber {}` is enough. That rule used to appear nowhere in
> these docs, and it stopped step 6 of this guide from running at all.

---

## 2. Create the context

The `Context` owns the AMQP connection and the parsed schemas. **One per
process** — services and proxies share it.

<!-- doc-check: compile id=gs-context -->
```typescript
// src/context.ts
import { Context, IContext } from 'protobus';

export async function createContext(): Promise<IContext> {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];

    const context = new Context();
    await context.init(AMQP_URL, PROTO_PATHS);

    return context;
}
```

`init()` scans each path recursively for `.proto` files and parses them, then
connects. Pass directories, not individual files.

---

## 3. Implement the service

A service is a class whose methods are the `rpc`s in the schema.

<!-- doc-check: compile id=gs-service -->
```typescript
// src/calculator-service.ts
import { RunnableService, IContext } from 'protobus';

export class CalculatorService extends RunnableService {
    constructor(context: IContext) {
        super(context);
    }

    // Required: the full service name from the proto — package + service.
    public get ServiceName(): string {
        return 'Calculator.Math';
    }

    // One method per rpc, matching the name in the proto exactly.
    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        const result = request.a + request.b;

        // Optional: tell anyone who cares that this happened.
        await this.publishEvent('Calculator.CalculationEvent', {
            operation: 'add',
            result,
        });

        return { result };
    }
}
```

> [!TIP]
> `ServiceName` may carry extra segments beyond the contract. A class named
> `Calculator.Math.worker7` still resolves against `service Math`, because
> `resolveContract` trims segments from the right until one matches. That is how
> you run per-instance services with their own queues —
> [`sample/combatGame`](../../sample/combatGame) uses it to give each player its
> own name.

---

## 4. Start the server

<!-- doc-check: daemon id=gs-server needs=gs-context,gs-service ready="Calculator service is running" broker -->
```typescript
// src/server.ts
import { RunnableService } from 'protobus';
import { createContext } from './context';
import { CalculatorService } from './calculator-service';

async function main() {
    const context = await createContext();

    await RunnableService.start(context, CalculatorService, {
        maxConcurrent: 2,   // in-flight messages per process; the default is 1
    });

    console.log('Calculator service is running');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
```

Run it:

```bash
npx tsx src/server.ts
```

`RunnableService.start` installs SIGINT/SIGTERM handlers, drains in-flight work
on shutdown, and exits non-zero if startup fails — so an orchestrator can tell a
crash-on-boot from a clean stop. Use it for anything that owns its process.

> [!NOTE]
> `RunnableService.start` only accepts a `RunnableService`, which is why step 3
> extends that rather than `MessageService`. `RunnableService` also derives
> `ProtoFileName` from `ServiceName` by convention — `Calculator.Math` →
> `Calculator.proto` — which is why the schema file is named to match and the
> class needs no `ProtoFileName` getter. Use plain
> [`MessageService`](../reference/api/message-service.md) when something else
> owns the process lifecycle, and give it an explicit `ProtoFileName`.

---

## 5. Call it

<!-- doc-check: run needs=gs-context with=gs-server,gs-subscriber broker expect="5 + 3 = 8" expect="Received event: add = 8" -->
```typescript
// src/client.ts
import { ServiceProxy } from 'protobus';
import { createContext } from './context';

// ServiceProxy builds its methods from the schema at init(), so TypeScript
// cannot know them ahead of time. Declare the shape you expect and intersect
// it — `npx protobus generate` writes this interface for you.
interface CalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

async function main() {
    const context = await createContext();

    const calculator = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calculator.init();

    const response = await calculator.add({ a: 5, b: 3 });
    console.log(`5 + 3 = ${response.result}`);

    // Close the connection, or the process never exits: an open AMQP socket and
    // its heartbeat timer keep the event loop alive indefinitely.
    await context.connection.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
```

```bash
$ npx tsx src/client.ts
5 + 3 = 8
```

> [!IMPORTANT]
> **A client must close its connection.** Earlier versions of this example ended
> at the `console.log` and hung forever. There is no `close()` on `Context`; the
> connection is reached through it — `await context.connection.disconnect()`. A
> server started with `RunnableService.start` does this for you on
> SIGINT/SIGTERM.

> [!NOTE]
> **`ServiceProxy` has no index signature**, so `proxy.add(...)` is a compile
> error without the cast above. The repo's own sample takes the blunter route
> (`const assistant: any = new ServiceProxy(...)`, in
> [`sample/tokenStream/StreamingDemo.ts`](../../sample/tokenStream/StreamingDemo.ts));
> the intersection type costs one line more and keeps the call site checked.

---

## 6. Subscribe to events

The `add` handler published a `Calculator.CalculationEvent`. Anything on the bus
can receive it, including a service that implements no RPCs at all.

<!-- doc-check: daemon id=gs-subscriber needs=gs-context ready="Listening for events" broker -->
```typescript
// src/event-subscriber.ts
import { RunnableService, IContext } from 'protobus';
import { createContext } from './context';

class EventSubscriber extends RunnableService {
    public get ServiceName(): string { return 'Calculator.Subscriber'; }

    constructor(context: IContext) {
        super(context);
    }
}

async function main() {
    const context = await createContext();

    const subscriber = new EventSubscriber(context);
    await subscriber.init();

    await subscriber.subscribeEvent('Calculator.CalculationEvent', async (event) => {
        console.log(`Received event: ${event.operation} = ${event.result}`);
    });

    console.log('Listening for events...');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
```

Run it in a third terminal, then run the client again:

```bash
$ npx tsx src/event-subscriber.ts
Listening for events...
Received event: add = 8
```

This is a long-running process like the server, so it does not close its
connection — stop it with Ctrl-C.

`Calculator.Subscriber` needs the empty `service Subscriber {}` block added in
[step 1](#1-define-the-schema). Without it, `init()` throws `MissingProto`.

For wildcard topics, competing subscribers, and what a subscription costs in the
broker, see [Events](./events.md).

---

## Project layout

```
calculator/
├── src/
│   ├── proto/
│   │   └── Calculator.proto
│   ├── calculator-service.ts
│   ├── context.ts
│   ├── server.ts
│   ├── client.ts
│   └── event-subscriber.ts
├── package.json
└── tsconfig.json
```

Run each service as **its own process**. Node is single-threaded, so packing
several services into one process buys no parallelism — it only couples their
failure domains and their deploys. Scale by running more processes; use
`maxConcurrent` to control how many messages one process handles at a time.

---

## Generate the types instead of hand-writing them

Everything above hand-wrote its request and response shapes to keep the moving
parts down. In a real project, let the CLI derive them from the schema:

```bash
npx protobus generate                    # .proto -> TypeScript types
npx protobus generate:service Calculator # a runnable service stub
```

Generated types give you `Calculator.IAddRequest`, `Calculator.ServiceName` and a
per-method signature, so a schema change becomes a compile error instead of a
runtime one. See [CLI](../reference/cli.md).

---

## Typed clients, properly

The cast in step 5 is the smallest correct thing. Two better options once the
project grows:

**Generate the interface.** `npx protobus generate` emits `Calculator.Service`
with a per-method signature derived from the schema, so a `.proto` change becomes
a compile error at every call site. See [CLI](../reference/cli.md).

**Wrap the proxy once.** `ProxiedService<T>` is a `MessageService` that builds a
typed `ServiceProxy` for **its own** `ServiceName` during `init()`, reachable as
`.proxy`:

<!-- doc-check: compile -->
```typescript
import { ProxiedService, IContext } from 'protobus';

interface ICalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

export class CalculatorNode extends ProxiedService<ICalculatorMath> {
    public get ServiceName(): string { return 'Calculator.Math'; }
    public get ProtoFileName(): string { return __dirname + '/proto/Calculator.proto'; }

    async addViaPeer(a: number, b: number): Promise<number> {
        const { result } = await this.proxy.add({ a, b });
        return result;
    }
}
```

> [!WARNING]
> `ProxiedService` is **not** a standalone client. It extends `MessageService`, so
> `init()` also declares and consumes the service's own queue — the class both
> serves the contract and holds a typed proxy to it. Use it when a service calls
> its own interface (fanning work out to sibling replicas, say). For a pure
> caller, use `ServiceProxy` as in step 5.

---

## Where next

| You want to | Read |
|---|---|
| Understand the four queues that just appeared | [Architecture](../concepts/architecture.md) |
| Know what happens when a handler throws | [Error Handling](./error-handling.md) · [Delivery Guarantees](../concepts/delivery-guarantees.md) |
| Tune timeouts, concurrency, reconnection | [Configuration](../reference/configuration.md) |
| Write the schema properly | [Schema Design](./schema.md) |
| Test your service | [Testing](./testing.md) |

---

<div align="center">

**[← Docs index](../README.md)** · **[Docs index](../README.md)** · **[Architecture →](../concepts/architecture.md)**

</div>
