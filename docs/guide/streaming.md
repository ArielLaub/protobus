# Streaming RPC

Protobus supports **server-streaming RPC** — a single request from the client can produce *many* response messages from the server, delivered as they're produced, instead of one bundled response at the end.

The motivating use case is LLM token streaming: a model generates a 500-word answer over 10 seconds, and you want to show each token to the user as it arrives rather than waiting for the full response.

> **Status:** server-streaming only (one request → many responses). Client-streaming and bidirectional streaming are not implemented and not currently planned.

## TL;DR

```typescript
// 1. Declare the method as streaming in your .proto file, using the gRPC `stream` keyword:
service Llm {
    rpc complete       (CompleteRequest) returns (CompleteResponse);
    rpc completeStream (CompleteRequest) returns (stream CompleteChunk);
}

// 2. Server: write an async generator that yields each chunk
class LlmService extends MessageService {
    public async *completeStream(req: any): AsyncIterable<any> {
        for await (const event of bedrock.converseStream(req)) {
            yield { delta: event.text };
        }
        yield { stopReason: 'end_turn', usage: event.usage };
    }
}

// 3. Client: iterate with `for await`
for await (const chunk of llmProxy.completeStream({ prompt: '...' })) {
    process.stdout.write(chunk.delta);
}
```

The framework handles correlation IDs, the reply queue, end-of-stream detection, error propagation, and cancellation. You write the generator.

## When to use streaming

Use streaming when:

- The response is **incrementally meaningful** — each chunk is useful before the next arrives (LLM tokens, log tails, video frames, progress updates).
- The response **takes too long** to deliver as one blob — users perceive latency by *time to first byte*, not by total response time.
- You want to **cancel** cleanly — closing an iterator unwinds the work upstream.

Don't use streaming when:

- The chunks are tiny and the response is fast — adding stream overhead just to deliver 50 bytes hurts more than it helps.
- The client always needs the full response before doing anything — pagination over unary calls is simpler.
- The data is **not naturally ordered** — streaming guarantees in-order delivery within a single call, which costs flexibility you might not want.

## Wire protocol

A streaming response is **N+1 AMQP messages** published to the client's reply queue, all carrying the same `correlationId` as the request. End-of-stream is signaled by an AMQP **header** on the final message; the message body is a regular response payload like any other.

### Per-message headers

| Header | Type | Required | Meaning |
|---|---|---|---|
| `x-protobus-final` | `boolean` | yes (on terminal) | `false` (or absent) → more messages follow. `true` → this is the last chunk. |
| `x-protobus-seq` | `uint32` | optional | Monotonically increasing 0-based sequence. Useful for diagnostics; not required for correctness (RabbitMQ guarantees order within the single-publisher → single-queue → single-consumer topology of an RPC reply). |

The standard AMQP `correlationId` is reused exactly as for unary calls — it ties every chunk back to the request that initiated the stream.

### Why headers, not the payload

Streaming markers are **transport-layer concerns**, not application data. Keeping them on AMQP headers means:

- `ResponseContainer` stays semantically clean — it's "result OR error", not "result OR error PLUS streaming state".
- Adding new transport flags later (cancel, ack, window) costs nothing — no proto bump.
- Old unary clients never see streaming concepts they don't understand.
- The same call site code works whether the framework batches one message or a hundred.

### End-of-stream rules

The terminal message carries `x-protobus-final: true`. Its body is a regular response container — typically containing the last data chunk (e.g., the final `delta` plus `stopReason` and `usage` for an LLM call), but it can also be empty or an error.

Three terminal outcomes the client must handle:

1. **Normal completion** — `x-protobus-final: true` + a result payload. Iterator yields the final chunk and stops.
2. **Mid-stream error** — `x-protobus-final: true` + an error payload. Iterator throws.
3. **Timeout / disconnect** — no terminal message arrives within the idle timeout. Iterator throws `StreamTimeoutError`.

## Declaring a streaming method

Use the standard gRPC syntax — the `stream` keyword on the response type:

