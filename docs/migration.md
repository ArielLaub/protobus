# Migration Guide

> Upgrading between protobus versions, and in particular the 1.x → 2.x jump, one of whose changes alters behaviour without raising an error anywhere.

**Read this if** you have a service running on protobus 1.x and want to move it to 2.x — or you have already moved and something decodes differently than it used to.

| | |
|---|---|
| **Prerequisites** | A running service. [Getting Started](./guide/getting-started.md) if you do not have one |
| **Next** | [Delivery Guarantees](./concepts/delivery-guarantees.md) · [Error Handling](./guide/error-handling.md) · [Known Issues](./operations/known-issues.md) |
| **Source** | [`CHANGELOG.md`](../CHANGELOG.md) · [`package.json`](../package.json) · [`index.ts`](../index.ts) · [`lib/message_factory.ts`](../lib/message_factory.ts) |

**On this page** — [Version compatibility](#version-compatibility) · [Do I have to do anything?](#1x--2x-do-i-have-to-do-anything) · [proto3 zero values](#the-dangerous-one-proto3-zero-values) · [Publish confirms](#publish-now-resolves-on-a-broker-confirm) · [`mandatory`](#rpc-requests-are-published-mandatory) · [Reply-before-ack](#reply-before-ack-and-confirmed-handoffs) · [The rest](#the-rest-of-the-1x--2x-breaks) · [Checklist](#upgrade-checklist) · [Verifying](#how-to-tell-you-are-done) · [2.1 → 2.2](#21--22) · [Older upgrades](#older-upgrades)

---

## Version compatibility

| protobus | Node | RabbitMQ | protobufjs | Notes |
|---|---|---|---|---|
| **2.x** | **≥ 20**, declared in `engines` | 3.8+ | 8.x | Unit-tested on 20, 22 and 24; integration-tested against `rabbitmq:3-management-alpine` |
| 1.x | no `engines` constraint declared | 3.8+ | 7.x | `1.2.1`–`1.4.1` shipped a `.env` containing a live npm token, since revoked; 1.4.0 and 1.4.1 were **removed from the registry** |
| 1.4.2, 1.5.0 | — | — | — | **Never published.** Their fixes ship inside 2.0.0, so the real upgrade path is **1.4.1 → 2.x** |
| 0.x | — | — | — | See [Older upgrades](#older-upgrades) |

The Node floor is real, not aspirational: `engines: { "node": ">=20" }` first appears in the 2.0.0 `package.json`; 1.4.1 declared no engines field at all. TypeScript is not a constraint the package expresses — 1.4.1 and 2.2.0 are both built with typescript 5.x and ship `ES2020`-target declarations.

**Other language ports.** [protobus-py](https://github.com/ArielLaub/protobus-py) tracks this port and its wire compatibility is verified against a live broker in both directions — streaming since 1.4.0, message priority since 2.2.0. [protobus-go](https://github.com/ArielLaub/protobus-go) is experimental and makes no parity claim.

---

## 1.x → 2.x: do I have to do anything?

Probably yes, and the item at the top of this table is why the page exists. Read the "Breaks" column before you read anything else — **silently** means nothing throws, nothing fails to compile, and your code takes a different branch than it did last week.

| Change | Breaks | What to do |
|---|---|---|
| **proto3 zero values decode as `0` / `""` / `false`** | **Silently, at runtime** | Audit every `??`, `=== undefined` and `in` against a decoded request. [Details](#the-dangerous-one-proto3-zero-values) |
| `publish()` resolves on a broker confirm | At runtime — new latency, new errors | Handle `PublishError` subclasses; stop assuming a publish returns before delivery. [Details](#publish-now-resolves-on-a-broker-confirm) |
| RPC requests are `mandatory` | At runtime — a new error where there was a timeout | Expect `UnroutableError` when no service is bound. [Details](#rpc-requests-are-published-mandatory) |
| `ServiceCluster` removed | **At compile time** | One service per process; `RunnableService.start()` |
| `lateAck` defaults to `true` | At runtime — failures now retry instead of vanishing | Nothing, unless you relied on at-most-once |
| protobufjs 7 → 8 | At install time | `npm install`, then regenerate any generated types |
| Node < 20 | At install time | Upgrade Node |
| Stream cancellation declares `proto.bus.cancel` | At runtime, if broker permissions forbid it | Grant `configure` on `proto.bus.cancel`, or accept the logged warning |
| Dispatch is bound to the routing key and the service's own contract | At runtime, for callers that were already misrouting | Fix the caller; this closes a permissions hole |
| `bigint` rejects out-of-range and oversized values | At runtime, with a `RangeError` | Nothing, if your values were in range |
| Debug logging off by default | At runtime — log volume drops | `LOG_LEVEL=debug` to restore, minus the payloads |
| `reconnected` fires after topology restore | At runtime — timing | Nothing; this is the fix, not the break |
| Connections negotiate a 30-second heartbeat | At runtime — faster failure detection | `?heartbeat=0` on the URL to opt out |
| `PublishMessageError` no longer wraps every failure | At runtime, for `catch` blocks matching on it | Match `PublishError` or a specific subclass |
| Reply-before-ack, confirmed retry/DLQ handoffs | Nothing | Nothing. [Details](#reply-before-ack-and-confirmed-handoffs) |

---

## The dangerous one: proto3 zero values

> [!CAUTION]
> This is the change that can alter which branch your code takes **without raising an error anywhere**. Nothing throws, nothing logs, and no test that only checks non-zero values will catch it.

proto3 omits any scalar equal to its default from the wire. Until 2.0.0, decoding did not supply the default back — so a legitimate `0`, `""` or `false` arrived as `undefined`, indistinguishable from a field nobody set. A turn index of `0`, a count of `0`, an empty cursor: all silently lost.

2.0.0 passes `defaults: true` to `Message.toObject()` ([`lib/message_factory.ts`](../lib/message_factory.ts), `decodeMessage`). That is the only decode option that changed; `arrays: true` and `enums: String` were already there in 1.4.1.

### What actually arrives now

Given `message R { int32 count = 1; string cursor = 2; bool dry = 3; Inner inner = 4; repeated int32 ids = 5; }` and an encoded `R` with nothing set:

| | 1.x | 2.x |
|---|---|---|
| decoded object | `{ ids: [] }` | `{ ids: [], count: 0, cursor: "", dry: false, inner: null }` |

Note `inner: null`, not `undefined`. An unset **message** field is now explicitly null.

### Which tests changed meaning

Assume `count` was never set by the sender.

| Your code | 1.x | 2.x | |
|---|---|---|---|
| `!request.count` | `true` | `true` | safe |
| `request.count \|\| 10` | `10` | `10` | safe |
| `request.inner ?? fallback` | `fallback` | `fallback` | safe — `null` is nullish |
| `request.count ?? 10` | `10` | **`0`** | **changed** |
| `request.count === undefined` | `true` | **`false`** | **changed** |
| `'count' in request` | `false` | **`true`** | **changed** |
| `request.cursor?.length` | `undefined` | **`0`** | **changed** |
| `request.inner === undefined` | `true` | **`false`** | **changed** |

The rule of thumb: **`||` and `!` are safe because `0`, `""` and `false` are falsy either way. `??`, `=== undefined` and `in` are not, because they distinguish absent from zero — and that is exactly the distinction that moved.**

### Before and after

<!-- doc-check: compile -->
```typescript
// Decoded shape of: message ReplayRequest { int32 fromIndex = 1; string cursor = 2; }
interface ReplayRequest { fromIndex?: number; cursor?: string }

// BEFORE — written against 1.x, where an unsent fromIndex arrived as undefined.
function startIndexOld(request: ReplayRequest): number {
    // 1.x: unsent -> undefined -> falls back to 100.
    // 2.x: unsent -> 0         -> returns 0 and replays the whole log.
    return request.fromIndex ?? 100;
}

// AFTER — proto3 has no field presence for scalars, so "unset" is not a
// question the wire can answer. Decide what zero means and say so.
function startIndexNew(request: ReplayRequest): number {
    return request.fromIndex && request.fromIndex > 0 ? request.fromIndex : 100;
}
```

`startIndexOld` compiles, runs, logs nothing and replays from the beginning. That is the whole failure mode.

> [!IMPORTANT]
> If you genuinely need to distinguish "unset" from "zero", proto3 cannot express it with a bare scalar and never could — the 1.x behaviour was an accident, not a feature. Declare the field `optional` (proto3 field presence) or use a wrapper type such as `google.protobuf.Int32Value`, and the distinction becomes real rather than emergent.

### How to audit

```bash
# The three unsafe operators, against anything that looks like a decoded request.
grep -rnE '\?\?|=== undefined|!== undefined' src/ | grep -iE 'request|req\.|payload|event'
grep -rnE "'[A-Za-z_]+' in (request|req|payload|event)" src/
```

Treat every hit as a question: *does this field arrive as zero rather than absent now, and does that change the branch?*

---

## `publish()` now resolves on a broker confirm

Channels are opened with `createConfirmChannel()`. In 1.x, `await publish(...)` resolved as soon as amqplib accepted the bytes into its own write buffer — so it could report success for a message RabbitMQ never received. A resolved publish in 2.x means the broker confirmed it, routing succeeded where `mandatory` was requested, and the write buffer drained.

Two consequences.

**Publishes now take a broker round trip.** Anything that assumed `publish()` returned before the message could be delivered is now racy. That was an artefact of unconfirmed publishing, never a guarantee.

**There is a new error surface.** `PublishError` and four subclasses are exported from the package root. Two are definite failures and two are *ambiguous* — the broker may or may not have stored the message — so retrying either can duplicate.

<!-- doc-check: compile -->
```typescript
import {
    PublishError,
    PublishNackedError,
    UnroutableError,
    PublishConfirmTimeoutError,
    ChannelClosedError,
} from 'protobus';

function describe(error: unknown): string {
    if (error instanceof PublishNackedError) return 'definite: broker refused it, republish is safe';
    if (error instanceof UnroutableError) return 'definite: matched no queue, republish is safe';
    if (error instanceof PublishConfirmTimeoutError) return 'AMBIGUOUS: no confirm arrived';
    if (error instanceof ChannelClosedError) return 'AMBIGUOUS: channel closed unconfirmed';
    if (error instanceof PublishError) return 'publish failed';
    return 'not a publish failure';
}
```

Every publish carries a `messageId`, stable across redeliveries and every retry and DLQ hop, so a consumer can recognise a duplicate. In 2.2.x a caller could not *set* one, so a caller-driven republish after an ambiguous outcome sent a new id and was unrecognisable as the same request; `CallOptions.messageId` closes that in 2.3.0 — see [Deduplicating a caller's own republish](./concepts/delivery-guarantees.md#deduplicating-a-callers-own-republish). `PUBLISH_CONFIRM_TIMEOUT_MS` (default 30000) and `MAX_OUTSTANDING_CONFIRMS` (default 256) bound how long a confirm is awaited and how much unconfirmed work may be in flight per channel.

Full treatment in [Delivery Guarantees](./concepts/delivery-guarantees.md).

> [!NOTE]
> **If you were catching `PublishMessageError`** — only reachable by importing from `protobus/dist/lib/service_proxy`, since it was never a root export — it stopped wrapping anything in 2.1.0, when `ServiceProxy` stopped replacing every failure with it: doing so discarded the very distinction the publish path exists to report, along with the `messageId` that makes deduplication possible. **2.3.0 deletes the class**, since nothing had constructed it for two minor versions and a `catch` on it could never match. Match on `PublishError` or a specific subclass instead.

---

## RPC requests are published `mandatory`

A request that routes nowhere — no service bound to the key — now fails immediately with `UnroutableError` instead of waiting out the full RPC timeout, which defaults to 600000 ms.

Events are deliberately **not** mandatory: an event with no subscribers is normal, and making that an error would break fan-out publishing.

What changes for you: calling a service that is not deployed used to look like a slow timeout and now looks like a fast, specific error. Code that treated "RPC timeout" as "the service is down" will stop seeing that timeout and start seeing `UnroutableError`. That is an improvement, but it is a different exception class in the same `catch`.

---

## Reply-before-ack and confirmed handoffs

Two ordering fixes with nothing to do on your side, listed because they change what a crash costs.

**The reply is published before the request is acknowledged.** The previous order acked first, so a crash in between lost the response with the request already settled and unable to be redelivered. Now the worst case is a redelivered request — at-least-once, which the retry ladder already assumes — rather than a caller waiting forever for an answer that no longer exists.

**Retry and DLQ handoffs are confirmed before the original is acked.** These previously bypassed the publish path entirely via `channel.sendToQueue`, so the only remaining copy of a failing message could be dropped on the floor.

The net effect is slightly more duplicate work and strictly fewer lost messages. If your handlers are not idempotent, this is the release in which that starts to matter — see [Delivery Guarantees → Where duplicates come from](./concepts/delivery-guarantees.md#where-duplicates-come-from).

---

## The rest of the 1.x → 2.x breaks

### `ServiceCluster` is gone

Removed in the unpublished 1.5.0 and therefore in 2.0.0. It was a root export in 1.4.1, so this one **breaks at compile time** — which makes it the easy kind.

Node is single-threaded, so co-locating services in one process bought no parallelism and only coupled their failure domains and their deploys. It also could not pass `IMessageServiceOptions` through, leaving retry, DLQ and prefetch tuning unreachable for any service started through it. `MessageService` now registers its own schema during `init()`, so a service is self-sufficient.

<!-- doc-check: compile -->
```typescript
// after — one service per process
import { RunnableService, IContext } from 'protobus';

class OrdersService extends RunnableService {
    get ServiceName(): string { return 'Orders.Service'; }
}

export async function boot(context: IContext): Promise<void> {
    await RunnableService.start(context, OrdersService, { maxConcurrent: 2 });
}
```

The 1.x equivalent — `new ServiceCluster(context)`, `cluster.use(MyService)`, `await cluster.init()` — has no replacement and needs one process per service.

### `lateAck` defaults to `true`

It is now an explicit `IMessageServiceOptions` field rather than being inferred from `maxConcurrent`. Deriving durability from a concurrency knob meant a service constructed without options acked on delivery and **silently discarded failures**.

If you were relying on that — genuine at-most-once with no error reporting — pass `lateAck: false` explicitly. Be clear about what it costs: it disables the retry path, the DLQ path and the error reply, so a failed message is dropped and its caller waits out the full RPC timeout.

### Dispatch is bound to the routing key and to the contract

Two hardening changes, one in 1.5.0 and one in 2.1.0. The method to run used to come from the message body alone, so a client able to publish to the bus chose the method regardless of what it was routed as — which made RabbitMQ topic permissions unenforceable. Now the routing key, the owning service name, and the set of methods the subclass actually implements are all enforced. A body method that is not a declared method of the receiving contract is answered with `InvalidMethodError`.

This only breaks a caller that was already routing one method and asking for another.

### Stream cancellation needs a new exchange

Breaking out of a `for await` now sends a cancellation notice over a new **fanout** exchange, `proto.bus.cancel`, with one exclusive auto-deleting queue per process. If your broker credentials cannot declare it, the service logs a warning and runs **without** cancellation rather than failing to start ([`lib/cancel_listener.ts`](../lib/cancel_listener.ts)). Grant `configure` on `proto.bus.cancel` if you want the feature.

### `bigint` got stricter, twice

1.5.0: out-of-range values now throw `RangeError` instead of being silently absolutised (`-5n` stored as `5n`) and truncated mod 2²⁵⁶. 2.1.0: a `bigint` carrying more than 32 bytes on the wire is rejected rather than decoded — the decoder was quadratic in input length, so a peer holding nothing more than the ordinary right to call a service could stall the event loop with one message. Nothing this library encodes can produce one. Valid values and the wire format are unaffected.

### Logging is quieter, and redacted

Debug logging is off by default (`LOG_LEVEL=debug` restores it, minus the payloads), payload dumps are gone entirely, the AMQP URL is logged with its password replaced, and `x-last-error` on retry and DLQ metadata now carries an error's class and `code` rather than its raw message. `PROTOBUS_EXPOSE_INTERNAL_ERRORS` (default `true`, matching 1.x) controls whether an unhandled error's message still reaches the calling service.

### Connection behaviour

Connections negotiate a 30-second heartbeat unless the URL already carries one (`?heartbeat=0` opts out); left to the broker it was 60, and amqplib closes after two missed intervals, so worst-case detection of a vanished peer was about two minutes. `reconnected` now fires only once channels, queues, bindings and consumers are back — and a publish issued during a reconnection waits for it, bounded by `CONNECTION_READY_TIMEOUT_MS` (default 30000), rather than throwing `NotConnectedError`. It may reject with the new `NotReadyError`.

---

## Upgrade checklist

1. **Move to Node 20 or later.** 2.x declares `engines: { "node": ">=20" }`, so npm reports the mismatch on install — and refuses outright under `engine-strict`.
2. **Reinstall and rebuild.** protobufjs moves 7.x → 8.x, which also clears a hard `ERESOLVE` between the runtime and `protobufjs-cli`. Regenerate anything produced by `protobus generate-types`.
3. **Delete `ServiceCluster` usage.** The compiler will find every site. One service per process, started with `RunnableService.start()`.
4. **Audit the three unsafe operators.** `??`, `=== undefined` / `!== undefined` and `in`, against anything decoded off the bus. This is the step that is worth doing carefully; nothing else on this list can fail silently.
5. **Widen your `catch` blocks.** `UnroutableError` where you used to get a timeout; `PublishError` subclasses where you used to get `PublishMessageError` or nothing.
6. **Decide about `lateAck`.** Leave it at the new default unless you specifically want messages dropped on failure.
7. **Check broker permissions** for `proto.bus.cancel` if you use streaming and want cancellation to work.
8. **Check your log pipeline.** Volume drops sharply and payloads are gone. If a dashboard was parsing a payload out of a log line, it will go blank.
9. **Re-read your retry settings against the new delivery contract.** [Delivery Guarantees → The parked caller](./concepts/delivery-guarantees.md#the-parked-caller).

---

## How to tell you are done

Three of these need a running broker; the other two are a compile and a grep.

- **The compiler is green.** That clears `ServiceCluster` and any import that moved. It clears nothing else.
- **A decoded zero survives a round trip.** Send a request with a scalar explicitly set to `0` / `""` / `false` and assert the handler sees the zero, not a default. This is the regression test for step 4, and it is the one your 1.x suite almost certainly does not have.
- **Every `??` against a decoded field has a deliberate answer** to "what should zero do here?". Grep, then read.
- **An RPC to a service nobody is running throws quickly.** You should see `UnroutableError` in well under a second, not `RpcTimeoutError` after ten minutes.
- **A handler that throws produces a retry, then a DLQ entry.** Check the management UI for `<Service>.Retry` and `<Service>.DLQ`, and read `x-retry-count` and `x-first-failure-time` off the dead-lettered message.

---

## 2.1 → 2.2

Additive. Nothing breaks, and priority is off unless you ask for it.

**Message priority**, so a control message can overtake bulk traffic on a service's single request queue. A service binds one queue to `REQUEST.<ServiceName>.*`, so every method shares it and RabbitMQ delivers FIFO — which means a fan-out of thousands puts the next control message behind all of them. Adds `maxPriority` on `IMessageServiceOptions`, `priority` on the new `CallOptions`, the constants `Config.PRIORITY_NORMAL` / `PRIORITY_HIGH` / `PRIORITY_CONTROL` / `RECOMMENDED_MAX_PRIORITY`, `Config` itself at the package root, and `InvalidPriorityError`. See [Message Priority](./guide/priority.md).

> [!WARNING]
> **Enabling `maxPriority` on a service that has already run requires an operator to drain and delete its main queue first.** RabbitMQ fixes queue arguments at declare time, so adding `x-max-priority` to an existing queue is a 406 `PRECONDITION_FAILED` that closes the channel — and protobus shares one connection across every listener in a process. The service fails loudly on startup rather than ignoring the setting. Procedure A in [Queue Migration](./operations/queue-migration.md). The `.Retry` and `.DLQ` queues are deliberately untouched, which keeps this a one-queue migration.

Two fixes ride along, both only reachable once something else has gone wrong:

- **A re-published message keeps its priority.** Protobus builds a fresh properties object by hand at each retry and DLQ hop, and `priority` was not among the properties copied — so a control message that failed once came back at priority 0 and queued behind the whole bulk backlog, which is the exact failure priority exists to prevent.
- **`maxPriority` with `lateAck: false` is now refused** rather than silently doing nothing. RabbitMQ applies no QoS prefetch to an auto-ack consumer, so the broker hands it the entire backlog and priority has nothing left to reorder.

**Known limitation, stated rather than hidden.** Priority reorders messages still *in the queue*; it cannot reach one the broker has already prefetched into a consumer. With prefetch `N` across `R` replicas, up to `N × R` bulk messages can still sit ahead of a control message. Measured against a 50-message backlog, the control message was handled at index 1, 5 and 20 for prefetch 1, 5 and 20 respectively. This is a change of scale — thousands down to single digits — not a guarantee.

### 2.0 → 2.1

2.1.0 is a minor release carrying five changes that are breaking under a strict reading of semver. It is a minor because 2.0.0 had no adopters: the supported path is 1.4.1 → 2.1.0 or later, and every one of those five is already in the [1.x → 2.x table](#1x--2x-do-i-have-to-do-anything) above — the `bigint` size limit, contract-bound dispatch, `ServiceProxy` raising delivery errors as they stand, restoration-aware `reconnected`, and the negotiated heartbeat.

---

## Older upgrades

<details>
<summary><b>0.7.x → 0.8.x → 0.9.x, and one-off dependency notes</b> — kept for history</summary>

<br/>

These predate the changelog and are recorded as they were written. Nothing here has been re-verified against the current source.

### Upgrading to 0.9.x

No breaking changes; 0.9.x was backwards compatible with 0.8.x. It brought Trie-based event routing, better error messages and dependency updates.

### Upgrading from 0.7.x to 0.8.x

**`ServiceProxy` requires `init()`.**

<!-- doc-check: ignore why="0.7.x API that no longer exists; a proxy method is built at runtime and has no static type" -->
```typescript
// Before (0.7.x)
const proxy = new ServiceProxy(context, 'Service');
const result = await proxy.method({});

// After (0.8.x)
const proxy = new ServiceProxy(context, 'Service');
await proxy.init();  // required
const result = await proxy.method({});
```

**Event subscription moved to `subscribeEvent()` with a package-qualified type.**

<!-- doc-check: ignore why="0.7.x API that no longer exists; MessageService has had no on() since before 1.0" -->
```typescript
// Before (0.7.x)
service.on('EventType', handler);

// After (0.8.x)
await service.subscribeEvent('Package.EventType', handler);
```

Migration steps: add `await proxy.init()` after constructing each proxy, switch to `subscribeEvent()`, and add the package prefix to every event type.

### Updating amqplib

```bash
npm install amqplib@latest @types/amqplib@latest
```

Watch for channel-API and connection-option changes, and test thoroughly. protobus has pinned `amqplib` at `^0.10.9` since 1.4.1.

### Migrating from tslint to eslint

TSLint is deprecated. Remove `tslint` and `tslint.json`, install `eslint` with `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`, add an ESLint config, and point your `lint` script at it. protobus itself moved to flat config (`eslint.config.mjs`) with `typescript-eslint`.

</details>

<details>
<summary><b>Evolving your <code>.proto</code> safely</b> — additions, removals, renames</summary>

<br/>

**Adding a field is backwards compatible.** Give it a new number and leave the existing ones alone.

**Removing a field needs a reservation**, so the number and name can never be reused with a different meaning:

<!-- doc-check: proto -->
```protobuf
syntax = "proto3";

message Order {
    reserved 2;
    reserved "old_field";
    string order_id = 1;
}
```

**Renaming a service needs coordination**, because the name is the routing key. Deploy the new name alongside the old, migrate every caller, then remove the old one. A service's queue is `<ServiceName>` and its binding is `REQUEST.<ServiceName>.*`, so a rename is a new queue — see [Queue Migration](./operations/queue-migration.md).

Note that a service is addressable under a runtime name that differs from the name in its `.proto`: several instances can share one schema as `Combat.Player.player1`, `…player2`. That is supported deliberately and is not a rename.

</details>

---

<div align="center">

**[← Docs index](./README.md)** · **[CHANGELOG](../CHANGELOG.md)** · **[Delivery Guarantees →](./concepts/delivery-guarantees.md)**

</div>
