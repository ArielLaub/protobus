# Architecture Overview

Protobus is a TypeScript microservices framework that enables services to communicate via RabbitMQ using Protocol Buffers for message serialization.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
├─────────────────┬──────────────────┬────────────────────────┤
│    Services     │     Clients      │    Cluster Manager     │
│ (MessageService)│  (ServiceProxy)  │   (ServiceCluster)     │
└────────┬────────┴────────┬─────────┴───────────┬────────────┘
         │                 │                     │
         └─────────────────┼─────────────────────┘
                           ▼
         ┌─────────────────────────────────────┐
         │          Message Factory            │
         │   (Protobuf Encode/Decode)          │
         └─────────────────┬───────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    ▼                      ▼                      ▼
┌──────────────┐  ┌─────────────────┐  ┌─────────────────────┐
│   Message    │  │     Event       │  │     Callback        │
│  Dispatcher  │  │   Dispatcher    │  │     Listener        │
│  (RPC Send)  │  │ (Event Publish) │  │  (RPC Response)     │
└──────┬───────┘  └────────┬────────┘  └──────────┬──────────┘
       │                   │                      │
       └───────────────────┼──────────────────────┘
                           ▼
              ┌─────────────────────────┐
              │       Connection        │
              │    (AMQP Wrapper)       │
              └───────────┬─────────────┘
                          ▼
              ┌─────────────────────────┐
              │        RabbitMQ         │
              │    (Message Broker)     │
              └─────────────────────────┘
```

## Core Components

### Context
The central orchestrator that initializes and holds references to all other components.

**Responsibilities:**
- Initialize AMQP connection
- Load and parse .proto files
- Create dispatchers for RPC and events
- Provide factory methods for services and proxies

**File:** `lib/context.ts`

### Connection
Low-level AMQP connection wrapper using `amqplib`.

**Responsibilities:**
- Manage RabbitMQ connection
- Create and manage channels
- Declare exchanges and queues
- Bind queues to exchanges with routing keys

**File:** `lib/connection.ts`

### MessageFactory
Handles all Protocol Buffer serialization and deserialization.

**Responsibilities:**
- Load .proto files from directories
- Encode/decode request, response, and event messages
- Manage message containers (RequestContainer, ResponseContainer, EventContainer)
- Resolve service methods and types from proto definitions

**File:** `lib/message_factory.ts`

### MessageService
Base class for implementing microservices.

**Responsibilities:**
- Register service with the bus
- Handle incoming RPC requests
- Dispatch events
- Subscribe to events from other services

**File:** `lib/message_service.ts`

### ServiceProxy
Dynamic proxy for calling remote services.

**Responsibilities:**
- Generate method stubs from proto definitions
- Send RPC requests to services
- Handle responses and errors

**File:** `lib/service_proxy.ts`

### ServiceCluster
Container for running multiple services in a single process.

**Responsibilities:**
- Initialize multiple services with shared context
- Support multiple listeners per service for scaling
- Optional HTTP routing aggregation

**File:** `lib/service_cluster.ts`

## RabbitMQ Exchanges

Protobus uses three exchanges for different communication patterns:

| Exchange | Type | Purpose | Default Name |
|----------|------|---------|--------------|
| **Main** | topic | RPC requests | `proto.bus` |
| **Callback** | direct | RPC responses | `proto.bus.callback` |
| **Events** | topic | Pub/sub events | `proto.bus.events` |

### Routing Keys

**RPC Requests:**
```
REQUEST.<Package>.<Service>.<Method>
Example: REQUEST.Simple.Service.simpleMethod
```

**RPC Responses:**
```
<correlationId>
Example: cjk8b9x0000001234567890
```

**Events:**
```
EVENT.<Package>.<EventType>
Example: EVENT.Simple.Event

Or custom topics with wildcards:
CUSTOM.*.TOPIC
ORDERS.#.COMPLETED
```

## Message Containers

All messages are wrapped in containers that provide metadata:

### RequestContainer
```protobuf
message RequestContainer {
    string method = 1;  // Full method name: Package.Service.method
    string actor = 2;   // Caller identifier (optional)
    bytes data = 3;     // Encoded request message
}
```

### ResponseContainer
```protobuf
message ResponseContainer {
    oneof value {
        ResponseResult result = 1;
        ResponseError error = 2;
    }
}

message ResponseResult {
    bytes data = 1;  // Encoded response message
}

message ResponseError {
    string message = 1;
    bool external = 2;  // If true, won't requeue on failure
}
```

### EventContainer
```protobuf
message EventContainer {
    string type = 1;   // Event type: Package.EventType
    string topic = 2;  // Routing topic
    bytes data = 3;    // Encoded event message
}
```

## Component Relationships

```
Context
├── Connection (1)
│   └── AMQP Channel (n)
├── MessageFactory (1)
├── MessageDispatcher (1) ──────► Main Exchange
├── EventDispatcher (1) ────────► Events Exchange
└── CallbackListener (1) ◄──────  Callback Exchange

MessageService
├── extends BaseListener
│   └── MessageListener ◄─────── Main Exchange (service queue)
├── uses MessageDispatcher ─────► Main Exchange (for proxy calls)
└── uses EventDispatcher ───────► Events Exchange

ServiceProxy
├── uses MessageDispatcher ─────► Main Exchange
└── uses CallbackListener ◄─────  Callback Exchange
```

## Data Flow

### RPC Call Flow
1. Client creates `ServiceProxy` for target service
2. Client calls method on proxy
3. Proxy encodes request via `MessageFactory`
4. `MessageDispatcher` publishes to main exchange with routing key
5. Service's `MessageListener` receives message
6. Service decodes request, executes handler
7. Service encodes response via `MessageFactory`
8. Response sent to callback exchange
9. Client's `CallbackListener` receives response
10. Promise resolves with decoded result

### Event Flow
1. Service calls `publishEvent()`
2. `EventDispatcher` encodes event via `MessageFactory`
3. Event published to events exchange with topic
4. Subscribers' `EventListener` receives if topic matches
5. Event decoded and handler invoked

## Queue Characteristics

| Queue Type | Durable | Auto-Delete | Exclusive |
|------------|---------|-------------|-----------|
| Service queues | Yes | No | No |
| Callback queues | No | Yes | Yes |
| Event queues | Yes | No | No |

## Message Persistence

- All messages use `deliveryMode: 2` (persistent)
- Messages survive broker restarts
- Unacknowledged messages are redelivered

## Acknowledgment Strategy

- **RPC:** Messages acknowledged after processing
- **Events:** Messages acknowledged after successful handler execution
- **Failed messages:** Negative acknowledgment with requeue (unless marked as `external` error)

## Concurrency

- Default: No prefetch limit (unlimited concurrent messages)
- Optional: `maxConcurrent` parameter limits in-flight messages
- Each service instance processes messages independently

---

Next: [Message Flow](./message-flow.md) | [Getting Started](./getting-started.md)