```proto
service Llm {
    rpc complete       (CompleteRequest) returns (CompleteResponse);
    rpc completeStream (CompleteRequest) returns (stream CompleteChunk);
    //                                            ^^^^^^^^^^^^^^^^^^^
}

message CompleteChunk {
    string delta       = 1;   // incremental text (empty on terminal chunk if no more text)
    string stop_reason = 2;   // populated on terminal chunk
    Usage  usage       = 3;   // populated on terminal chunk
}
```

Protobus reads the `responseStream` flag from the method's protobufjs descriptor at startup — no custom parser, no convention, no annotation. If you've used gRPC, this is the same syntax.

The proxy and the service base class inspect this flag once when methods are wired up:

- If `responseStream === false` → the proxy generates an async function that returns the decoded response (current behavior, unchanged).
- If `responseStream === true` → the proxy generates a function that returns an `AsyncIterable` of decoded chunks.

## Client API

The proxy method returns an `AsyncIterable<T>` — you consume it with `for await`:

```typescript
import { ServiceProxy } from 'protobus';

const llm = new ServiceProxy(ctx, 'Llm.Service');
await llm.init();

for await (const chunk of llm.completeStream({ prompt: 'tell me about life insurance' })) {
    process.stdout.write(chunk.delta);
}
```

That's the entire client API for streaming. The framework:

1. Publishes the request once.
2. Drains reply-queue messages matching the `correlationId`, decoding each.
3. Yields each decoded chunk to the loop.
4. When it sees `x-protobus-final: true`, yields the final chunk (if any) and ends the iterator.
5. If the terminal message carries an error, throws out of the `for await`.

### Error handling

Errors are thrown inside the iteration — same model as any async generator:

```typescript
import { HandledError, StreamTimeoutError } from 'protobus';

try {
    for await (const chunk of llm.completeStream(req)) {
        process(chunk);
    }
} catch (err) {
    if (err instanceof StreamTimeoutError) {
        // No chunk for STREAM_IDLE_TIMEOUT_MS (default 60_000)
        logger.error('stream went silent');
    } else if ((err as any).code === 'GUARDRAIL_BLOCKED') {
        // Server returned a known error mid-stream
        logger.warn('blocked mid-stream: %s', err.message);
    } else {
        throw err;
    }
}
```

### Cancellation

Cancelling stops the **producer**, not just the reader. Two ways to trigger it.

**Break out of the loop.** The iterator's `return()` runs, which releases the client's slot and sends a cancellation notice to the server:

```typescript
for await (const chunk of llm.completeStream(req)) {
    process(chunk);
    if (seenEnough) break;   // the server stops generating too
}
```

**Pass an `AbortSignal`.** `break` only takes effect once the next chunk arrives to resume the loop, so it cannot help when the decision is made elsewhere — a Stop button in a different request handler, or a client that disconnects. A signal fires immediately, from anywhere:

```typescript
const stop = new AbortController();
app.post('/chat/:id/stop', (req, res) => { stop.abort(); res.end(); });

for await (const chunk of llm.completeStream(req, undefined, undefined, { signal: stop.signal })) {
    send(chunk);
}
```

It composes with signals you already have. Passing an HTTP request's own `signal` stops the stream when the user closes the tab, with no Stop button involved.

An aborted stream **ends the loop rather than raising** — the same outcome as
`break`, since both mean the caller asked to stop. That leaves "I cancelled"
and "the server finished" looking identical from inside the loop, which matters
when the signal belongs to someone else. Check the signal afterwards when you
need to tell them apart:

```typescript
for await (const chunk of llm.completeStream(req, undefined, undefined, { signal: stop.signal })) {
    send(chunk);
}
if (stop.signal.aborted) { /* stopped early — the response is partial */ }
```

On the server, watch `context.signal` — the fourth argument to your handler:

```typescript
public async *completeStream(request, actor?, correlationId?, context?) {
    for await (const delta of openai.chat.completions.create({
        ...params,
        stream: true,
        signal: context?.signal,     // the upstream request is torn down too
    })) {
        if (context?.signal?.aborted) return;
        yield { text: delta.choices[0]?.delta?.content ?? '' };
    }
}
```

Cancellation is **cooperative**. JavaScript cannot preempt a running generator, so a handler that ignores its signal runs to completion — the framework stops publishing its output, so the caller is unaffected either way, but the work is still done. Checking the signal is what makes cancellation *save* anything.

