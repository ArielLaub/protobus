# Changelog

All notable changes to **protobus** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] — 2026-09-01

Opt-in RabbitMQ message priority, so a control message can overtake bulk traffic
on a service's single request queue.

Protobus binds one queue per service to `REQUEST.<ServiceName>.*`, so every
method a service serves shares that queue and RabbitMQ delivers it FIFO. A
service whose "start the job" RPC fans out one message per user onto its own
queue therefore puts the *next* control message behind the entire fan-out: with
a 5,232-message backlog, three subsequent control calls were accepted and all
three failed at exactly their deadline while every replica was healthy. The
alternative fix — a second service to own a second queue — adds a deployment
unit to solve an ordering problem. Priority solves it on the queue that exists.

Added in lockstep with [protobus-py](https://github.com/ArielLaub/protobus-py);
the option names, validation ranges and constants are identical in both.

### Added

- **`maxPriority` on `IMessageServiceOptions`.** Declares the service's request
  queue with `x-max-priority`. An integer 1-255, validated at construction so a
  bad value fails before any broker I/O rather than as a 406 that closes the
  shared channel.
- **`priority` on the new `CallOptions`**, accepted as a trailing `options`
  argument by proxy methods, `Context.publishMessage()` and
  `MessageDispatcher.publish()`. An integer 0-255.
- **`Config.PRIORITY_NORMAL` (0), `PRIORITY_HIGH` (1), `PRIORITY_CONTROL` (2)
  and `RECOMMENDED_MAX_PRIORITY` (2)**, with `Config` itself now exported from
  the package root. The recommended range is deliberately tiny: RabbitMQ builds
  internal structures per priority level, so a large range costs memory and
  throughput and buys nothing.
- **`InvalidPriorityError`**, exported from the package root. Raised for a
  non-integer or out-of-range priority. amqplib encodes the priority in one byte
  and silently truncates — `1.5` reaches the broker as `1` with no error — so
  this is validated rather than delegated to the driver.

### Backward compatibility

Priority is **off unless asked for**, and each of these is pinned by a test:

- With `maxPriority` unset, `x-max-priority` is absent from the queue arguments
  entirely, not present-and-undefined. An existing service declares `{}` (or
  `{'x-message-ttl': …}`) exactly as before and its queue redeclares cleanly.
- With no `priority` given, no `priority` property is set on the message.
- A `priority` published to a non-priority queue is ignored by the broker, not
  rejected — verified against RabbitMQ 3, and what lets a new publisher run
  against an old consumer. The reverse direction works because an unset priority
  is 0, which is `PRIORITY_NORMAL`.
- No existing signature changed; `maxPriority` and `options` are additive.

The `<Service>.Retry` and `<Service>.DLQ` queues are deliberately untouched.
Dead-lettering preserves a message's priority property, so a retried message
re-sorts correctly on its way back into the main queue — which keeps enabling
this a one-queue migration rather than a three-queue one.

**⚠️ Enabling `maxPriority` on a service that has already run against a broker
requires an operator to drain and delete its main queue first.** RabbitMQ fixes
queue arguments at declare time; adding `x-max-priority` to an existing queue is
a 406 `PRECONDITION_FAILED` that closes the channel, and protobus shares one
connection across every listener in a process. The service fails loudly on
startup rather than silently ignoring the setting. See
[Message Priority](docs/advanced/priority.md) and Procedure A in
[Queue Migration](docs/advanced/queue-migration.md).

### Known limitation

Priority reorders messages **still in the queue**; it cannot reach one the
broker has already prefetched into a consumer. With prefetch `N` across `R`
replicas, up to `N × R` bulk messages can still sit ahead of a control message.
The integration test demonstrates this rather than hiding it: with prefetch 1, a
control message published after 20 bulk messages is handled second, not first.
This is a change of scale — thousands down to single digits — not a guarantee.

### Documentation

- New [Message Priority](docs/advanced/priority.md) guide: usage, the four
  backward-compatibility guarantees, the prefetch limitation stated plainly, and
  the migration procedure for an existing queue.
- [Queue Migration](docs/advanced/queue-migration.md) now covers three options
  rather than two, and notes that `maxPriority` is the one most likely to be
  added to a service already in production.
- `maxPriority` documented on [MessageService](docs/api/message-service.md); the
  [ServiceProxy](docs/api/service-proxy.md) method signature now documents all
  five parameters, `rpc` and `timeoutMs` included, which were undocumented.

## [2.1.0] — 2026-08-22

A second security and performance audit, and its remediation. Two independent
reviews of 2.0.0 were run and reconciled; every finding below was reproduced
with a failing test before it was fixed, and the tests are in the suite.

**Versioning.** Five of these changes are breaking under a strict reading of
semver, and are marked as such below. This is a minor release because 2.0.0 has
no adopters — the upgrade path is 1.4.1 → 2.1.0, and **Breaking changes** is
the migration list for it.

### Fixed — security

- **A `bigint` field wider than its wire format is rejected instead of
  decoded.** `BigIntType.decode()` accumulated with one bigint shift per byte,
  making it quadratic in the input length while the encoder only ever produces
  32 bytes. Decoding runs inside `decodeRequest()`, ahead of the routing-key
  check and any handler, so a peer holding nothing more than the ordinary right
  to call a service could stall the whole process with a single message: 256
  KiB blocked the event loop for 5.4 seconds, 1 MiB for 84. **Breaking:** a
  bigint carrying more than 32 bytes now raises `RangeError`. Nothing this
  library encodes can produce one.
- **Request dispatch is bound to the service's own contract.** The handler was
  chosen with `this[lastSegment(request.method)]` while the schema was resolved
  positionally from the same name. The two disagreed, and neither was checked
  against the methods the service declares, so a publisher could append a
  segment to reach an inherited framework member, name another loaded service's
  method to have its payload parsed under a foreign schema, or reach a
  framework member through a declared-but-unimplemented rpc. The envelope is
  now validated before the payload is interpreted, and dispatch resolves only
  against what the subclass itself implements. **Breaking:** a body method that
  is not a declared method of the receiving contract is answered with
  `InvalidMethodError` rather than dispatched.

### Fixed — delivery contract

- **`ServiceProxy` raises delivery errors as they stand.** Every failure was
  replaced with a generic `PublishMessageError`, discarding the distinction the
  publish path exists to report — `UnroutableError` and `PublishNackedError`
  are definite and safe to retry, `PublishConfirmTimeoutError` and
  `ChannelClosedError` are ambiguous and retrying either can duplicate. The
  catch covered the reply wait too, so `RpcTimeoutError` and
  `DisconnectedError` went the same way, along with the `messageId` that makes
  deduplication possible. Since `ServiceProxy` is the API most callers use, the
  typed errors and the retry guidance in `docs/advanced/security.md` were both
  unreachable in practice. **Breaking:** match on `PublishError` or a specific
  subclass instead of `PublishMessageError`.
- **`messageId` survives retry and DLQ hops.** 2.0.0 told consumers to
  deduplicate on it, but the retry and DLQ publishes passed none, so a fresh
  UUID was minted at every hop — absent from precisely the path that produces
  the duplicates it was meant to resolve. It is also now on
  `MessageHandlerContext`, alongside `redelivered`, so a handler can read it.

### Fixed — resource lifetime

- **A streaming call has one deadline that owns its cleanup.** The pending
  entry was created by `publishStreaming()` but the idle timer was only armed
  inside `next()`, so a call that was never iterated held its entry and
  everything the server sent into it for the life of the process. The abort
  listener was attached with `once` and never removed, so a signal reused
  across calls — a per-session `AbortController` — accumulated one listener per
  completed call, each keeping its buffer reachable. And the idle path cleared
  local state without sending a cancel, unlike `return()` and `throw()`,
  leaving the producer generating for a caller that had stopped listening. A
  signal already aborted when the call is made now publishes nothing at all.
- **`STREAM_MAX_TOTAL_BUFFERED_BYTES`** (default 256 MiB) bounds buffered bytes
  across all streaming calls on a dispatcher. The per-call limit said nothing
  about a process holding many at once, where five streams inside their own
  limits are 320 MiB into the heap.

### Fixed — reliability

- **Reconnection announces itself only once the topology is back.**
  `reconnected` fired the moment the socket returned while every component
  restored itself in an async listener nobody awaited, so `isConnected` read
  true with channels gone and queues neither re-declared nor re-bound. A
  restore that failed reported through an `error` event with no subscriber,
  producing an unhandled rejection and a half-restored listener beside a
  connection that believed it was fine. Components now register a `Restorer`;
  the connection runs them in order and announces itself only once they all
  resolve, and discards a generation it cannot restore. **Breaking:**
  `reconnected` now fires after restoration, and a publish issued during a
  reconnection waits for it — bounded by `CONNECTION_READY_TIMEOUT_MS` — rather
  than throwing `NotConnectedError`, and may reject with `NotReadyError`.
- **An AMQP heartbeat is set rather than left to the broker.** `connect()`
  passed no options, so the interval was whatever RabbitMQ proposed — 60
  seconds, and amqplib closes after two missed ones, putting worst-case
  detection of a peer that vanished without closing its socket at about two
  minutes. **Breaking:** connections negotiate a 30-second heartbeat unless the
  URL already carries one; `?heartbeat=0` opts out.
- **The event router keeps every pattern registered on it.** A trie node held a
  single value that was never overwritten, so a second subscriber to the same
  topic was silently discarded; the same slot was written along the whole path,
  so "is this a registered pattern" was approximated as "has no children" —
  meaning subscribing to `EVENT.Order.Shipped` silently stopped `EVENT.Order`
  matching anything. Both were silent, with the binding still in place and the
  broker still delivering.

- **A drain waits for handlers, not just deliveries.** The processing timeout
  settles a delivery while leaving its handler running, because JavaScript
  cannot preempt one. Shutdown therefore reported "in-flight messages drained"
  and went on to run the cleanup hook and close the connection while user code
  was still mid-transaction against the resources being torn down.
- **`stopConsuming()` survives a reconnection.** It cleared the consumer tag
  but not the started flag, so a reconnection landing mid-drain restored the
  consumer and the shutdown began taking new work again.
- **A message that cannot be understood is answered, not retried.**
  `decodeRequest()` ran outside any try, so an undecodable body threw, was
  classified as infrastructure failure, and went through three redeliveries and
  a DLQ publish — five broker operations and a DLQ entry for bytes that fail
  identically every time, while the caller waited out its RPC timeout. New
  `ProtocolError` (a `HandledError`) is raised instead and answered
  immediately; `InvalidMethodError` is now one too.

### Fixed — correctness

- **Fully-qualified method names are parsed from the right.** The service was
  taken from the first two dot-separated segments, which assumes a
  single-segment package: `package com.example.billing` made every call resolve
  the service as `com.example`. Leaving the trailing segments unexamined is
  also what let a name carry extra ones unnoticed.
- **Timestamps before 1970 round-trip.** The `Long` high word was read as
  unsigned, so every pre-epoch instant reconstructed far enough out of range to
  produce an `Invalid Date`, which then propagated silently into application
  data.
- **`buildResponse()` no longer resolves the method when encoding an error.**
  The lookup was unnecessary on that path — the method is only a label — and it
  made a failure that is *about* an unknown method impossible to report,
  leaving the caller to wait out its full RPC timeout.
- **A channel teardown no longer drives the outstanding-confirm counter
  negative.** Closing zeroed it while each publish still ran its own
  decrement, leaving the count negative by however many were in flight and the
  bound ineffective afterwards.
- **A stale `basic.return` cannot fail a later publish.** A return arriving
  after its own publish gave up stayed in the returned set forever and was then
  read as the verdict on the next publish reusing that `messageId` — which
  carrying a stable id across retries makes routine rather than rare.
- **A confirmed publish waiting on a full write buffer is not reported as
  unconfirmed.** The confirm deadline kept running through the drain wait, so a
  publish the broker demonstrably accepted could surface as
  `PublishConfirmTimeoutError` — an ambiguous outcome, inviting the retry that
  duplicates it.

### Added

- `AMQP_HEARTBEAT_SECONDS` (default 30), `CONNECTION_READY_TIMEOUT_MS`
  (default 30000) and `STREAM_MAX_TOTAL_BUFFERED_BYTES` (default 256 MiB).
- `ProtocolError`, exported from the package root, along with
  `InternalServiceError` and `StreamSequenceError` — the latter thrown since
  streaming shipped but never reachable for an `instanceof` check.
- `NotReadyError`, and the `Restorer` hook a custom `IConnection` implements to
  take part in restoration. `registerRestorer`, `isReady` and `whenReady()` are
  optional on `IConnection`, as `cancelStream()` already was, so an
  implementation predating them still satisfies the interface and falls back to
  the event.
- `messageId` and `redelivered` on `MessageHandlerContext`.
- `MessageFactory.splitMethodName()`, `getServiceMethodNames()`,
  `decodeRequestEnvelope()` and `decodeRequestPayload()`.

### Documentation and tooling

- The environment-variable reference listed 4 of the 21 settings actually read.
  All of them are now documented, grouped, with the distinction between the
  server-side `MESSAGE_PROCESSING_TIMEOUT` and the caller-side
  `RPC_CALL_TIMEOUT_MS` spelled out — both default to 10 minutes, but a server
  can keep retrying a request for roughly 40 while its caller has long given up.
- `maxConcurrent` was documented in four places as an overridable getter
  defaulting to "unlimited". It is a constructor option, it defaults to 1, and
  unlimited is not available. The streaming implication is called out, and the
  token-stream sample no longer ships on the default.
- `registerType()` is documented as process-wide, which it has always been:
  the codec goes into protobufjs's module-level wrapper table, shared by
  everything in the process.
- `known-issues.md` still described graceful shutdown as missing, two releases
  after it shipped. The streaming notes still claimed no chunk deduplication.
- `npm run test:integration` reported the exit status of `docker compose down`,
  so a failing suite exited 0.
- The publishing job no longer fetches an unpinned `npx semver` while holding
  the OIDC identity — the one thing that workflow otherwise takes care never
  to do.

### Notes

- Review of this branch found one regression it had introduced and two latent
  faults, all fixed here: a socket dropping *during* reconnection could fork
  into two live connections, because the re-entrancy guard was stood down when
  the socket came up rather than when restoration finished — leaving the loser
  orphaned open with live consumers on it, and announcing `reconnected` twice.
  A non-async handler throwing synchronously leaked the new handler count, so
  every later drain waited out its full timeout. And a listener stayed
  available for restoration between `stopConsuming()` and `close()` — the fix
  for which then had to be made symmetric, since `stopConsuming()` followed by
  `start()` is legal and left the listener out of restoration for good.
- An aborted stream ends its loop rather than raising, matching `break`. That
  is deliberate, and now documented along with how to tell an early stop from a
  clean finish.
- 293 unit tests and 48 integration tests, from 213 and 46. The two new
  integration tests exercise recovery against a real broker: the connection is
  severed from the broker side, and the reconnection is verified to be
  announced only once the topology is back, with a publish issued mid-outage
  completing rather than failing.
- CI publishes the RabbitMQ management port, which the recovery test needs to
  produce a disconnect the client actually observes. Stopping the container is
  not usable for this: Docker's port forwarder keeps the port accepting behind
  a dead container, so the client socket never breaks.

## [2.0.0] — 2026-08-11

Remediation of the 2026-08-11 security and stability audit. The theme is making
each asynchronous boundary **truthful**: a publish completes on a broker
confirm, routing failures are observable, and acknowledgements happen only
after a durable handoff.

**Upgrading from 1.4.1.** Versions 1.4.2 and 1.5.0 were never published to npm;
their fixes are included here, so the real upgrade path is 1.4.1 → 2.0.0.

This is a major release because the delivery contract changed. Most source-level
APIs are unchanged, but four things are genuinely breaking — protobufjs 8, proto3
zero values decoding as `0` rather than `undefined`, the new cancellation
exchange, and Node >= 20. Read **Breaking changes** and **Changed behaviour**
before upgrading; the proto3 one can alter which branch your code takes without
raising an error.

### Changed behaviour — delivery semantics

- **`publish()` now resolves on a broker confirm, not a local buffer write.**
  Channels are opened with `createConfirmChannel()`. Previously `await
  publish(...)` resolved as soon as amqplib accepted the bytes into its own
  write buffer, so it could report success for a message RabbitMQ never
  received. A resolved publish now means the broker confirmed it, routing
  succeeded where `mandatory` was requested, and the write buffer drained.
- **Publishes take a broker round-trip.** Anything that assumed `publish()`
  returned before the message could be delivered is now racy — that was an
  artifact of unconfirmed publishing, never a guarantee.
- **RPC requests are published `mandatory`.** A request that routes nowhere
  (no service bound to the key) now fails immediately with `UnroutableError`
  instead of waiting out the full RPC timeout. Events are deliberately *not*
  mandatory: an event with no subscribers is normal.
- **The reply is published before the request is acknowledged.** The previous
  order acked first, so a crash in between lost the response with the request
  already settled and unable to be redelivered.
- **Retry and DLQ handoffs are confirmed before the original is acked.** These
  bypassed the publish path entirely via `channel.sendToQueue`, so the only
  remaining copy of a failing message could be dropped.

### Added

- `PublishError` and subclasses `PublishNackedError`, `UnroutableError`,
  `PublishConfirmTimeoutError`, `ChannelClosedError`, all exported from the
  package root. **`PublishConfirmTimeoutError` and `ChannelClosedError` are
  ambiguous outcomes** — the broker may or may not have stored the message — so
  retrying either can duplicate. Every publish carries a stable `messageId`
  (preserved if the caller supplies one) for consumers to deduplicate on.
- `PUBLISH_CONFIRM_TIMEOUT_MS` (default 30000) and `MAX_OUTSTANDING_CONFIRMS`
  (default 256) bound how long a confirm is awaited and how much unconfirmed
  work may be in flight per channel.
- `STREAM_MAX_BUFFERED_CHUNKS` (default 1024) and `STREAM_MAX_BUFFERED_BYTES`
  (default 64 MiB) bound a streaming call's buffer. `StreamBackpressureError`
  has been exported since streaming shipped but was previously unreachable.

### Added — stream cancellation

- **A cancelled stream now stops the producer.** Breaking out of a `for await`
  sends a cancellation notice to the server, which aborts the handler's
  `AbortSignal` and stops publishing. A handler that watches its signal stops
  doing the work; one that ignores it runs to completion but talks to nobody.
- **`{ signal }` option on streaming calls.** `break` only acts once the next
  chunk arrives, which is no use when the decision is made elsewhere — a Stop
  button in another request handler, or a client that disconnected. An
  `AbortSignal` fires immediately and composes with an HTTP request's own
  signal. Appended as a trailing optional argument, so existing calls are
  unchanged.
- **Handlers receive the framework context as a 4th argument**, carrying
  `signal` and `routingKey`. Previously only the raw connection API exposed it,
  so cooperative cancellation was impossible from a `MessageService`.
- **Delivery is best effort.** The notice is published once and never retried;
  if it is lost the producer runs to completion, exactly as before. Callers who
  need certainty should re-cancel when chunks keep arriving — the framework
  does not choose that policy for you.
- Cancellation travels over a new **fanout** exchange (`proto.bus.cancel`) with
  one exclusive auto-deleting queue per process, so every replica hears it and
  the one holding the correlation ID acts. A routed queue would deliver to one
  replica at random. If broker permissions forbid declaring the exchange, the
  service warns and runs without cancellation rather than failing to start.
- `sample/tokenStream/` demonstrates it against a real broker: 15 tokens
  generated with a Stop button, 9 with `break`, 246 uncancelled.

### Fixed — data corruption

- **proto3 zero values decoded as `undefined`.** proto3 omits any scalar equal
  to its default from the wire, and decoding did not supply the default — so a
  legitimate `0`, `""` or `false` arrived as `undefined`, indistinguishable
  from a field nobody set. A turn index of `0`, a count of `0`, an empty
  string: all silently lost. Decoding now passes `defaults: true`.

  Callers that tested `=== undefined` to detect an absent scalar will now see
  the proto3 default instead. proto3 has no field presence for scalars, so that
  test could never have been reliable; use a wrapper type or `optional` if you
  need to distinguish unset from zero.

- **A schema could not be registered twice under different service names.**
  Registration was keyed on the service name, so several instances sharing one
  `.proto` under distinct runtime names (`Combat.Player.player1`, `…player2`)
  re-parsed it and hit a protobufjs duplicate-name error. Schemas loaded from a
  proto directory are now recognised too. Conflicting definitions are still an
  error; identical schema text is a no-op.

- **A redelivered message clobbered the in-flight bookkeeping of its own
  earlier attempt.** RabbitMQ can have the same message in flight twice, and
  per-delivery state was keyed by correlation ID alone, so one attempt's
  cleanup removed another's entry — leaving cancellation with nothing to find.
  Each attempt now holds its own handle; cancelling stops every attempt for
  that correlation ID.

- **Dispatch checks rejected services whose runtime name differs from the name
  in their `.proto`.** The method-vs-routing-key and service-ownership checks
  are now expressed against the routing key, so addressing many instances of
  one schema works. Both security properties are unchanged: a request must
  belong to this service, and the method in the body must be the method the
  routing key names.

### Fixed — graceful shutdown

- **Cleanup ran while consumers were still delivering.** The sequence is now:
  stop accepting new messages (cancelling consumers but keeping channels open),
  drain in-flight work, then run the user's `cleanup()` hook, then close. A
  request could previously arrive after the handler's database connection had
  been closed.
- **In-flight handlers were never awaited.** `Connection.inFlightDeliveries`
  and `drainInFlight(ms)` are new; shutdown waits up to
  `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 30000) and reports what it abandoned.
  Anything still running stays unacknowledged and is redelivered.
- **`process.exit()` truncated pending output.** Shutdown now sets
  `process.exitCode` and lets the event loop drain, with a bounded backstop
  (`SHUTDOWN_EXIT_GRACE_MS`, default 5000) that forces the exit if something
  else keeps the process alive.
- `MessageService.stopConsuming()` and `BaseListener.stopConsuming()` are new
  and public, for callers running their own shutdown sequence.

### Fixed — streaming

- **A lost chunk produced a silently truncated stream.** The server has always
  stamped `x-protobus-seq`; nothing read it. The client now validates the
  sequence, raising `StreamSequenceError` on a gap and dropping duplicates
  (broker redeliveries) rather than yielding them twice. A peer that sends no
  sequence header is unaffected, so 1.x servers keep working.

### Fixed — CLI

- `generate-types` used a fixed `.protobus-temp` directory and removed it with
  a recursive force delete, so concurrent runs clobbered each other and a
  pre-existing directory of that name was destroyed. It now uses `fs.mkdtemp`
  under the system temp directory.
- Reusable CLI functions threw `process.exit()` from inside library code,
  making them uncallable from a script or a test. They now throw; only the
  command wrapper exits.
- Service names from argv are validated (`assertSafeServiceName`) before being
  interpolated into paths. A name containing separators or `..` previously
  wrote outside the configured proto and services directories.

### Fixed — connection lifecycle

- **Concurrent `connect()` calls each opened a socket.** The slower one
  overwrote the handle, orphaning a live broker connection with no reference
  left to close it. Connects are now single-flight, shared with the reconnect
  timer so a manual connect racing an automatic retry cannot double up.
- **A manual `disconnect()` could be undone by an in-flight reconnect.**
  Clearing the reconnect timer cannot stop an attempt that has already fired,
  so a connection torn down deliberately came back up moments later. Teardown
  now bumps a generation token; a connect completing against a stale
  generation closes itself instead of installing.
- **The reconnection log always said "after 0 attempts".** A successful
  connect zeroes the counter, and the message read it afterwards. It now
  reports the real count however long the outage lasted.

### Fixed — information exposure

- **Message and event payloads were logged at `warn`, which is on by default.**
  The unhandled-message and unhandled-event handlers serialised whole bodies;
  `JSON.stringify` on a Buffer renders it as `{"type":"Buffer","data":[...]}`,
  so the payload reached the log as decimal bytes. Both now log size, type and
  correlationId only.
- **`x-last-error` carried raw exception text into retry and DLQ metadata**,
  where it persists in a queue and is read by dashboards and queue browsers.
  It now carries a `safeErrorSummary` — error class and `code`, never the
  message. A `HandledError` is deliberately exempt: its message is something
  the service chose to publish.

### Added — optional hardening

- `PROTOBUS_EXPOSE_INTERNAL_ERRORS` (**default `true`**, matching 1.x) controls
  whether an unhandled error's message reaches the caller. The audit
  recommended suppressing it by default; that was reconsidered because a
  protobus caller is another of your own services, already inside the trust
  boundary and already holding the broker credentials — unlike logs and DLQ
  metadata, which escape into systems with looser access control and are
  redacted unconditionally above. Set it to `false` where that assumption does
  not hold, chiefly a gateway relaying errors to untrusted clients. Callers
  then receive a generic message plus the correlationId while the real error
  still reaches the service's own log. `HandledError` always crosses either way.

### Fixed

- **A reply could be dropped and the caller left waiting out its timeout.** The
  dispatcher registered its reply callback *after* awaiting the publish. Once
  publishes took a broker round-trip, a fast service could answer before the
  callback existed, and `_onResult` discarded the reply. The callback is now
  armed before publishing, and released if the publish fails.
- **A failed settlement could terminate the process.** amqplib does not await
  the consume callback, so a rejection escaping it became an unhandled
  rejection. Settlement now publishes (reply, retry, DLQ) and can legitimately
  reject; failures are logged and the message is left unacknowledged for
  redelivery.
- **The streaming idle timeout leaked its pending-stream entry.** A rejecting
  `next()` never triggers `return()`/`throw()`, so the entry and its buffered
  chunks were retained for the dispatcher's lifetime. The park timer is also
  cleared when a chunk arrives rather than left to fire.
- **The RabbitMQ connection URL was logged with its credentials.** `redactUrl()`
  replaces the password while keeping scheme, user, host, port and vhost.

### Security

- **protobufjs upgraded 7.x → 8.x** (runtime and `protobufjs-cli` together).
  This clears the advisories in the locked 7.5.4 tree and breaks a peer
  deadlock: no `protobufjs-cli` newer than `2.0.0` supports protobufjs 7.x, and
  because `protobus generate-types` loads the CLI at runtime, consumers
  following its own install instructions hit a hard `ERESOLVE`. Production
  dependencies now audit clean.
- **CI gates releases.** `publish.yml` previously ran only lint, typecheck and
  build — neither the unit suite nor the RabbitMQ integration suite ran before
  publishing. A new `ci.yml` runs unit tests on Node 20/22/24, integration
  against a RabbitMQ service container, a tarball-contents assertion, and a
  production dependency audit; the publish job now depends on it. Publishing
  moved to Node 24 (trusted publishing needs Node ≥22.14 / npm ≥11.5.1) and
  third-party actions are pinned to commit SHAs.
- **The packed tarball is asserted, not just printed.** `protobus@1.2.1`
  through `1.4.1` shipped a `.env` containing a live `NPM_TOKEN`; that token has
  been revoked. A test now fails the build if anything outside the allowlist —
  or matching a secret pattern — would be published.

## [1.5.0] — 2026-08-03 (never published)

Released as part of 2.0.0 rather than to npm. Recorded here because the commits
exist and 2.0.0 contains this work.

Audit follow-up: bug fixes, no new features. Every new parameter is optional and
no existing signature changed incompatibly.

Two caveats for anyone upgrading. `ServiceCluster` was **removed** (see
**Removed** below) — released as a minor rather than a major because it had no
known users. And three behaviours deliberately changed because the old
behaviour was silently wrong; see **Changed behaviour**.

### Fixed — data corruption

- **Custom types nested inside a sub-message were silently encoded as zero.**
  `messageNeedsPreprocess` only recursed into fields protobufjs had already
  resolved, and protobufjs resolves lazily — so on the first call a nested
  `bigint`/`timestamp` field looked like a scalar, preprocessing was skipped,
  and the value went out empty. The decision was then cached, making it
  permanent for the process. A `bigint` one level deep round-tripped as `0`.
- **Self-referential message types crashed the encoder.** `message Tree { Tree
  child = 1; }` recursed without a cycle guard until the stack overflowed.
  Cycles are now resolved conservatively (always preprocess), which is correct
  if slightly slower for recursive schemas.
- The preprocess cache is per-`MessageFactory` instead of module-global; two
  factories with same-named types in different roots corrupted each other.
- **`bigint`/`timestamp` could not be used in a `.proto` loaded from disk.**
  `init()` called `loadSync()` (which resolves eagerly) *before* adding the
  custom types to the root, so `Context.init(url, [dir])` died with
  `no such type: 'bigint'`.

### Fixed — reliability

- **Unary RPC calls could hang forever.** Pending callbacks had no timeout and
  leaked their map entry. Added `RpcTimeoutError`, a `RPC_CALL_TIMEOUT_MS`
  setting (default 10 min, matching the processing-timeout default so existing
  slow handlers keep working), and an optional per-call `timeoutMs`.
- **`messageProcessingTimeout` did not time anything out.** The timer only set a
  flag, so a hung handler hung forever, and a handler that merely ran long had
  its *successful* result discarded afterwards. It now races the handler and
  passes an `AbortSignal` so cooperative handlers can stop.
- **Errors were dropped when acking early.** The whole retry/DLQ/error-reply
  block was gated on `lateAck`, so an early-ack consumer swallowed handler
  errors entirely and the caller waited out its full timeout. Early-ack
  consumers now still publish the error reply.
- **Event consumers ran with unlimited prefetch.** `EventListener` enabled late
  ack without setting `maxConcurrent`, and amqplib maps that to
  `prefetchCount: 0` — unlimited — letting the broker push an entire backlog
  into memory unacked. Late-ack consumers now fall back to `DEFAULT_PREFETCH`.
- **Publisher backpressure is honoured.** `publish` ignored amqplib's `false`
  return and never awaited `'drain'`, so a fast streaming producer grew the
  internal buffer without bound.
- amqplib delivers `null` when the broker cancels a consumer; that used to
  crash the process on `msg.properties`.
- A changed `retryDelayMs` now fails with `RetryQueueMismatchError` explaining
  that RabbitMQ fixes `x-message-ttl` at declare time, instead of an opaque
  `PRECONDITION_FAILED`.
- `RunnableService.start` exited **0** when startup failed, so orchestrators read
  a crash-on-boot as success. It now exits 1, and signal handlers are registered
  with `once` so calling `start()` twice no longer stacks shutdowns.

### Fixed — security

- **Dispatch ignored the broker routing key.** The method to run came from the
  message body, so a client able to publish to the bus chose the method
  regardless of what it was routed as — making RabbitMQ topic permissions
  unenforceable and allowing one service's request schema to be paired with
  another's handler. The routing key and the owning service name are now both
  enforced. `EventListener` likewise prefers the delivered routing key over the
  publisher-supplied topic in the body.
- **Payloads are no longer logged by default.** `Logger.debug` wrote to stdout
  unconditionally and several sites dumped full request/response bodies, so
  anything shipping stdout to a log aggregator shipped every credential and
  personal detail on the bus. Added `LogLevel` (default `Info`, `LOG_LEVEL` env
  override); every payload dump is gone.
- Proto discovery used `indexOf('.proto')`, which also matched
  `notes.protocol.txt` and `schema.proto.bak`. Now `endsWith`.

### Changed behaviour

- **`bigint` rejects out-of-range values.** It previously took the absolute
  value (`-5n` stored as `5n`) and truncated mod 2^256 (`2^256+7` stored as
  `7`), both silently. Now throws `RangeError`. Valid values are unaffected and
  the wire format is unchanged.
- **`lateAck` defaults to `true`** and is an explicit `IMessageServiceOptions`
  field rather than being inferred from `maxConcurrent`. Deriving durability
  from a concurrency knob meant a service constructed without options acked on
  delivery and silently discarded failures.
- **Debug logging is off by default** (see above). Set `LOG_LEVEL=debug` to
  restore the old verbosity, minus the payloads.

### Removed

- **`ServiceCluster`**, along with its docs and tests. Node is single-threaded,
  so co-locating services in one process bought no parallelism and only coupled
  their failure domains and deploys; it also could not pass
  `IMessageServiceOptions` through, leaving retry, DLQ and prefetch tuning
  unreachable for any service started through it. `MessageService` now registers
  its own schema during `init()`, so a service is self-sufficient:

  ```typescript
  // before
  const cluster = new ServiceCluster(context);
  cluster.use(MyService);
  await cluster.init();

  // after — one service per process
  await RunnableService.start(context, MyService, { maxConcurrent: 2 });
  ```

### Added to the top-level export

- `RpcTimeoutError`, `RetryQueueMismatchError`, and `LogLevel` / `setLogLevel` /
  `getLogLevel`, all of which the fixes above introduce.

### Performance

- `decodeRequest` decoded the payload twice and discarded the first result.
- `Config` no longer re-runs `parseInt` per access, and rejects malformed values
  rather than yielding `NaN` — `MESSAGE_PROCESSING_TIMEOUT=6oo000` produced
  `setTimeout(fn, NaN)`, which fires immediately and flagged every message as
  timed out.
- Encoded buffers are copied out of protobufjs's shared allocation pool instead
  of aliasing it, so each in-flight message no longer pins an 8 KB pool block.

### Testing

- Added unit coverage for the `connection.ts` ack/retry/DLQ state machine, the
  dispatcher timeout path, `Config` parsing, log levels, proto registration and
  the custom-type encode path — 100 unit tests, none requiring Docker. That
  machinery previously had no unit tests at all, which is why the defects above
  survived.

## [1.4.2] — 2026-08-03 (never published)

### Security

- **1.4.0 and 1.4.1 accidentally shipped a `.env` file inside the published
  npm tarball.** Those versions have been removed from the registry and the
  credential they contained has been revoked. If you installed either version,
  upgrade to 1.4.2. No library code changed between 1.4.1 and 1.4.2.

### Fixed

- Packaging now uses an explicit `files` allowlist in `package.json` instead of
  relying solely on `.npmignore`, so only `dist/` and the docs ship. `.env`,
  `.github/`, and key material are additionally denylisted.

## [1.4.1] — 2026-06-04

### Fixed

- Top-level package now re-exports the streaming error classes that landed in
  1.4.0 but were accidentally left out of `index.ts`. Code can now do
  `import { StreamTimeoutError, StreamingError, StreamBackpressureError,
  StreamClosedError } from 'protobus'` instead of reaching into
  `protobus/dist/lib/errors`. No runtime changes — purely a typings/export
  fix for a documented 1.4.0 feature.

## [1.4.0] — 2026-06-04

### Added

- **Server-streaming RPC.** Methods declared `rpc foo (Req) returns (stream Chunk)`
  in `.proto` return an `AsyncIterable<Chunk>` on the client (consumed with
  `for await`) and accept an `async *foo()` generator on the server. End-of-stream
  is signaled via the `x-protobus-final` AMQP header — no `ResponseContainer`
  schema change. See [`docs/advanced/streaming.md`](docs/advanced/streaming.md).
- **Cross-language compatibility.** A TS client (`protobus@1.4.0`) drives a Python
  streaming server (`protobus-py==1.4.0`) identically to a Python client. New
  integration test at `test/integration/cross-language.test.ts`.
- New errors: `StreamingError`, `StreamTimeoutError`, `StreamBackpressureError`,
  `StreamClosedError`.
- New config: `STREAM_IDLE_TIMEOUT_MS` (default `60000` ms) — idle timeout
  between streaming chunks.
- New public API: `Context.publishStreamingMessage()`,
  `MessageFactory.isStreamingMethod()`, `MessageDispatcher.publishStreaming()`.

### Fixed

- **Retry/DLQ was silently dead code.** A `new Promise(async (resolve, reject)
  => {...})` anti-pattern in `Connection.consume` swallowed handler rejections
  as unhandled promise rejections instead of routing them to the `.catch` arm
  where retry/DLQ logic lived. Replaced with a proper `try { ... } catch { ... }`
  so handler errors actually reach the retry path.
- **Retry queue redelivery dropped silently.** `sendToQueue` set the message's
  routing key to the queue name, so when the retry queue's TTL fired and the
  message dead-lettered back to the main bus exchange, the routing key no
  longer matched the consumer's `REQUEST.<service>.*` binding and the message
  disappeared. Fixed by publishing retried messages to a dedicated retry
  **topic exchange** (`<service>.Retry.Exchange`) bound to the retry queue
  with `#`, so the original routing key survives the round-trip.
- **HandledError vs unhandled error split now respected.** `HandledError`
  short-circuits and returns to the caller immediately (no retry). Unhandled
  errors trigger the retry chain. When retries exhaust on the DLQ path, an
  explicit error response is now published to the caller — no more silent
  timeouts after DLQ exhaustion.

### Changed

- `MessageHandler` signature gained an optional third parameter for the
  incoming AMQP headers: `(content, correlationId, headers?) => ...`.
  Existing 2-arg handlers continue to work — the parameter is optional.
- `MessageHandler` may now return an `AsyncIterable<Buffer>` (in addition to
  `Buffer | void`) to drive a streaming reply.

### Notes

- Tests: 47/47 integration suite green (was 42/43 with one silent retry
  failure on `master`). Streaming adds 11 tests; cross-language adds 4;
  the previously-broken retry test is now fixed.
