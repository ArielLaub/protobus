# Message Priority

A service has **one** request queue. Protobus binds it to `REQUEST.<ServiceName>.*`,
so every method of a service shares that queue and RabbitMQ delivers them FIFO.

That is usually what you want, and occasionally ruinous. The case this feature
exists for: a service whose "start the job" RPC fans out one message per user
onto its own queue. The fan-out is thousands of messages long, and the *next*
control message — a second start, a cancel, a status request — lands behind all
of them and breaches its deadline while every replica is healthy and busy.

The shape it was diagnosed in: three control calls issued during one 5,232-
message drain, all three accepted by the broker, all three timed out at their
deadline, both replicas connected and consuming the whole time. Nothing was
broken. The queue was simply one lane, and the lane was full.

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

**`maxPriority` requires `lateAck`, which is the default.** Passing
`lateAck: false` alongside it throws. Priority reorders what is still in the
*queue*, and RabbitMQ applies no QoS prefetch to an auto-ack consumer — so an
early-ack consumer is handed the entire backlog and there is nothing left to
reorder. This is refused rather than warned about because the failure is
invisible: the queue is correctly declared, the operator has already done the
one-time migration to enable it, and the feature simply does nothing.

**Keep the number small.** RabbitMQ maintains internal structures per priority
level, so a large range costs memory and throughput and buys nothing.
`Config.RECOMMENDED_MAX_PRIORITY` is **2**, giving three levels, which is one
more than any known use needs:

| Constant | Value | For |
|---|---:|---|
| `Config.PRIORITY_NORMAL` | 0 | Bulk work. Also what an unset priority means. |
| `Config.PRIORITY_HIGH` | 1 | Spare rung. |
| `Config.PRIORITY_CONTROL` | 2 | Control messages that must not queue behind bulk. |

#### Why three levels, and why named

The set is deliberately small and deliberately fixed. Four reasons, in the
order they carry weight:

