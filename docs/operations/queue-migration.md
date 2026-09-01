# Changing Queue Settings on a Running System

RabbitMQ fixes a queue's arguments when the queue is declared. Redeclaring an
existing durable queue with different arguments does not update it — the broker
rejects the declare with `PRECONDITION_FAILED` and closes the channel.

This matters for three Protobus options, each of which becomes a queue argument:

| Option | Queue argument | Queue it applies to |
|--------|----------------|---------------------|
| `retryDelayMs` | `x-message-ttl` | `<ServiceName>.Retry` |
| `messageTtlMs` | `x-message-ttl` | the service's main queue |
| `maxPriority` | `x-max-priority` | the service's main queue |

Change any of them for a service that has already run against a broker, and the
next startup fails. Protobus turns the retry-queue case into a
`RetryQueueMismatchError` naming the queue and the current value; the main-queue
cases surface as the broker's raw `PRECONDITION_FAILED`.

`maxPriority` is the one most likely to be *added* to a service that is already
running, since the whole point is to fix a queue that is misbehaving in
production. Turning it on is Procedure A below applied to `<ServiceName>` alone
— `.Retry` and `.DLQ` do not carry `x-max-priority` and must not be deleted.
See [Message Priority](../guide/priority.md) for why.

Queue names are derived from the service name and stay stable across
deployments. That is deliberate: silently deriving a new name from the settings
would leave the old queue bound and accumulating messages that nothing consumes.
Migrating is an operational step, and one of the two procedures below.

## Procedure A: drain and delete (same queue name)

Use this when the queue name must stay the same — for example when other tooling,
dashboards or alerts reference it.

1. **Stop the producers**, or accept that messages published during the window
   are dropped. Nothing is bound to the queue while it does not exist.
2. **Stop every consumer instance** of the service. As long as one instance
   holds the old queue, deleting it discards messages it is still working on.
3. **Wait for the queue to drain.** Watch it reach zero messages:

   ```bash
   rabbitmqctl list_queues name messages consumers | grep '^MyService'
   ```

   For a retry queue, "drained" also means waiting out the old `x-message-ttl`,
   since parked messages only leave when their TTL expires.
4. **Delete the queue.** `--if-empty` is the safety catch — it refuses rather
   than silently discarding anything that arrived late:

   ```bash
   rabbitmqctl delete_queue MyService.Retry --if-empty
   ```

   Deleting the main queue also means deleting `MyService.Retry` and
   `MyService.DLQ` if their arguments changed too. Inspect the DLQ before
   deleting it; anything sitting there has already exhausted its retries and is
   gone for good once the queue is.
5. **Deploy the new configuration.** The service redeclares the queue with the
   new arguments on startup and rebinds it.
6. **Restart the producers.**

The cost of this procedure is a window with no queue: messages published between
step 4 and step 5 are unroutable and dropped.

## Procedure B: new queue name (no downtime)

Use this when messages must not be lost. Give the service a new name so it
declares a fresh queue alongside the existing one, then retire the old one.

1. **Deploy the new service name** with the new retry/TTL settings. Both the old
   and new queues are now bound to the bus exchange and both sets of consumers
   run.
2. **Cut producers over** to the new service name. Callers address services by
   name, so this is a client-side change.
3. **Let the old queue drain**, including anything parked in its retry queue.
4. **Stop the old consumers and delete the old queues** (`<Old>`, `<Old>.Retry`,
   `<Old>.DLQ`, and the `<Old>.Retry.Exchange` exchange).

This costs a period of double capacity and a client-visible rename, and buys a
migration with no unroutable window.

## Avoiding the problem

- Treat `retryDelayMs`, `messageTtlMs` and `maxPriority` as deployment-time
  constants. Pick them before the first production deploy — for a brand-new
  service, declaring `maxPriority` up front costs nothing and saves the
  migration entirely.
- Drive them from configuration that is reviewed alongside the code, not from an
  environment variable that differs per environment — a value that varies
  between staging and production means one of the two brokers will reject the
  declare after a promotion.
- Keep them out of per-instance overrides. Two instances of the same service
  with different values race: whichever declares first wins, and the other
  crashes on startup.

## Recognising the failure

```
Error: retry queue 'MyService.Retry' already exists with different arguments
(most likely a different retryDelayMs — now 3000ms). RabbitMQ cannot change a
queue's x-message-ttl in place: drain and delete the queue, or keep the original
retryDelayMs.
```

A bare `PRECONDITION_FAILED - inequivalent arg 'x-message-ttl' for queue ...`
from the broker means the same thing for a main queue carrying `messageTtlMs`,
and `inequivalent arg 'x-max-priority' ... but current is none` means a service
has asked for `maxPriority` on a queue that was created without it.
Either way the service does not start: the fix is one of the procedures above,
or reverting the value to what the existing queue was declared with.
