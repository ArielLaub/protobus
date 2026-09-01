# Troubleshooting

> Symptom, cause, fix. Find the error text you are staring at.

**Read this if** something is failing and you want the shortest path to why.

| | |
|---|---|
| **Prerequisites** | [Getting Started](../guide/getting-started.md) |
| **Next** | [Known Issues](./known-issues.md) · [Configuration](../reference/configuration.md) |
| **Source** | [`lib/connection.ts`](../../lib/connection.ts) · [`lib/message_service.ts`](../../lib/message_service.ts) · [`lib/logger.ts`](../../lib/logger.ts) |

**On this page** — [Find your error](#find-your-error) · [Starting up](#starting-up) · [Connection](#connection) · [Schema](#schema) · [RPC](#rpc) · [Events](#events) · [Performance](#performance) · [Turn on debug logging](#turn-on-debug-logging) · [Look at the broker](#look-at-the-broker)

---

## Find your error

| You see | Section |
|---|---|
| `TypeError: Cannot read properties of undefined (reading 'fileExists')` | [ts-node does not work](#ts-node-does-not-work) |
| `Top-level await is currently not supported with the "cjs" output format` | [Top-level await](#top-level-await-in-a-commonjs-project) |
| The script prints its answer and never exits | [A client that never exits](#a-client-that-never-exits) |
| `MissingProto: no service in the schema matches '...'` | [MissingProto](#missingproto) |
| `illegal token 'uuid'` (or any custom type name) | [illegal token](#illegal-token-in-a-schema) |
| `connect ECONNREFUSED 127.0.0.1:5672` | [Connection refused](#connection-refused) |
| `ACCESS_REFUSED - Login was refused` | [Authentication failed](#authentication-failed) |
| `UnroutableError` | [Nobody is serving that queue](#unroutableerror-nobody-is-serving-that-queue) |
| `RpcTimeoutError` / the call hangs then rejects | [Request timeout](#request-timeout) |
| `TypeError: proxy.myMethod is not a function` | [Method is not a function](#method-is-not-a-function) |
| `PublishConfirmTimeoutError` / `PublishNackedError` | [Errors reference](../reference/errors.md) |
| Debug logging produces nothing | [Turn on debug logging](#turn-on-debug-logging) |
| Events publish fine but no handler runs | [Events not received](#events-not-received) |

---

## Starting up

### ts-node does not work

**Symptom**

```
TypeError: Cannot read properties of undefined (reading 'fileExists')
    at readConfig (.../ts-node/dist/configuration.js:91:33)
```

**Cause.** Two things at once. `npx ts-node` fetches a floating copy of ts-node
with no TypeScript peer; and even installed properly, ts-node 10.9.2 crashes
against the TypeScript version a fresh `npm install` resolves today.

**Fix.** Use `tsx`:

```bash
npm install --save-dev typescript tsx
npx tsx src/server.ts
```

This repository does not use ts-node either —
[`scripts/run-combat-sample.sh`](../../scripts/run-combat-sample.sh) compiles with
plain `tsc`. Older versions of the Getting Started guide recommended `npx
ts-node`; they were wrong.

### Top-level await in a CommonJS project

**Symptom**

```
ERROR: Top-level await is currently not supported with the "cjs" output format
```

**Cause.** The snippet awaits at module scope, which requires ESM. The service
stub the protobus CLI generates is CommonJS (it ends in `if (require.main ===
module)`), and so is the default `tsconfig.json` most projects start with.

**Fix.** Wrap it, which is what every example in these docs now does:

<!-- doc-check: compile -->
```typescript
async function main() {
    // ... your awaits
}

main().catch((error) => { console.error(error); process.exit(1); });
```

Or commit to ESM: `"type": "module"` in `package.json` and `"module": "node16"`
in `tsconfig.json`. Do not do half of each.

### A client that never exits

**Symptom.** A short script calls a service, prints the right answer, and then
sits there forever.

**Cause.** The AMQP socket and its heartbeat timer are still registered on the
event loop. Nothing closes them for you, and `Context` has **no `close()`
method**.

**Fix.**

<!-- doc-check: compile -->
```typescript
import { Context, ServiceProxy } from 'protobus';

interface CalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

async function main() {
    const context = new Context();
    await context.init('amqp://localhost', ['./proto']);

    const calc = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calc.init();
    console.log(await calc.add({ a: 5, b: 3 }));

    await context.connection.disconnect();   // this is the missing line
}

main().catch((error) => { console.error(error); process.exit(1); });
```

> [!NOTE]
> A long-running **server** does not need this. `RunnableService.start` installs
> SIGINT/SIGTERM handlers that stop consuming, drain in-flight work, and
> disconnect. See [RunnableService](../reference/api/runnable-service.md).

### MissingProto

**Symptom**

```
MissingProto: no service in the schema matches 'Calculator.Subscriber' or any
prefix of it; the .proto must declare the service this class serves
```

**Cause.** Protobus resolves a class's contract by looking its `ServiceName` up
in the loaded schema, trimming segments from the right until one matches
(`resolveContract` in [`lib/message_service.ts`](../../lib/message_service.ts)).
Nothing matched.

**Fixes, in order of likelihood.**

1. **The service block is missing from the `.proto`.** This catches everyone once,
   because it applies **even to a service that only subscribes to events and
   implements no RPCs**. An empty block is enough:

   <!-- doc-check: proto -->
<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
   ```protobuf
   service Subscriber {
   }
   ```

2. **The schema was never loaded.** `context.init(url, paths)` scans each path
   recursively for `.proto` files. Pass the directory, not the file.

3. **The name does not match.** It is `package` + `.` + `service`:
   `package Calculator` with `service Math` is `Calculator.Math`.

> [!TIP]
> Trailing segments beyond the contract are allowed and are trimmed away.
> `Combat.Player.player6` resolves against `service Player` in package `Combat`,
> which is how you give each instance of a service its own queue.

### illegal token in a schema

**Symptom**

```
Error: illegal token 'uuid' (line 1)
```

**Cause.** `uuid` is a custom type, and either it was not registered before the
schema was parsed, or the schema does not declare `syntax = "proto3";`. Both are
required; the second one is easy to miss because the error names the type rather
than the missing line.

**Fix.** Register the type on the factory **before** `context.init()` — `init()`
parses your protos — and give the schema a syntax line:

<!-- doc-check: proto -->
```protobuf
syntax = "proto3";
package Accounts;

message Account {
    uuid id = 1;
}
```

See [Custom Types](../reference/custom-types.md).

---

## Connection

### Connection refused

**Symptom**

```
Error: connect ECONNREFUSED 127.0.0.1:5672
```

**Check, in order.**

```bash
docker ps | grep rabbit          # is a broker running at all
rabbitmqctl status               # or, if it is installed natively
curl -u guest:guest localhost:15672/api/overview   # management API answering
```

The default port is 5672 (15672 is the management UI, not the AMQP port — a
surprisingly common mix-up). If the broker is on another host, check the firewall
allows 5672.

### Authentication failed

**Symptom**

```
Error: ACCESS_REFUSED - Login was refused
```

**Causes.**

- Wrong credentials in the URL: `amqp://user:password@host:5672/`.
- Wrong virtual host. The path segment after the port is the vhost:
  `amqp://user:pass@host:5672/` is the default `/`, and
  `amqp://user:pass@host:5672/my-vhost` is a different one. An empty path and a
  named path are not the same broker namespace.
- The user exists but has no permissions on that vhost:

  ```bash
  rabbitmqctl add_user myuser mypassword
  rabbitmqctl set_permissions -p / myuser ".*" ".*" ".*"
  ```

> [!CAUTION]
> RabbitMQ refuses `guest` over a non-loopback connection by default. A
> connection string that works on your laptop and fails from a container is
> usually this, not a typo.

### Connection drops

Protobus reconnects automatically. The relevant knobs and events:

<!-- doc-check: compile -->
```typescript
import { Context } from 'protobus';

async function main() {
    const context = new Context();

    await context.init('amqp://localhost', ['./proto'], {
        reconnection: {
            maxRetries: 0,        // 0 = keep trying forever
            maxDelayMs: 30000,
        },
    });

    context.connection.on('disconnected', () => console.warn('connection lost'));
    context.connection.on('reconnected', () => console.info('connection restored'));
}

main().catch((error) => { console.error(error); process.exit(1); });
```

If reconnection never succeeds, the cause is almost always outside protobus:
the broker is gone, the credentials were rotated, or a network policy changed.
Raise `AMQP_HEARTBEAT_SECONDS` handling only after ruling those out — see
[Configuration](../reference/configuration.md#heartbeats).

---

## Schema

### Proto file not found

**Symptom**

```
Error: ENOENT: no such file or directory, open '/path/to/service.proto'
```

`ProtoFileName` is resolved relative to the process's working directory unless it
is absolute, and the working directory is not where your source file lives:

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
get ProtoFileName() { return './service.proto'; }              // fragile
get ProtoFileName() { return __dirname + '/service.proto'; }   // correct
```

`RunnableService` derives the name by convention from `ServiceName`
(`Calculator.Math` → `Calculator.proto`) and looks it up among the paths you gave
`context.init()`, so naming the file after the package avoids the getter
entirely.

### Type mismatch

**Symptom**

```
Error: Cannot read property 'encode' of undefined
```

The request or response type named in the `rpc` line does not resolve. In a
protobus schema, **rpc types are fully qualified**:

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
package MyPackage;

message Request { string field = 1; }
message Response { string field = 1; }

service MyService {
    rpc myMethod(MyPackage.Request) returns(MyPackage.Response);
    //           ^^^^^^^^^^ package included
}
```

---

## RPC

### UnroutableError: nobody is serving that queue

**Symptom.** A call rejects immediately with `UnroutableError` rather than
hanging.

**Cause.** RPC requests are published with AMQP's `mandatory` flag, so the broker
returns a message that reaches no queue instead of dropping it. Nothing is bound
for that service name.

**Check.**

```bash
rabbitmqctl list_queues name consumers | grep MyPackage.MyService
```

Zero consumers means the service is not running. No queue at all means it has
never run against this broker, or the name is misspelled.

> [!TIP]
> This failing fast is the point. Before 2.0 the same mistake produced a caller
> that waited out the full RPC timeout. See
> [Migration](../migration.md) and [Errors](../reference/errors.md).

### Request timeout

**Symptom.** `RpcTimeoutError` after a long wait.

**There are two separate clocks, and raising the wrong one does nothing.**

| Setting | Whose | Default | What it bounds |
|---|---|---|---|
| `RPC_CALL_TIMEOUT_MS` | the **caller's** | `600000` (10 min) | how long `proxy.method()` waits for a reply |
| `MESSAGE_PROCESSING_TIMEOUT` | the **server's** | `600000` (10 min) | how long a handler may run before the delivery is abandoned |

If your caller gives up, raise `RPC_CALL_TIMEOUT_MS` (or pass `timeoutMs` on the
call). If your handler is being cut off mid-work, raise
`MESSAGE_PROCESSING_TIMEOUT` on the service.

**Before raising either**, check that the callee is not simply failing and
retrying: a request that keeps throwing climbs the retry ladder without publishing
a reply, so the caller sees a long silence rather than an error. See
[Delivery Guarantees](../concepts/delivery-guarantees.md).

### Method is not a function

**Symptom**

```
TypeError: proxy.myMethod is not a function
```

**Cause.** `ServiceProxy` builds its methods from the schema during `init()`.
Before that it has none.

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
const proxy = new ServiceProxy(context, 'MyPackage.MyService');
await proxy.init();          // this is what installs the methods
```

If `init()` did run, the method name does not match the `rpc` name in the
`.proto` exactly — including case.

> [!NOTE]
> TypeScript will not catch either mistake: `ServiceProxy` has no index
> signature, so `proxy.myMethod(...)` does not type-check at all until you cast.
> Use `as ServiceProxy & IMyService` so at least the argument and return types
> are checked. See [ServiceProxy](../reference/api/service-proxy.md).

---

## Events

### Events not received

`publishEvent()` resolves but no handler runs.

1. **Subscribe before you publish.** An event published with no matching binding
   is discarded by the exchange; there is no replay.

2. **The topic pattern does not match.** `*` matches exactly **one** segment;
   `#` matches zero or more. Publishing to `ORDERS.US.SHIPPED`:

   | Pattern | Matches |
   |---|---|
   | `ORDERS.US.*` | yes |
   | `ORDERS.*.SHIPPED` | yes |
   | `ORDERS.#` | yes |
   | `ORDERS.EU.*` | no |
   | `ORDERS.*` | no — `*` is one segment, and there are two after `ORDERS` |

   The last row catches people. See [Events](../guide/events.md).

3. **The exchange is not there.**

   ```bash
   rabbitmqctl list_exchanges | grep proto.bus
   ```

### The same event is handled twice

**Causes.** Subscribing more than once (subscribe in `init()`, once), or a
handler that throws — a failed event delivery is redelivered.

Delivery is **at-least-once**, so a handler that must not run twice has to be
idempotent. Key on something stable in the event, not on arrival order:

<!-- doc-check: compile -->
```typescript
const processed = new Set<string>();

export async function handleEvent(event: { id: string }): Promise<void> {
    if (processed.has(event.id)) { return; }
    processed.add(event.id);
    // ... do the work
}
```

An in-process `Set` is fine for a demo and wrong for anything with more than one
replica or a restart. Use a store the replicas share.

---

## Performance

### High memory use

**Unbounded in-flight messages.** `maxConcurrent` is the consumer prefetch: it
bounds how many unacknowledged messages the broker will push into this process.
It defaults to **1**.

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
const service = new MyService(context, { maxConcurrent: 10 });
```

**Large payloads.** Protobuf messages are held in memory whole. Chunk them, or use
[streaming](../guide/streaming.md).

### Slow processing

Scale by running **more processes**, not by packing more services into one. Node
is single-threaded, so co-locating services buys no parallelism — it only couples
their failure domains and their deploys. Each replica competes for the same
durable queue, which is the whole design; see
[Architecture](../concepts/architecture.md).

Within one process, raise `maxConcurrent` so a replica works on several messages
while others wait on I/O.

> [!WARNING]
> There is no `ServiceCluster` in the TypeScript library. Earlier versions of this
> page showed `cluster.use(MyService, 4)`, which does not exist and never did
> here — that API belongs to
> [protobus-py](https://github.com/ArielLaub/protobus-py). Use `maxConcurrent`
> and more processes.

---

## Turn on debug logging

**Installing a logger is not enough.** Debug is off by default, and `Logger.debug`
is filtered against the level *before* it reaches your sink
([`lib/logger.ts`](../../lib/logger.ts)) — so a custom logger with a `debug`
method receives nothing and you conclude protobus emits no debug output.

You need **both** a sink and a level:

<!-- doc-check: compile -->
```typescript
import { setLogger, setLogLevel, LogLevel, ILogger } from 'protobus';

const debugLogger: ILogger = {
    debug: (msg) => console.log('[DEBUG]', msg),
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
};

setLogger(debugLogger);
setLogLevel(LogLevel.Debug);   // without this line, debug output is discarded
```

Or set it from the environment, which needs no code at all:

```bash
LOG_LEVEL=debug node dist/server.js
```

`LOG_LEVEL` accepts `debug`, `info` (the default), `warn`, `error` and `silent`.

> [!CAUTION]
> Debug logging can include message payloads. That is why it is off by default —
> `console.debug` writes to stdout, which whatever aggregates your logs will
> collect. Turn it on deliberately, and see
> [Security](./security.md) before doing it in production.

For machine-readable records and your own sink, see [Logging](./logging.md).

---

## Look at the broker

The management UI at <http://localhost:15672> (`guest` / `guest`) answers most
questions faster than any log line. From the command line:

<details>
<summary>Useful <code>rabbitmqctl</code> commands</summary>

```bash
# Which queues exist, how deep, and how many consumers
rabbitmqctl list_queues name messages consumers

# Just this service — should show 4: the queue, .Events, .Retry, .DLQ
rabbitmqctl list_queues name messages | grep '^MyPackage.MyService'

# The exchanges protobus declares
rabbitmqctl list_exchanges | grep proto.bus

# What is bound to the events exchange
rabbitmqctl list_bindings | grep proto.bus.events

# Anything in the dead-letter queue is a message that exhausted its retries
rabbitmqctl list_queues name messages | grep '\.DLQ'

# Empty a queue. Destructive.
rabbitmqctl purge_queue MyPackage.MyService.Events
```

</details>

A message in `<Service>.DLQ` carries headers saying why it got there —
`x-retry-count`, `x-last-error`, `x-first-failure-time` and others. They are the
fastest way to diagnose a failing handler in production; see
[Delivery Guarantees](../concepts/delivery-guarantees.md).

---

<div align="center">

**[← Architecture](../concepts/architecture.md)** · **[Docs index](../README.md)** · **[Known Issues →](./known-issues.md)**

</div>
