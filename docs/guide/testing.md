# Testing

> Three levels of test for a protobus service, what each one is actually worth, and the isolation rules that stop them fighting each other.

**Read this if** you are writing tests for a service you built with protobus. Testing protobus itself is a different job; this page is about your code.

| | |
|---|---|
| **Prerequisites** | [Getting Started](./getting-started.md) — you have a service and a proxy that calls it |
| **Next** | [Error Handling](./error-handling.md) · [Architecture](../concepts/architecture.md) |
| **Source** | [`jest.config.js`](../../jest.config.js) · [`jest.integration.config.js`](../../jest.integration.config.js) · [`docker-compose.yml`](../../docker-compose.yml) · [`scripts/run-combat-sample.sh`](../../scripts/run-combat-sample.sh) |

**On this page** — [Three levels](#three-levels) · [Level 1: the handler alone](#level-1-the-handler-alone) · [Level 2: against a real broker](#level-2-against-a-real-broker) · [Isolating tests from each other](#isolating-tests-from-each-other) · [Asserting on events](#asserting-on-events) · [Asserting on failures](#asserting-on-failures) · [Level 3: end-to-end](#level-3-end-to-end) · [Testing your documentation](#testing-your-documentation)

---

## Three levels

| Level | Needs a broker | Cost per test | What it can catch |
|---|---|---|---|
| **1. Handler alone** | no | ~1 ms | your business logic, validation, error classification |
| **2. Service + broker** | yes | ~100 ms–1 s | encoding, routing, retries, events, timeouts |
| **3. End-to-end script** | yes | seconds | wiring, shutdown, decorators, "the whole thing runs" |

Most service suites should be mostly level 1, and most are not — people reach for a broker because the service class *looks* like it needs one. It does not. Start at level 1 and go up only when the thing you want to assert genuinely lives in the transport.

---

## Level 1: the handler alone

A protobus handler is a normal async method. `MessageService` calls it as `handler.call(this, data, actor, correlationId, context)` ([`lib/message_service.ts:391`](../../lib/message_service.ts)) — the request object first, then metadata. There is nothing magic to reproduce.

The one thing the constructor does need is a context object whose `connection` can register an event listener: `MessageService` builds its listeners eagerly, and each one attaches a reconnection restorer via `attachRestorer`, which calls `connection.on('reconnected', …)` when the connection has no `registerRestorer` ([`lib/connection.ts:194`](../../lib/connection.ts)). Two no-op methods satisfy it.

<!-- doc-check: compile id=test-stub -->
```typescript
import { HandledError, IContext, MessageService } from 'protobus';

/** Enough of a context to construct a service. Never call init() on this. */
export function stubContext(): IContext {
    return { connection: { on() { /* no-op */ }, removeListener() { /* no-op */ } } } as unknown as IContext;
}

export class OrdersService extends MessageService {
    get ServiceName() { return 'Orders.Service'; }
    get ProtoFileName() { return 'Orders.proto'; }

    async create(request: { customerId?: string; cents?: number }) {
        if (!request.customerId) throw new HandledError('customerId is required', 'VALIDATION_ERROR');
        return { id: `order-${request.customerId}`, cents: request.cents ?? 0 };
    }
}
```

The cast is deliberate and worth being honest about: `IContext` is a large interface and a stub is not one. Casting says *this object is only ever used to construct, never to connect*, which is exactly the contract of a level-1 test.

<!-- doc-check: ignore why="a jest test; describe/it/expect are not available in the snippet sandbox" -->
```typescript
import { OrdersService, stubContext } from './orders.service';

describe('OrdersService.create', () => {
    const service = new OrdersService(stubContext());

    it('returns an order id', async () => {
        await expect(service.create({ customerId: 'c1', cents: 500 }))
            .resolves.toMatchObject({ id: 'order-c1', cents: 500 });
    });

    it('rejects a missing customerId as terminal, not retriable', async () => {
        await expect(service.create({})).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            isHandled: true,
        });
    });
});
```

No `init()`, no `await context.init(...)`, no broker, no queues to clean up. Asserting `isHandled: true` is worth doing explicitly — it is the difference between a caller getting an answer in milliseconds and a caller waiting out the retry ladder, and it is invisible in the happy path.

> [!TIP]
> If a handler is hard to test this way it is usually because it reaches for I/O directly. Take the dependency as a constructor argument and the level-1 test becomes trivial — which is ordinary advice, but protobus makes it cheap to ignore because the service class is easy to construct.

---

## Level 2: against a real broker

There is no in-memory transport, and no mock worth building: the behaviour you are testing at this level *is* RabbitMQ's. Use a real one in Docker.

This repo's own compose file is the whole setup ([`docker-compose.yml`](../../docker-compose.yml)):

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management-alpine
    container_name: protobus-rabbitmq
    ports:
      - "5672:5672"     # AMQP
      - "15672:15672"   # management UI, guest / guest
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 5s
      timeout: 10s
      retries: 5
      start_period: 10s
```

The healthcheck is the part that matters, because it is what makes `--wait` mean anything:

```bash
docker compose up -d --wait     # blocks until the healthcheck passes
npx jest --config jest.integration.config.js
docker compose down
```

That is exactly this repo's `test:integration` script, which additionally preserves jest's exit code across the teardown:

```bash
docker compose up -d --wait && { jest --config jest.integration.config.js; status=$?; docker compose down; exit $status; }
```

> [!WARNING]
> `docker compose up -d` without `--wait` returns as soon as the container starts, several seconds before RabbitMQ accepts connections. The result is a suite that passes locally and fails on the first run in CI, which is the least useful failure mode there is.

### Two jest configs, not one

Unit tests and broker tests want different settings, so they get different configs.

| | `jest.config.js` | `jest.integration.config.js` |
|---|---|---|
| roots | `test/` | `test/integration/` |
| ignores | `/test/integration/` | — |
| `forceExit` | no | **yes** |
| `testTimeout` | 30000 | 30000 |

`npm test` therefore runs only the unit tests, and the broker suite is opt-in. Copy that split; a suite that silently needs Docker is a suite people stop running.

`forceExit: true` is there because amqplib leaves handles behind — the comment in the config says so in as many words. Without it jest hangs after the last assertion and you spend an afternoon looking for the leak in your own code.

---

## Isolating tests from each other

This is where broker tests actually go wrong, and it has one cause: **a protobus service's queues are durable, named after the service, and their arguments are fixed at declare time.**

Two consequences:

1. Two test files that both declare `Orders.Service` compete for the same queue. Under `--runInBand` they merely interfere; in parallel, one file's service consumes the other file's messages and both fail confusingly.
2. Changing `retryDelayMs` between runs fails startup. It becomes the retry queue's `x-message-ttl`, RabbitMQ cannot change that in place, and protobus surfaces the broker's `PRECONDITION_FAILED` as a [`RetryQueueMismatchError`](../reference/errors.md#retryqueuemismatcherror) telling you to drain and delete the queue.

The fix this repo uses is to stamp the service name per run. From [`test/integration/message_priority.test.ts:32`](../../test/integration/message_priority.test.ts):

<!-- doc-check: ignore why="quoted verbatim from the repo's own test; it is a fragment, not a standalone snippet" -->
```typescript
/** Unique per run: queues are durable, and their arguments are immutable. */
const STAMP = `P${Date.now()}`;
```

The stamp becomes the proto package, so every queue name is unique to the run:

<!-- doc-check: compile id=stamped-service -->
```typescript
import { IContext, MessageService } from 'protobus';

const STAMP = `T${Date.now()}`;

function protoFor(pkg: string): string {
    return `syntax = "proto3";
package ${pkg};

message Request  { string tag = 1; }
message Response { string tag = 1; }

service Service {
    rpc handle(${pkg}.Request) returns(${pkg}.Response);
}`;
}

export class RecordingService extends MessageService {
    public handled: string[] = [];

    constructor(context: IContext, private pkg: string = STAMP) {
        super(context, { maxConcurrent: 1, retry: { maxRetries: 0 } });
    }

    get ServiceName() { return `${this.pkg}.Service`; }
    get ProtoFileName() { return ''; }
    get Proto() { return protoFor(this.pkg); }

    async handle(request: { tag: string }) {
        this.handled.push(request.tag);
        return { tag: request.tag };
    }
}
```

Then delete the queues in `afterAll`, with a plain amqplib connection — protobus has no delete API, and this is what the repo does:

<!-- doc-check: compile id=cleanup-queues -->
```typescript
import * as amqplib from 'amqplib';

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';

/** Delete a service's queues so a re-run is not blocked by stale arguments. */
export async function cleanupQueues(names: string[]): Promise<void> {
    const conn = await amqplib.connect(AMQP_URL);
    for (const name of names) {
        // A failed delete kills the channel, so use one channel per queue.
        const ch = await conn.createChannel();
        ch.on('error', () => undefined);
        try { await ch.deleteQueue(name); } catch { /* already gone */ }
        try { await ch.close(); } catch { /* channel died on the delete */ }
    }
    await conn.close();
}
```

> [!IMPORTANT]
> **How many queues to delete depends on `maxRetries`.** With `retry: { maxRetries: 0 }` the listener returns before declaring the retry and DLQ queues at all ([`lib/message_listener.ts:98`](../../lib/message_listener.ts)), so there are two: `<Service>` and `<Service>.Events`. With retries enabled there are four — add `<Service>.Retry` and `<Service>.DLQ`. Setting `maxRetries: 0` in tests that are not *about* retries is worth doing for that reason alone, and because it removes multi-second delays from every failure assertion.

The callback queue needs no cleanup: it is exclusive and auto-delete, and disappears with the client process.

### Disconnect in `afterAll`

<!-- doc-check: ignore why="a jest lifecycle hook; describe/afterAll are not available in the snippet sandbox" -->
```typescript
afterAll(async () => {
    await context.connection.disconnect();
    await cleanupQueues([`${PKG}.Service`, `${PKG}.Service.Events`]);
}, 30000);
```

Disconnect first, then delete: deleting a queue that still has a consumer works, but leaves the consumer's channel erroring on the way out. The explicit 30-second budget is the repo's, and is there because container teardown under load is slower than the default per-test timeout.

---

## Asserting on events

An event is fire-and-forget, so a test has to wait for it rather than await it. The pattern in [`test/integration/message_service.test.ts:91`](../../test/integration/message_service.test.ts) is a promise the subscriber resolves:

<!-- doc-check: ignore why="a jest test; describe/it/expect are not available in the snippet sandbox" -->
```typescript
it('publishes OrderCreated when an order is created', async () => {
    const received = new Promise<any>((resolve) => {
        service.subscribeEvent('Orders.OrderCreated', async (event: any) => resolve(event));
    });

    await proxy.create({ customerId: 'c1' });

    await expect(received).resolves.toMatchObject({ customerId: 'c1' });
});
```

Two things to get right:

- **Subscribe before you publish.** The events queue is durable and not auto-delete, so a message published first is not lost — but the binding is only added by `subscribeEvent`, and a message published before the binding exists routes nowhere. Await the subscription, then act.
- **Give it a deadline.** `await expect(received).resolves…` under jest's `testTimeout` fails after 30 s with "exceeded timeout", which does not say which side broke. `Promise.race` against a 2-second rejection produces a far better failure message.

Wildcard topics work the same way — `subscribeEvent(type, handler, 'CUSTOM.*.TOPIC')` — and the matching rules are the trie's, documented and pinned in [`test/unit/trie_documented_examples.test.ts`](../../test/unit/trie_documented_examples.test.ts). `*` is exactly one word; `#` is zero or more. That test exists because a doc page once claimed `ORDERS.*.CREATED` matched `ORDERS.US.123.CREATED`. It does not.

---

## Asserting on failures

The assertion that matters is not "it rejected" — it is **how many times the handler ran**. That is the only way to see the retry classification, and it is invisible from the caller's side.

<!-- doc-check: ignore why="a jest test; describe/it/expect are not available in the snippet sandbox" -->
```typescript
it('answers a HandledError immediately and does not retry', async () => {
    calls.length = 0;

    await expect(proxy.create({}))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await new Promise((r) => setTimeout(r, 500));   // a retry would land inside this window
    expect(calls).toHaveLength(1);
});
```

The `setTimeout` is load-bearing. Without it the test passes even if the message *is* being retried, because the rejection arrives long before the second attempt does.

| Thrown | Handler invocations | Caller waits |
|---|---|---|
| `HandledError` (or anything with `isHandled === true`) | 1 | one handler run |
| plain `Error` | 1 + `maxRetries` = **4** at the defaults | ~`maxRetries × retryDelayMs` = **~15 s** |

Both numbers are asserted in [`test/integration/retry.test.ts`](../../test/integration/retry.test.ts): the handled case at line 115, the exhausted case at line 151 with its "initial + 3 retries" comment.

> [!CAUTION]
> A test that throws a plain `Error` needs a per-test budget above jest's 30-second default *and* above the ladder. The repo's own suite gives one such case `90000` and the comment explains why: at the default 5-second delay the ladder is ~15 s, prefetch is 1, and a single message queued ahead of it pushes the total past 30. If your failure test is flaky on a loaded machine, this is why — set `retry: { maxRetries: 0 }` unless retrying is the thing under test.

Errors the caller raises locally — `RpcTimeoutError`, the publish failures, `NotReadyError` — never reach a handler at all and are matched on `code`. See [Errors](../reference/errors.md#which-error-am-i-looking-at) for the full table.

---

## Level 3: end-to-end

Above the integration suite there is one more test worth having: **run the real thing and assert on what it printed.**

[`scripts/run-combat-sample.sh`](../../scripts/run-combat-sample.sh) is that test for protobus itself. It compiles `sample/combatGame` with a standalone `tsc`, runs it against a live broker, and greps the output:

```bash
npm run docker:up
bash scripts/run-combat-sample.sh
```

```
==> Result: <n> shots fired, 1 winner(s), 5 eliminated
PASS: combat game completed with exactly one winner
```

The shot count varies per run; the other two do not, because the final results block prints one line per player and six players minus one winner is five eliminated. The assertions are three: a non-zero exit fails, `(WINNER!)` must appear exactly once, and at least one `shoots at` must appear — that last one because a run that fires no shots exits cleanly and proves nothing. The header comment states the case for it plainly: this is the only exercise of the framework as a consumer sees it, so a broken decorator, an event that never routes, or a hang on disconnect shows up here as "no winner" or "several winners" when unit and integration tests miss it entirely.

Two mechanics in that script are worth copying if you write your own:

- it symlinks the repo's `node_modules` into the scratch build directory, because the compiled output requires `amqplib` and `protobufjs` by bare specifier and Node resolves those by walking up from the file;
- it copies `player.proto` next to the compiled entry point, because the sample loads protos from `__dirname` and `tsc` copies no assets. **A protobuf schema is an asset your build does not move for you** — the single most common reason a service that works under ts-jest fails from `dist/`.

### `sample/combatGame` is the worked example

Six player services, each a `MessageService` with its own strategy, all in one process: RPC between players (`shoot`), pub/sub for the six event types they each subscribe to, and a disconnect at the end. It is the most complete example in the repo, and the only one that exercises RPC, events and shutdown together — read it before writing your own end-to-end test rather than after.

| | |
|---|---|
| Entry point | [`sample/combatGame/GameRunner.ts`](../../sample/combatGame/GameRunner.ts) |
| Schema | [`sample/combatGame/player.proto`](../../sample/combatGame/player.proto) |
| Services | [`sample/combatGame/players/`](../../sample/combatGame/players) — six strategies over one `BasePlayer` |
| Run it | `bash scripts/run-combat-sample.sh` |

`GameRunner` also shows the one non-obvious thing about co-locating services in a test: it calls `context.connection.setMaxListeners(50)` before creating the players, because six services each subscribing to six event types put far more than Node's default ten listeners on the shared connection, and the warning that follows looks like a leak.

For streaming, [`sample/tokenStream`](../../sample/tokenStream) is the equivalent: a server-streaming RPC with a client that consumes it.

> [!TIP]
> Leave the management UI open at <http://localhost:15672> (`guest`/`guest`) while a broker test runs. Queue depth, consumer count and unacked messages answer most "why did that hang" questions in about five seconds, and none of them are visible from inside the test.

---

## Testing your documentation

Code in a README rots silently, and a reader trusts it more than they trust the source. This repo runs its own docs: [`scripts/check-doc-snippets.js`](../../scripts/check-doc-snippets.js) extracts every fenced block that carries a directive comment, parses the `.proto` ones with protobufjs, type-checks the TypeScript ones against the built library, and executes the ones marked `run` against a live broker with their documented output asserted.

```bash
node scripts/check-doc-snippets.js              # everything
node scripts/check-doc-snippets.js --no-broker  # skip the ones needing RabbitMQ
node scripts/check-doc-snippets.js --list       # coverage report, no execution
```

The directive is an HTML comment on the line above the fence, so it does not render:

```
<!-- doc-check: compile -->
```

It exists because a review executed every runnable example in this documentation set and found nine that did not do what they said — **three of which ran cleanly and produced the wrong result**. Reading cannot catch those. The idea transfers to any repository whose docs contain code, and it is perhaps a hundred lines of work.

---

<div align="center">

**[← Message Priority](./priority.md)** · **[Docs index](../README.md)** · **[Architecture →](../concepts/architecture.md)**

</div>
