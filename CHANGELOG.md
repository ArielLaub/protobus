# Changelog

All notable changes to **protobus** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
