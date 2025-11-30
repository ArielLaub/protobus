# Message Flow

This document explains how messages flow through Protobus, including the encoding/decoding process.

## Message Encoding (Double Wrapping)

Protobus uses a two-layer encoding scheme:

```
┌─────────────────────────────────────────┐
│         Container (Outer Layer)         │
│  ┌───────────────────────────────────┐  │
│  │ • method/type (string)            │  │
│  │ • actor/topic (string)            │  │
│  │ • data ────────────────────────┐  │  │
│  │   ┌────────────────────────┐   │  │  │
│  │   │ Actual Message (bytes) │◄──┘  │  │
│  │   │ (Inner Layer)          │      │  │
│  │   └────────────────────────┘      │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**Why two layers?**
1. **Outer layer** provides routing metadata without knowing the message structure
2. **Inner layer** contains the actual business data
3. Services can route messages without understanding every message type
4. Enables generic middleware and logging

## RPC Request/Response Flow

### Complete Flow Diagram

```
CLIENT                                                    SERVICE
  │                                                          │
  │  1. client.add({ a: 5, b: 3 })                          │
  │  ─────────────────────────────►                         │
  │                                                          │
  │  2. MessageFactory.buildRequest()                       │
  │     ┌─────────────────────────────┐                     │
  │     │ Encode { a: 5, b: 3 }       │                     │
  │     │ into AddRequest bytes       │                     │
  │     │                             │                     │
  │     │ Wrap in RequestContainer:   │                     │
  │     │  method: Calculator.Math.add│                     │
  │     │  actor: "client-1"          │                     │
  │     │  data: <AddRequest bytes>   │                     │
  │     └─────────────────────────────┘                     │
  │                                                          │
  │  3. MessageDispatcher.publishMessage()                  │
  │     correlationId: "cjk8b9x0..."                        │
  │     replyTo: "callback-queue-abc"                       │
  │     routingKey: REQUEST.Calculator.Math.add             │
  │  ─────────────────────────────────────────────────────► │
  │                                                          │
  │              [proto.bus exchange]                        │
  │                      │                                   │
  │                      ▼                                   │
  │              [Calculator.Math queue]                     │
  │                      │                                   │
  │                      ▼                                   │
  │  4. MessageListener receives                             │
  │     ─────────────────────────────────────────────────── │
  │                                                          │
  │  5. MessageFactory.decodeRequest()                      │
  │     ┌─────────────────────────────┐                     │
  │     │ Decode RequestContainer     │                     │
  │     │ Extract method name         │                     │
  │     │ Decode inner AddRequest     │                     │
  │     │ Returns: { a: 5, b: 3 }     │                     │
  │     └─────────────────────────────┘                     │
  │                                                          │
  │  6. Service.add() executes                              │
  │     result = { result: 8 }                              │
  │                                                          │
  │  7. MessageFactory.buildResponse()                      │
  │     ┌─────────────────────────────┐                     │
  │     │ Encode { result: 8 }        │                     │
  │     │ into AddResponse bytes      │                     │
  │     │                             │                     │
  │     │ Wrap in ResponseContainer:  │                     │
  │     │  result.data: <bytes>       │                     │
  │     └─────────────────────────────┘                     │
  │                                                          │
  │  8. Send to callback exchange                           │
  │ ◄───────────────────────────────────────────────────────│
  │     routingKey: "cjk8b9x0..." (correlationId)           │
  │                                                          │
  │              [proto.bus.callback exchange]               │
  │                      │                                   │
  │                      ▼                                   │
  │              [callback-queue-abc]                        │
  │                      │                                   │
  │  9. CallbackListener receives                           │
  │                                                          │
  │ 10. MessageFactory.decodeResponse()                     │
  │     ┌─────────────────────────────┐                     │
  │     │ Decode ResponseContainer    │                     │
  │     │ Check result vs error       │                     │
  │     │ Decode inner AddResponse    │                     │
  │     │ Returns: { result: 8 }      │                     │
  │     └─────────────────────────────┘                     │
  │                                                          │
  │ 11. Promise resolves with { result: 8 }                 │
  │                                                          │
```

### Request Encoding Details

```typescript
// What happens inside buildRequest()

// 1. Look up method type from proto
const methodType = messageFactory.getMethodType('Calculator.Math.add');
// Returns: { requestType: 'Calculator.AddRequest', responseType: 'Calculator.AddResponse' }

// 2. Encode the actual request data
const innerBytes = messageFactory.encodeMessage('Calculator.AddRequest', { a: 5, b: 3 });
// Returns: Buffer containing protobuf-encoded AddRequest

// 3. Wrap in RequestContainer
const container = new RequestContainer({
    method: 'Calculator.Math.add',
    actor: 'client-1',
    data: innerBytes
});

// 4. Encode the container
const outerBytes = RequestContainer.encode(container).finish();
// Returns: Buffer containing protobuf-encoded RequestContainer
```

### Response Encoding Details

```typescript
// What happens inside buildResponse()

// 1. Encode the result data
const innerBytes = messageFactory.encodeMessage('Calculator.AddResponse', { result: 8 });

// 2. Wrap in ResponseContainer with ResponseResult
const container = new ResponseContainer({
    value: 'result',
    result: new ResponseResult({ data: innerBytes })
});