#### Delivery is best effort

The cancellation notice is an ordinary message, published once and not retried. If it is lost, the producer never hears it and runs to completion — the same outcome as never having cancelled. There is no correctness risk; the cost is wasted work.

If that work is expensive enough to matter, detect it and cancel again: chunks still arriving well after you cancelled mean the notice did not land.

```typescript
// Cancel, then re-cancel if the producer is evidently still going.
stop.abort();
const stillArriving = () => Date.now() - lastChunkAt < 500;
setTimeout(() => { if (stillArriving()) stop2.abort(); }, 1000);
```

The framework deliberately does not do this for you: how long to wait, and whether to bother, depends on what the stream costs.

#### How it travels

Cancellation is published to a **fanout** exchange (`proto.bus.cancel`), and every service process binds its own exclusive, auto-deleting queue to it. Each replica sees every cancellation and acts only on correlation IDs it is actually running.

Fanout rather than a routed queue because the caller has no way to know *which* replica picked up its request. A shared queue would deliver the notice to one replica at random — usually the wrong one.

If the broker credentials cannot declare that exchange, the service logs a warning and runs without cancellation support rather than failing to start.

### Timeouts

Streaming uses an **idle timeout** rather than a total-call timeout, because a long stream can legitimately take minutes. The default is 60 seconds between chunks (configurable via the `STREAM_IDLE_TIMEOUT_MS` env var):

```typescript
// Per-call override
for await (const chunk of llm.completeStream(req, undefined, 120_000)) {
    // ...
}
```

If no chunk arrives within the timeout, `StreamTimeoutError` is thrown. The unary `MESSAGE_PROCESSING_TIMEOUT` does not apply to streaming calls.

## Server API

A streaming handler is an **async generator** (`yield`s instead of `return`s):

```typescript
import { MessageService } from 'protobus';

class LlmService extends MessageService {
    public get ServiceName() { return 'Llm.Service'; }
    public get ProtoFileName() { return 'llm.proto'; }

    public async *completeStream(req: any): AsyncIterable<any> {
        // Stream chunks as they arrive from upstream
        for await (const event of bedrock.converseStream({
            model: req.modelId,
            messages: req.messages,
        })) {
            yield { delta: event.text };
        }

        // Terminal chunk carries finalization metadata
        yield {
            stopReason: 'end_turn',
            usage: { /* ... */ },
        };
    }
}
```

The framework:

1. Detects that the method is declared as `stream` in the proto (via `responseStream` on the protobufjs method descriptor).
2. For each yielded value: encodes a response container, publishes to `replyTo` with `x-protobus-final: false` and an incrementing `x-protobus-seq`.
3. When the generator exhausts, publishes the last yield's message with `x-protobus-final: true` (look-ahead by one — no extra empty terminal needed when the user yielded the finalization data last).

### Raising errors mid-stream

Throwing from inside the generator publishes a terminal error message that the client iterator will re-throw:

```typescript
public async *completeStream(req: any): AsyncIterable<any> {
    for await (const event of bedrock.converseStream(req)) {
        if (guardrail.flagged(event.text)) {
            throw new HandledError('guardrail blocked output', 'GUARDRAIL_BLOCKED');
        }
        yield { delta: event.text };
    }
}
```

`HandledError` skips retry/DLQ logic the same way it does for unary calls.

## Backpressure

The reply queue is a per-client anonymous queue (auto-delete, exclusive). If the client iterates slowly, messages buffer there.

For chat token streaming neither RabbitMQ-side queue limits nor client-side memory are reachable in practice. If pathological producers become a concern, you can configure queue limits on the reply queue directly via amqplib.

## Backward compatibility

The streaming feature is **purely additive**:

- **Existing unary RPCs are unchanged.** No proto changes, no API changes, no header changes. The framework only inspects the streaming flag when wiring up a method, and unary methods follow the exact same path they did before.
- **Old clients calling new unary methods** — works, no change.
- **Old clients calling new streaming methods** — the proxy method shape changes from `Promise<T>` to `AsyncIterable<T>`. This is a compile-time / runtime API change you opt into per-method by adding `stream` to your `.proto`.
- **New clients calling old unary methods** — works, no change.
- **Mixed-version services in the same cluster** — fine, as long as the *individual method* contract agrees on whether it's streaming.

