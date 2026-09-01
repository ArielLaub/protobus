# Context

> One AMQP connection, one parsed schema registry, and the dispatchers every service and proxy in the process shares.

**Read this if** you are wiring up a process, you reached for a property on `context` and TypeScript said it does not exist, or your client script runs correctly and then never exits.

| | |
|---|---|
| **Prerequisites** | [Getting Started](../../guide/getting-started.md) — you have a context that connects |
| **Next** | [MessageService](./message-service.md) · [ServiceProxy](./service-proxy.md) · [Configuration](../configuration.md) |
| **Source** | [`lib/context.ts`](../../../lib/context.ts) · [`lib/connection.ts`](../../../lib/connection.ts) · [`lib/message_factory.ts`](../../../lib/message_factory.ts) |

**On this page** — [The whole surface](#the-whole-surface) · [init](#initamqpurl-protolocations-options) · [Publishing directly](#publishing-directly) · [Properties](#properties) · [Shutting down](#shutting-down) · [Errors from init](#errors-from-init) · [One per process](#one-context-per-process)

---

## The whole surface

`Context` is small on purpose. This table is all of it — four methods and four getters.

| Member | Signature | Notes |
|---|---|---|
| constructor | `new Context()` | takes nothing; configuration happens in `init()` |
| `init` | `(amqpUrl: string, protoLocations: string[], options?: ContextOptions) => Promise<void>` | parses schemas, then connects |
| `publishMessage` | `(content: any, routingKey: string, rpc?: boolean, timeoutMs?: number, options?: CallOptions) => Promise<Buffer>` | raw unary publish; returns the encoded reply |
| `publishStreamingMessage` | `(content: Buffer, routingKey: string, idleTimeoutMs?: number, options?: StreamOptions) => AsyncIterable<Buffer>` | raw streaming publish; **not** `async` |
| `publishEvent` | `(type: string, content: any, topic: string) => Promise<void>` | `topic` is required here, unlike on `MessageService` |
| `factory` | `MessageFactory` | the proto root, encoders and decoders |
| `connection` | `Connection` | channels, reconnection, and `disconnect()` |
| `isConnected` | `boolean` | delegates to `connection.isConnected` |
| `isReconnecting` | `boolean` | delegates to `connection.isReconnecting` |

> [!IMPORTANT]
> There is no `close()`, no `shutdown()`, no `messageFactory`, no `messageDispatcher` and no `eventDispatcher`. Earlier versions of this page documented all five; none of them has ever existed on `Context`. The registry is `context.factory`, and the way to shut a process down is `await context.connection.disconnect()` — see [Shutting down](#shutting-down).

The dispatchers are real objects, but they are private fields of `Context` ([`lib/context.ts`](../../../lib/context.ts) lines 30-33). Everything they do is reachable through the three `publish*` methods above.

---

## `init(amqpUrl, protoLocations, options?)`

| Parameter | Type | Description |
|---|---|---|
| `amqpUrl` | `string` | AMQP connection string. A `?heartbeat=` already in the URL wins; otherwise `AMQP_HEARTBEAT_SECONDS` (default `30`) is appended. |
| `protoLocations` | `string[]` | **Directories**, not files. Each is scanned recursively for `*.proto`. |
| `options.reconnection` | `ReconnectionOptions?` | `maxRetries` (10), `initialDelayMs` (1000), `maxDelayMs` (30000), `backoffMultiplier` (2). See [Configuration → Reconnection](../configuration.md#reconnection-options). |

The order matters, and it is not the order most people assume:

```mermaid
flowchart LR
    A["factory.init(protoLocations)<br/>scan + parse every .proto"] --> B["connection.connect(url)<br/>open the AMQP socket"]
    B --> C["messageDispatcher.init()<br/>publish channel + callback queue"]
    C --> D["eventDispatcher.init()<br/>publish channel"]

    style A fill:#1f6feb,color:#fff,stroke:#1f6feb
```

Schemas are parsed **before** the socket is opened, so a malformed `.proto` or a duplicate type name fails without ever touching the broker. A connection error and a schema error are therefore never ambiguous.

<!-- doc-check: compile id=ctx-create -->
```typescript
// src/context.ts
import { Context, IContext } from 'protobus';

export async function createContext(): Promise<IContext> {
    const context = new Context();

    await context.init(
        process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/',
        [__dirname + '/proto/', '/shared/proto/'],
    );

    return context;
}
```

> [!NOTE]
> `protoLocations` may be empty. A `MessageService` registers its own schema during `init()` from its `ProtoFileName`, so a single-service process does not have to pass a directory at all. Passing one anyway is harmless: re-registering a schema already in the root is a no-op, keyed on both the service name and the schema text ([`lib/message_factory.ts`](../../../lib/message_factory.ts), `parse()`).

### With reconnection options

<!-- doc-check: compile -->
```typescript
import { Context } from 'protobus';

async function main() {
    const context = new Context();

    await context.init(
        process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/',
        [__dirname + '/proto/'],
        {
            reconnection: {
                maxRetries: 0,          // 0 means keep retrying forever
                initialDelayMs: 500,
                maxDelayMs: 10000,
                backoffMultiplier: 2,
            },
        },
    );
}
```

---

## Publishing directly

You will normally publish through a [`ServiceProxy`](./service-proxy.md) or a [`MessageService`](./message-service.md), both of which encode and decode for you. The three methods below are the layer underneath, and there is one case where you have to reach for them.

### `publishMessage(content, routingKey, rpc?, timeoutMs?, options?)`

Publishes an already-encoded request and resolves with the encoded reply.

| Parameter | Default | Behaviour |
|---|---|---|
| `rpc` | `true` | The test is `rpc !== false`, so `undefined` means RPC. Pass `false` for fire-and-forget: the promise resolves with `undefined` once the broker confirms. |
| `timeoutMs` | `Config.rpcCallTimeoutMs` (`RPC_CALL_TIMEOUT_MS`, 600000) | Rejects with `RpcTimeoutError` if no reply arrives. Ignored when `rpc` is `false`. |
| `options.priority` | unset | AMQP priority 0-255. Only meaningful on a queue declared with `maxPriority`. See [Message Priority](../../guide/priority.md). |

An RPC publish sets `mandatory`, so a request routed to a key nothing is bound to fails immediately with `UnroutableError` rather than after the full timeout. A non-RPC publish does not — an event with no subscribers is normal.

**The one case you need this.** A service whose `ServiceName` carries extra instance segments (`Combat.Player.player6`) is not addressable through `ServiceProxy`, which looks its name up in the schema verbatim. The routing key has to be built by hand:

<!-- doc-check: compile -->
```typescript
import { IContext } from 'protobus';

async function callPlayer(
    context: IContext, targetPlayerId: string, method: string, data: any,
) {
    // Encoding uses the CONTRACT name, which is what the .proto declares.
    const buffer = context.factory.buildRequest(`Combat.Player.${method}`, data, 'referee');

    // Routing uses the INSTANCE name, which is what the service bound.
    const routingKey = `REQUEST.Combat.Player.${targetPlayerId}.${method}`;

    const responseData = await context.publishMessage(buffer, routingKey, true);
    const response = context.factory.decodeResponse(responseData);

    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.result.data as any;
}
```

This is exactly what [`sample/combatGame/BasePlayer.ts`](../../../sample/combatGame/BasePlayer.ts) does (`callPlayerMethod`). See [MessageService → Instance names](./message-service.md#instance-names-and-the-contract-they-resolve-to) for why the two names differ.

### `publishStreamingMessage(content, routingKey, idleTimeoutMs?, options?)`

Returns an `AsyncIterable<Buffer>` of raw reply bodies. It is **not** an `async` method — there is no promise to await before the `for await`. `idleTimeoutMs` defaults to `Config.streamIdleTimeoutMs` (`STREAM_IDLE_TIMEOUT_MS`, 60000) and bounds the gap *between* chunks, not the stream's total duration. Full protocol in [Streaming](../../guide/streaming.md).

### `publishEvent(type, content, topic)`

| Parameter | Description |
|---|---|
| `type` | Fully-qualified message type from the schema, e.g. `Calculator.CalculationEvent` |
| `content` | Plain object matching that message |
| `topic` | Routing key. Typed as required; a falsy value is replaced with `EVENT.<type>` in [`lib/event_dispatcher.ts`](../../../lib/event_dispatcher.ts). |

> [!TIP]
> `MessageService.publishEvent(type, content, topic?)` declares `topic` optional and forwards to this method, so inside a service you can omit it and get the `EVENT.<type>` default with the type-checker's blessing.

---

## Properties

### `factory`

The `MessageFactory`: the protobufjs root, plus the encode/decode pair for each of the two wire layers. Useful members are `root`, `hasService(name)`, `getServiceMethodNames(name)`, `isStreamingMethod(fullName)`, `buildRequest`, `decodeResponse`, `buildEvent` and `decodeEvent`.

<!-- doc-check: compile needs=ctx-create -->
```typescript
import { createContext } from './context';

async function main() {
    const context = await createContext();

    // Was the schema actually loaded? A `false` here is why a service's init()
    // will throw MissingProto later.
    if (!context.factory.hasService('Calculator.Math')) {
        throw new Error('Calculator.proto was not on any of the proto paths');
    }

    console.log(context.factory.getServiceMethodNames('Calculator.Math'));

    await context.connection.disconnect();
}
```

### `connection`

The AMQP connection wrapper. Three members matter to application code:

| Member | Use |
|---|---|
| `disconnect(): Promise<any>` | the only way to shut a context down |
| `on('reconnecting' \| 'reconnected' \| 'disconnected' \| 'error', fn)` | connection lifecycle events |
| `drainInFlight(timeoutMs): Promise<boolean>` | wait for in-flight handlers before tearing down |

`Context`'s constructor already subscribes to all four events and logs them, so you are adding to that, not replacing it.

### `isConnected` / `isReconnecting`

Both are plain delegations to the connection. They answer different questions: `isConnected` is false during a reconnection, and `isReconnecting` is what distinguishes "the broker went away and we are working on it" from "this context was never initialised or has been disconnected".

---

## Shutting down

<!-- doc-check: compile needs=ctx-create -->
```typescript
import { createContext } from './context';

async function main() {
    const context = await createContext();

    // ... do the work ...

    // Without this the process hangs: the open AMQP socket and its heartbeat
    // timer keep the event loop alive indefinitely.
    await context.connection.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
```

> [!WARNING]
> A short-lived client that never disconnects does not exit. This is the single most common way a documented example goes wrong, and it is silent — the work all succeeds and the script simply never returns to the shell. There is no `context.close()` to reach for; the connection is reached through the context.

A long-running server does not need any of this. [`RunnableService.start`](./runnable-service.md#runnableservicestartcontext-serviceclass-options-postinit) installs SIGINT/SIGTERM handlers that stop consumers, drain in-flight work, run `cleanup()` and then call `context.connection.disconnect()` for you.

---

## Errors from init

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED` | no broker at `amqpUrl` | start it; `npm run docker:up` for the bundled compose file |
| `ACCESS_REFUSED` / `ENOTFOUND` | credentials or vhost wrong in the URL | see [AMQP Connection String](../configuration.md#amqp-connection-string) |
| `duplicate name '<Type>' in Root` | two `.proto` files on the paths declare the same fully-qualified type | rename one, or stop passing the directory that holds the copy |
| `illegal token` / `no such type` | protobufjs rejected a schema | fix the `.proto`; the message names the file and line |
| `ReconnectionError` | the connection dropped later and `maxRetries` attempts were exhausted | raise `maxRetries`, or set it to `0` for infinite retries |

<!-- doc-check: compile -->
```typescript
import { Context, ReconnectionError } from 'protobus';

async function main() {
    const context = new Context();

    try {
        await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto/']);
    } catch (error: any) {
        if (error?.code === 'ECONNREFUSED') {
            console.error('RabbitMQ is not reachable');
        } else if (error instanceof ReconnectionError) {
            console.error('gave up reconnecting');
        } else {
            console.error(`schema or broker setup failed: ${error?.message}`);
        }
        process.exit(1);
    }
}
```

> [!NOTE]
> A schema failure comes out of protobufjs, not out of protobus, so there is no error class to `instanceof` against. Matching on the message is the only option, which is another reason to keep proto loading separate from the rest of your boot sequence.

---

## One context per process

One `Context` is one AMQP connection and one schema root. Two contexts in one process is two connections, two callback queues and two copies of every parsed schema, for no gain.

<!-- doc-check: compile needs=ctx-create -->
```typescript
import { ServiceProxy } from 'protobus';
import { createContext } from './context';

async function main() {
    // Every service and proxy in the process shares one context.
    const context = await createContext();

    const orders = new ServiceProxy(context, 'Orders.Service');
    const users = new ServiceProxy(context, 'Users.Service');
    await Promise.all([orders.init(), users.init()]);

    await context.connection.disconnect();
}
```

The reverse — several *services* in one context — is legal but rarely what you want. Node is single-threaded, so co-locating services buys no parallelism; it only couples their failure domains and their deploys. Scale with more processes and raise `maxConcurrent`.

<details>
<summary><b>What sharing actually saves</b></summary>

<br/>

Per context, at the broker: one connection, one exclusive auto-delete callback queue, and one channel each for the message dispatcher and the event dispatcher. Each `MessageService` adds its own channels on top of that — a request listener, an event listener and a cancel listener.

Per context, in the process: one parsed protobufjs root. Schemas are the expensive half. `loadSync` resolves eagerly, and a second context re-reads and re-parses every file on the paths.

</details>

---

<div align="center">

**[← Configuration](../configuration.md)** · **[Docs index](../../README.md)** · **[MessageService →](./message-service.md)**

</div>