// For errors:
const errorContainer = new ResponseContainer({
    value: 'error',
    error: new ResponseError({
        message: 'Division by zero',
        external: false  // if true, message won't be requeued
    })
});
```

## Event Flow

### Event Publishing

```
PUBLISHER                                              SUBSCRIBER(S)
    │                                                        │
    │  1. service.publishEvent('Calc.Event', { op: 'add' }) │
    │  ──────────────────────────────────────────────────►  │
    │                                                        │
    │  2. MessageFactory.buildEvent()                       │
    │     ┌────────────────────────────┐                    │
    │     │ Encode event data          │                    │
    │     │ Wrap in EventContainer:    │                    │
    │     │  type: Calc.Event          │                    │
    │     │  topic: EVENT.Calc.Event   │                    │
    │     │  data: <event bytes>       │                    │
    │     └────────────────────────────┘                    │
    │                                                        │
    │  3. EventDispatcher.publish()                         │
    │     routingKey: EVENT.Calc.Event                      │
    │  ──────────────────────────────────────────────────►  │
    │                                                        │
    │              [proto.bus.events exchange]               │
    │                      │                                 │
    │         ┌───────────┴───────────┐                     │
    │         ▼                       ▼                      │
    │  [Service1.Events]      [Service2.Events]             │
    │         │                       │                      │
    │         ▼                       ▼                      │
    │  EventListener 1          EventListener 2             │
    │                                                        │
    │  4. Trie.match('EVENT.Calc.Event')                    │
    │     Finds registered handlers                         │
    │                                                        │
    │  5. Handler invoked with decoded event                │
    │                                                        │
```

### Wildcard Event Routing

The `Trie` data structure enables efficient wildcard matching:

```
Registered patterns:
  - ORDERS.*.CREATED      → Handler A
  - ORDERS.#              → Handler B
  - ORDERS.US.*.SHIPPED   → Handler C

Incoming event: ORDERS.US.123.CREATED
  ├─ Matches: ORDERS.*.CREATED    → Handler A ✓
  ├─ Matches: ORDERS.#            → Handler B ✓
  └─ No match: ORDERS.US.*.SHIPPED

Incoming event: ORDERS.EU.456.SHIPPED
  ├─ No match: ORDERS.*.CREATED
  ├─ Matches: ORDERS.#            → Handler B ✓
  └─ No match: ORDERS.US.*.SHIPPED
```

**Wildcard rules:**
- `*` matches exactly one word
- `#` matches zero or more words
- Words are separated by `.`

## Message Lifecycle

### Acknowledgment Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Message Received                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │ Process Msg   │
              └───────┬───────┘
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
    ┌──────────┐           ┌──────────┐
    │ Success  │           │  Error   │
    └────┬─────┘           └────┬─────┘
         │                      │
         ▼                      ▼
    ┌─────────┐         ┌─────────────────┐
    │   ACK   │         │ error.external? │
    └─────────┘         └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
              ┌──────────┐            ┌──────────────┐
              │   true   │            │    false     │
              └────┬─────┘            └──────┬───────┘
                   │                         │
                   ▼                         ▼
            ┌───────────┐            ┌─────────────────┐
            │ NACK      │            │ NACK + Requeue  │
            │ (discard) │            │ (retry later)   │
            └───────────┘            └─────────────────┘
```

### Timeout Handling

```
Client sends request
       │
       ▼
  ┌─────────────────┐
  │ Start timer     │
  │ (10 min default)│
  └────────┬────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
┌─────────┐  ┌─────────────┐
│Response │  │   Timeout   │
│received │  │   exceeded  │
└────┬────┘  └──────┬──────┘
     │              │
     ▼              ▼
┌─────────┐  ┌─────────────┐
│ Resolve │  │   Reject    │
│ promise │  │   promise   │
└─────────┘  └─────────────┘
```

## Correlation ID Tracking

Every RPC call is tracked by a unique correlation ID:

```
Client                       Broker                      Service
   │                           │                            │
   │  correlationId: abc123    │                            │
   │  replyTo: queue-xyz       │                            │
   │ ─────────────────────────►│                            │
   │                           │                            │
   │     Store pending:        │                            │
   │     abc123 → Promise      │                            │
   │                           │ ─────────────────────────► │
   │                           │                            │
   │                           │ ◄───────────────────────── │
   │                           │  correlationId: abc123     │
   │ ◄─────────────────────────│                            │
   │                           │                            │
   │  Lookup abc123            │                            │
   │  Resolve Promise          │                            │
   │                           │                            │
```

## Performance Considerations

### Message Size
- Protobuf encoding is compact (typically 3-10x smaller than JSON)
- Container overhead is minimal (~50-100 bytes)
- Consider streaming for very large payloads

### Latency Sources
1. Network round-trip to broker
2. Protobuf encoding/decoding
3. Queue processing time
4. Handler execution time

### Throughput Tips
- Use `maxConcurrent` to limit parallel processing
- Run multiple service instances for horizontal scaling
- Consider message batching for high-volume events

---

Next: [API Reference](./api/context.md) | [Troubleshooting](./troubleshooting.md)