## Comparison with gRPC

Protobus streaming intentionally mirrors gRPC's server-streaming model so the mental model ports:

| | gRPC server-streaming | Protobus server-streaming |
|---|---|---|
| Proto syntax | `returns (stream Foo)` | Identical |
| Client API (TypeScript) | Callbacks / observable | `for await` over `AsyncIterable<T>` |
| Transport | HTTP/2 with stream frames | AMQP with multiple replies on a correlationId |
| Ordering guarantee | Per-stream FIFO | Per-stream FIFO (RabbitMQ single-queue/single-consumer) |
| End-of-stream signal | HTTP/2 END_STREAM frame | `x-protobus-final: true` header |
| Cancellation | Client closes the stream | v1: client unwinds locally. Server cancellation: roadmap. |
| Client-streaming / bidi | Supported | Not supported, not planned |

The biggest practical difference: gRPC streams ride on HTTP/2's multiplexed connection, so the cost per stream is low and you can have thousands open. Protobus rides on a single AMQP reply queue per client, multiplexed by `correlationId` — the per-stream cost is the same as a unary call, but very-high-fanout topologies should be benchmarked.

## Limitations

- **Server-streaming only.** Client-streaming and bidirectional streaming aren't supported.
- **Cancellation is cooperative and best effort.** A handler that never checks `context.signal` runs to completion, and a lost cancellation notice is not retried. See [Cancellation](#cancellation).
- **No exactly-once semantics.** A chunk requeued during failover can be
  redelivered. A redelivery carrying the sequence number of a chunk already
  seen is dropped by the dispatcher, so the common case does not reach the
  caller twice; a gap in the sequence fails the stream with
  `StreamSequenceError` rather than handing over a short stream that looks
  complete. Neither is exactly-once — a peer that sends no `x-protobus-seq`
  header disables the check entirely, since a violation must not be inferred
  from missing information. For idempotent chunks (LLM deltas, log lines) this
  is comfortably enough; for non-idempotent chunks, the caller is responsible.
- **No chunk-level retry/DLQ.** Standard retry/DLQ applies to the entire RPC, not to individual chunks.
- **Single reply queue per client.** All in-flight streams to a single proxy share one reply queue. Very-high-concurrency callers may want multiple proxy instances.

## Implementation notes

For framework contributors. Skip if you're just using streaming.

The streaming path differs from unary in four places:

1. **`MessageFactory.isStreamingMethod(fullName)`** (`lib/message_factory.ts`) — reads `method.responseStream` from the protobufjs descriptor. The flag is populated by the standard `stream` keyword parser; no custom handling required.

2. **`ServiceProxy.init()`** (`lib/service_proxy.ts`) — at proxy-build time, branches on the streaming flag. Streaming methods are exposed as functions returning `AsyncIterable<T>` rather than `Promise<T>`.

3. **`MessageDispatcher`** (`lib/message_dispatcher.ts`) — adds `pendingStreams: Map<correlationId, StreamEntry>`. The callback listener pushes incoming chunks into the entry's buffer; the async iterator drains them. The terminal message (`x-protobus-final: true`) flips `ended` and resolves the parked promise.

4. **`Connection._publishStreamReply()`** (`lib/connection.ts`) — invoked when a handler returns `AsyncIterable<Buffer>`. Look-ahead-by-one buffers each chunk so the framework can mark the last one as final without publishing an extra empty terminal.

The wire format itself uses **only AMQP headers** — no `ResponseContainer` schema changes. This is what makes the feature purely additive.

## See also

- [Message Flow](../concepts/message-flow.md) — the underlying unary RPC pipeline this builds on
- [Error Handling](./error-handling.md) — `HandledError` and retry semantics, which apply identically to streaming
- [Configuration](../reference/configuration.md) — `STREAM_IDLE_TIMEOUT_MS` setting
- `sample/tokenStream/` — a runnable token-stream demo with a Stop button, showing how many tokens the server is spared