- **A priority level is not free.** RabbitMQ builds internal data structures per
  level, so `x-max-priority: 10` costs memory and throughput for seven levels
  nobody publishes to. [RabbitMQ's own
  documentation](https://www.rabbitmq.com/docs/priority) recommends keeping the
  number small for exactly this reason.
- **Three covers the distinction that actually exists.** Bulk work, elevated,
  control. `PRIORITY_HIGH` is already a spare rung, kept because leaving a gap
  is cheaper than a migration later.
- **A named constant documents itself at the call site.** `priority: 2` in a
  publish tells a reader nothing; `priority: Config.PRIORITY_CONTROL` tells them
  why the call is there. Values are integers on the wire, but callers should not
  be writing integers.
- **A fixed set keeps the two ports identical.** TypeScript and
  [protobus-py](https://github.com/ArielLaub/protobus-py) services talk to each
  other over the same queues, so the levels have to mean the same thing in both;
  a per-project priority vocabulary is a per-project disagreement waiting to
  happen.

Underneath all four: priority is a coarse instrument. It only reorders what is
still **in the queue** (see [What priority does not
do](#what-priority-does-not-do)), so a wide range invites callers to encode a
fine-grained scheduling policy into a mechanism that cannot honour it. Two
neighbouring levels rarely produce two distinguishable outcomes.

### 2. Publish with a `priority`

Unary and fire-and-forget proxy methods take an options object as their last
argument. (Streaming methods take `StreamOptions` in that position instead and
cannot carry a priority — see [Scope](#scope).)

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
is the one already in the consumer's hands. That test counts messages;
`message_priority_latency.test.ts` times them, which turns out to matter — see
[The count is not the wait](#the-count-is-not-the-wait).

So the honest claim is a change of scale, not a guarantee:

| | Bulk messages ahead of a control message |
|---|---|
| Without priority | the whole backlog — thousands |
| With priority | at most `maxConcurrent × replicas` — typically single digits |

If you need a hard bound on that *count* rather than a large improvement,
priority is not the mechanism. But the count is rarely what you actually care
about — see [The count is not the wait](#the-count-is-not-the-wait) below.

When the consumer is saturated the bound above is not merely an upper limit —
it is an equality. Measured, one replica, a 50-message backlog, only the
prefetch varying, with every prefetched delivery held in its handler:

| `maxConcurrent` | Control message handled at |
|---:|---|
| 1 | index **1** |
| 5 | index **5** |
| 20 | index **20** |

The control message emerges at *exactly* the prefetch. Independently reproduced
in protobus-py, which measured the same equality at `max_concurrent` 1, 5 and
20.

**The equality holds while the consumer is saturated** — that is, while all
`maxConcurrent` slots are genuinely occupied by in-flight handlers. That is the
case this feature exists for: a slow handler with work queueing up behind it. If
handlers instead finish faster than messages arrive, slots keep freeing and the
consumer simply drains the backlog; the control message can then be handled much
later than `maxConcurrent` (measured: index 49 of 51 at a prefetch of 5) because
the queue it would have jumped was already consumed while it was in flight. That
case is not a problem — a backlog that drains in milliseconds is not a backlog —
but it does mean a benchmark with a fast handler measures something other than
this limit.

### The count is not the wait

The obvious reading of that table is that a large `maxConcurrent` erodes the
benefit: twenty messages ahead of you must mean twenty task durations of
waiting. That reading is wrong, and it is worth being exact about why, because
it leads to precisely the wrong tuning decision.

**Those prefetched messages are being worked concurrently.** They are not
queued in front of the control message, they are running *beside each other*.
The control message waits for **one slot to free** — about one task duration —
whether that slot is one of three or one of thirty.

And the more slots there are, the more often one of them frees, so extra
parallelism can only shorten that wait — never lengthen it. Measured against a
live broker, one replica, a 30-message backlog of one-second handlers — the
[worked example](#a-worked-example) below:

| `maxConcurrent` | Control message at | Handled after | Whole batch |
|---:|---:|---:|---:|
| 3 | index 3 | **965 ms** | 9.1 s |
| 10 | index 10 | **967 ms** | 2.0 s |
| 3, no priority | index 30 | **9,993 ms** | 10.0 s |

The index tripled with the prefetch. The wait moved by two milliseconds, which
is noise — and two milliseconds is the *floor*, not a coincidence: in a flood
every slot starts at once and so frees at once, one task duration later. In
steady state, with completions staggered across the slots, a slot frees more
often than that and the control message is picked up sooner still.

So `maxConcurrent` is the width of the window priority cannot see into measured
*in messages* — and that width costs no time. Tune it for throughput; it is not
a priority knob, and turning it down to "tighten" the bound buys a smaller
number and a slower service.

**Where priority genuinely does nothing is the other end**: a prefetch large
enough that the entire backlog has already been dispatched. Nothing is left in
the queue, so there is nothing to reorder and the control message is handled in
publish order like everything else. protobus-py measured this directly —
`max_concurrent=100` against a 50-message backlog put the control message at
index 50, priority fully inert. The condition is not "a large prefetch", it is
"a prefetch that is large relative to the backlog", and a backlog smaller than
the prefetch is by definition not the problem this feature solves.

Two more limits worth knowing:

- **Priority is per queue, not global.** It orders one service's own queue and
  says nothing about how the broker schedules between services.
- **A starved low-priority message is never delivered.** If high-priority
  traffic never stops, the bulk backlog never drains. This is fine for control
  traffic, which is rare by definition, and a hazard if you promote a whole
  traffic class.

## A worked example

The numbers above come from `test/integration/message_priority_latency.test.ts`,
which is written to be read as the example for this page. Run it with a broker
up:

```bash
docker compose up -d --wait
npx jest --config jest.integration.config.js test/integration/message_priority_latency.test.ts
```

The service is the shape the feature exists for: one expensive method that
fills the queue and one cheap one that has to get through anyway, sharing the
single queue a protobus service has.

```typescript
class WorkService extends MessageService {
    constructor(context: IContext, prefetch: number, maxPriority?: number) {
        super(context, { maxConcurrent: prefetch, maxPriority });
    }

    /** The bulk work: a second of it, per message. */
    public async slow(request: any): Promise<any> {
        await sleep(1000);
        return { tag: request.tag };
    }

    /** The control call: cheap, and latency-sensitive. */
    public async fast(request: any): Promise<any> {
        return { tag: request.tag };
    }
}
```

Flood the slow method, wait until every prefetch slot is genuinely busy — the
test asserts this rather than assuming it, because an unsaturated consumer just
drains the backlog and the run measures nothing — then send the control call:

```typescript
for (let i = 0; i < 30; i++) {
    await proxy.slow(
        { tag: `bulk-${i}` }, undefined, false, undefined,
        { priority: Config.PRIORITY_NORMAL },
    );
}
// ... 30 seconds of work, three slots, all three busy ...

await proxy.fast(
    { tag: 'CONTROL' }, undefined, false, undefined,
    { priority: Config.PRIORITY_CONTROL },
);
```

Measured against RabbitMQ 3, one replica:

```
prefetch 3, priority:     control handled after   965ms, at index  3 of 31; whole batch  9055ms
prefetch 10, priority:    control handled after   967ms, at index 10 of 31; whole batch  2031ms
prefetch 3, no priority:  control handled after  9993ms, at index 30 of 31; whole batch 10040ms
```

Which is the whole feature in three lines: **about a second**, because that is
how long it takes for one of the parallel slots to free, against ten seconds of
waiting for the batch to finish. Tripling the prefetch tripled the index and
left the wait alone.

The third line is also the mutation check — the identical scenario with the
priority taken off the call — and it is a real test, not a snippet: dropping
`{ priority: Config.PRIORITY_CONTROL }` from the first case takes it from 965 ms
to 9,999 ms and fails its assertion, and so does leaving the priority on the
call while dropping `maxPriority` from the queue. Both halves are load-bearing.

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

The retry queue and the DLQ are deliberately left without `x-max-priority` of
their own, which keeps enabling this a **one**-queue migration rather than a
three-queue one. A retried message re-sorts correctly when it lands back in the
main priority queue, and it gets there with its priority intact for two separate
reasons that both had to be checked:

- The broker's dead-letter hop (retry queue → TTL expiry → DLX → main exchange)
  preserves the `priority` property. Verified against RabbitMQ 3.
- Protobus's own re-publish onto the retry exchange **copies `priority`
  explicitly**. This one is not free: protobus does not let the broker move a
  failed message, it re-publishes it and builds a fresh properties object by
  hand, so anything not copied is dropped. Without it, a control message that
  failed once would come back at priority 0 and queue behind the entire bulk
  backlog — the exact failure this feature exists to prevent, reachable only
  after something else has already gone wrong. The DLQ hop carries it too.

The general rule, and the one to remember when touching this code: **anywhere
protobus re-publishes rather than letting the broker move a message, priority
has to be carried by hand.**

## ⚠️ Enabling priority on a queue that already exists

**This is the one thing that is not backward compatible, and it cannot be made
so.** RabbitMQ fixes a queue's arguments when the queue is declared. Adding
`x-max-priority` to a queue that already exists without it is rejected:

```
Operation failed: QueueDeclare; 406 (PRECONDITION-FAILED) with message
"PRECONDITION_FAILED - inequivalent arg 'x-max-priority' for queue
'MyService' in vhost '/': received the value '2' of type 'byte' but current is none"
```

A 406 kills the channel the declare was issued on. Each listener opens its own
channel, so this is not a process-wide channel outage — but `init()` rejects and
**the service does not start**. Hitting it on a *reconnection* is no quieter:
the failed restore propagates to the connection, which discards that generation,
reports itself disconnected and retries, then gives up through its reconnection
budget. Either way it is loud. What it is not is recoverable without the
migration below.

So enabling `maxPriority` on a service that has already run against a broker
requires a one-time, operator-driven **drain, delete and recreate** of that
service's main queue. Follow **Procedure A** in
[Queue Migration](../operations/queue-migration.md) — the same procedure as for a changed
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

Verified in **both** directions against a live broker with both ports running:

| Direction | Result |
|---|---|
| TS publisher → Python consumer (`max_priority=2`) | control message handled 2nd of 21 |
| Python publisher → TS consumer (`maxPriority: 2`) | control message handled 2nd of 21 |

### Where the two ports deliberately differ

Same observable behaviour, different internals. None of these is a bug in
either port, and none should be "fixed" to match the other.

**1. An unset priority on the wire.** protobus-py always puts `priority: 0` on a
message with no priority, because aio-pika normalizes it; this port omits the
property entirely. RabbitMQ cannot distinguish absent from 0 — on a priority
queue the two sort as equals and keep their relative publish order — so the
bytes differ and the behaviour does not. This pre-dates the feature in both
ports.

**2. An explicit `priority: 0`.** protobus-py folds it to "not asked for" and
does not forward it; this port sends it. In Python the two paths emit
*identical* bytes anyway, so folding is free there, and it avoids passing an
unexpected keyword to a third-party `IContext` implementation written before the
parameter existed. TypeScript has no equivalent compatibility pressure and the
bytes genuinely differ, so this port stays faithful to what the caller passed.
Different constraints, same result at the broker.

**3. What each port refuses.** Both reject a configuration in which priority
would be silently inert, but they have to reject different things because their
defaults differ. This port defaults to a bounded prefetch (`maxConcurrent || 1`,
falling back to a positive config default), so `maxPriority` on its own is
already safe and only `lateAck: false` is a hole — that is what it rejects.
protobus-py has no default prefetch at all, so an unset `max_concurrent` means
no QoS whatsoever, and it rejects both that and the auto-ack case. It
deliberately did not adopt a default prefetch to match, since that would change
delivery behaviour for every existing Python listener, not just priority-enabled
ones.
