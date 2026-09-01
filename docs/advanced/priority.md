# Message Priority

A service has **one** request queue. Protobus binds it to `REQUEST.<ServiceName>.*`,
so every method of a service shares that queue and RabbitMQ delivers them FIFO.

That is usually what you want, and occasionally ruinous. The case this feature
exists for: a service whose "start the job" RPC fans out one message per user
onto its own queue. The fan-out is thousands of messages long, and the *next*
control message — a second start, a cancel, a status request — lands behind all
of them and breaches its deadline while every replica is healthy and busy.

Message priority fixes that without a second service and without a second queue:
the control message is published at a higher priority and overtakes the bulk
traffic still sitting in the queue.

> **Priority is opt-in and OFF by default.** A service that does not ask for it
> declares its queue exactly as every previous version of protobus did. See
> [Backward compatibility](#backward-compatibility) — the guarantee is precise,
> and the one thing it does *not* cover is enabling priority on a queue that
> already exists.

## Using it

Two halves. The consumer declares its queue as a priority queue; the publisher
marks individual messages.

### 1. Declare the queue with `maxPriority`

```typescript
import { RunnableService, Config } from 'protobus';

class RecommendationsService extends RunnableService {
    constructor(context: IContext) {
        super(context, { maxPriority: Config.RECOMMENDED_MAX_PRIORITY }); // 2
    }
}
```

`maxPriority` becomes the queue's `x-max-priority` argument. It must be an
integer from 1 to 255; anything else throws `InvalidPriorityError` at
construction, before any broker I/O.

**Keep the number small.** RabbitMQ maintains internal structures per priority
level, so a large range costs memory and throughput and buys nothing.
`Config.RECOMMENDED_MAX_PRIORITY` is **2**, giving three levels, which is one
more than any known use needs:

| Constant | Value | For |
|---|---:|---|
| `Config.PRIORITY_NORMAL` | 0 | Bulk work. Also what an unset priority means. |
| `Config.PRIORITY_HIGH` | 1 | Spare rung. |
| `Config.PRIORITY_CONTROL` | 2 | Control messages that must not queue behind bulk. |

### 2. Publish with a `priority`

Proxy methods take an options object as their last argument:

```typescript
const recs = new ServiceProxy(context, 'Recommendations.Service');
await recs.init();

// Control message — overtakes the backlog.
await recs.processSingleRecommendation(
    { ruleKey }, actor, true, undefined, { priority: Config.PRIORITY_CONTROL },
);

// The fan-out this control message produces — ordinary bulk traffic.
await recs.processUserSingleRecommendation(
    { userId, ruleKey }, actor, false, undefined, { priority: Config.PRIORITY_NORMAL },
);
```

The signature is `(request, actor?, rpc?, timeoutMs?, options?)`. `options` is
appended last, so every existing call is unchanged.

`priority` must be an integer from 0 to 255 or `InvalidPriorityError` is thrown.
Protobus validates it rather than passing it straight to the driver because
amqplib encodes the priority in a single byte and **silently truncates** a
non-integer: `1.5` reaches the broker as `1`, with no error anywhere.

A priority above the queue's `x-max-priority` is not an error and not useful:
the broker clamps it **for ordering** while preserving the property as sent. On
an `x-max-priority: 2` queue, a message published at 5 sorts as a 2 — so it goes
behind an earlier 2 rather than ahead of it — and still reads back as 5.

### Scope

Priority applies to the **RPC request path**: unary calls and fire-and-forget
publishes. It is deliberately not plumbed through events or streaming calls;
neither has a demonstrated need, and every surface added here has to stay
identical to [protobus-py](https://github.com/ArielLaub/protobus-py) forever.

## What priority does not do

**Priority reorders messages that are still in the queue. It cannot reach a
message the broker has already handed to a consumer.**

Each consumer holds up to `maxConcurrent` unacknowledged messages (its
prefetch). Those are already out of the queue and will be worked through
regardless of what arrives later. With prefetch `N` across `R` replicas, up to
`N × R` bulk messages can still sit ahead of a control message.

The integration test in `test/integration/message_priority.test.ts` is written
to show this rather than hide it: with prefetch 1, a control message published
*after* 20 bulk messages is handled **second**, not first. The one ahead of it
is the one already in the consumer's hands.

So the honest claim is a change of scale, not a guarantee:

| | Bulk messages ahead of a control message |
|---|---|
| Without priority | the whole backlog — thousands |
| With priority | at most `maxConcurrent × replicas` — typically single digits |

If you need a hard bound rather than a large improvement, priority is not the
mechanism; lowering prefetch tightens it further, at a throughput cost.

Two more limits worth knowing:

- **Priority is per queue, not global.** It orders one service's own queue and
  says nothing about how the broker schedules between services.
- **A starved low-priority message is never delivered.** If high-priority
  traffic never stops, the bulk backlog never drains. This is fine for control
  traffic, which is rare by definition, and a hazard if you promote a whole
  traffic class.

## Backward compatibility

The four guarantees below are each pinned by a test.

**1. Opt-in only.** With `maxPriority` unset, `x-max-priority` is absent from
the queue arguments entirely — not present-and-undefined. A service that does
not ask for priority declares `{}` (or `{'x-message-ttl': …}`), byte-identical
to the version before this feature existed, so its existing queue redeclares
cleanly on upgrade.

**2. A `priority` sent to a non-priority queue is ignored, not rejected.**
Verified against RabbitMQ 3: the message is delivered in FIFO order, the
`priority` property is preserved on it, and no channel error occurs. This is
what lets an upgraded publisher run against a consumer that has not been
upgraded yet.

**3. Both directions interoperate.** New publisher → old consumer is guarantee 2.
Old publisher → new consumer works because an unset priority is treated by
RabbitMQ as 0, which is exactly `PRIORITY_NORMAL`.

**4. No signature changed.** `maxPriority` is a new optional field on
`IMessageServiceOptions`; `options` is a new trailing argument on proxy methods
and on `publishMessage`. Every existing call compiles and behaves identically.

The retry queue and the DLQ are deliberately left alone. Dead-lettering
preserves a message's priority property, so a retried message re-sorts correctly
when it lands back in the main priority queue without `<Service>.Retry` needing
priority of its own — which also makes enabling this a **one**-queue migration
rather than a three-queue one.

## ⚠️ Enabling priority on a queue that already exists

**This is the one thing that is not backward compatible, and it cannot be made
so.** RabbitMQ fixes a queue's arguments when the queue is declared. Adding
`x-max-priority` to a queue that already exists without it is rejected:

```
Operation failed: QueueDeclare; 406 (PRECONDITION-FAILED) with message
"PRECONDITION_FAILED - inequivalent arg 'x-max-priority' for queue
'MyService' in vhost '/': received the value '2' of type 'byte' but current is none"
```

A 406 closes the channel. **Protobus shares one connection across every listener
in a process**, so this is not a single failed declare — it is a service that
does not start, and if it happens on a reconnection, a listener that goes
permanently silent behind a connection still reporting itself healthy.

So enabling `maxPriority` on a service that has already run against a broker
requires a one-time, operator-driven **drain, delete and recreate** of that
service's main queue. Follow **Procedure A** in
[Queue Migration](./queue-migration.md) — the same procedure as for a changed
`messageTtlMs`, applied to `<ServiceName>` only (not `.Retry`, not `.DLQ`).

Deploying the new code before the queue is deleted fails loudly on startup with
the 406 above. That is the intended behaviour: a service refusing to start is
better than one that starts and quietly ignores the priorities you configured.

For a new service, declare `maxPriority` from the first deploy and none of this
applies.

## Cross-language

`maxPriority` / `priority` behave identically in
[protobus-py](https://github.com/ArielLaub/protobus-py) (`max_priority`,
`priority`), including the validation ranges (1-255 and 0-255, integers only,
booleans rejected). Verified against a live broker, both ports running at once:
a TypeScript publisher's `priority` is honoured by a Python consumer's
`max_priority` queue, and a TypeScript service redeclares a Python-created
priority queue without a 406 — the two emit the same queue arguments, which is
the one disagreement that would take a channel down.

**One byte-level difference, pre-dating this feature and deliberately left
alone:** protobus-py always puts `priority: 0` on a message with no priority,
because aio-pika normalizes an unset priority to 0; this port omits the property
entirely. RabbitMQ cannot distinguish absent from 0 — on a priority queue the
two sort as equals and keep their relative publish order — so the wire bytes
differ and the behaviour does not. Do not "fix" either side to match the other.
