# Changelog

All notable changes to **protobus** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
