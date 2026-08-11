# Changelog

All notable changes to **protobus** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-08-11

Remediation of the 2026-08-11 security and stability audit. The theme is making
each asynchronous boundary **truthful**: a publish completes on a broker
confirm, routing failures are observable, and acknowledgements happen only
after a durable handoff.

This is a major release because the delivery contract changed. Source-level APIs
are unchanged — but timing and failure modes are not, so read
**Changed behaviour** before upgrading.

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

## [1.5.0] — 2026-08-03

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

## [1.4.2] — 2026-08-03

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
