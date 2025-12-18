# ProtoBus

**RabbitMQ-native microservices with Protocol Buffers. No abstractions. No compromises.**

Unlike transport-agnostic frameworks that reduce your message broker to a dumb pipe, ProtoBus is *opinionated*—it's built exclusively for RabbitMQ and leverages its full power: topic exchanges, routing keys, competing consumers, dead-letter queues, and message persistence. Combined with Protocol Buffers for type-safe binary serialization (smaller, faster, and less error-prone than JSON), ProtoBus delivers the reliability and performance that production microservices demand.

> Also available: [protobus-py](https://github.com/ArielLaub/protobus-py) for Python

## Why ProtoBus?

### RabbitMQ-Native, Not RabbitMQ-Compatible

Most microservice frameworks (Moleculer, Seneca, etc.) abstract away the message broker to support pluggable transports. The cost? They implement their own routing, load balancing, and retry logic *on top* of the broker—ignoring the battle-tested features your broker already provides.

**ProtoBus takes the opposite approach:** we embrace RabbitMQ's semantics directly.

| Feature | Transport-Agnostic Frameworks | ProtoBus |
|---------|------------------------------|----------|
| Load balancing | App-level round-robin | Broker-level competing consumers |
| Message routing | App-level pattern matching | Native topic exchanges |
| Reliability | Select → Send → Hope | Queue → Ack → Guaranteed |
| Persistence | Depends (often none) | Native durable queues |
| Dead letters | Manual implementation | Native DLX support |

**What this means in practice:**

```
Transport-agnostic (e.g., Moleculer):
  Request → Broker picks instance A → Send → A crashes → Message lost 💀

ProtoBus + RabbitMQ:
  Request → Queue → A pulls → A crashes before ack → Requeue → B pulls → ✓
```

**Why this matters for performance:** App-level routing means your JavaScript event loop handles both routing decisions AND your business logic. Every message passes through your Node.js process twice—once for routing, once for handling. RabbitMQ's Erlang runtime was purpose-built for message switching: lightweight processes, preemptive scheduling, and pattern matching optimized over decades. Let the broker do what it's designed for.

### Protocol Buffers > JSON

| | JSON | Protocol Buffers |
|---|---|---|
| Size | Verbose, text-based | Compact binary (3-10x smaller) |
| Speed | Parse strings at runtime | Pre-compiled, zero-copy decoding |
| Type safety | Runtime errors | Compile-time guarantees |
| Schema | Hope the docs are right | Contract-first `.proto` files |
| Versioning | Breaking changes everywhere | Built-in forward/backward compatibility |

### True Cross-Language Polyglot

Because ProtoBus uses Protocol Buffers for schemas and RabbitMQ for routing/load balancing, implementing compatible clients in other languages is trivial. The `.proto` files ARE the contract—no proprietary app-level protocols to reverse-engineer.

| | Transport-Agnostic Frameworks | ProtoBus |
|---|---|---|
| Protocol | Custom app-level (must reimplement) | Standard Protobuf + AMQP |
| Schema | Framework-specific or none | Language-agnostic `.proto` files |
| Routing logic | Embedded in each SDK | Handled by RabbitMQ |
| New language support | Months of work | Days—just Protobuf + AMQP client |

**Available implementations:**
- **TypeScript/Node.js**: [protobus](https://github.com/ArielLaub/protobus) (this repo)
- **Python**: [protobus-py](https://github.com/ArielLaub/protobus-py)

A Go, Rust, or Java implementation would be straightforward—just generate Protobuf types and connect to RabbitMQ. The broker handles service discovery, load balancing, and message routing. Your new client just needs to serialize/deserialize Protobuf and publish/consume from the right queues.

### Pluggable Custom Types

Protobuf's built-in types not enough? ProtoBus supports custom type serialization for seamless handling of BigInt, Timestamps, or any domain-specific types:

```typescript
import { registerCustomType, BigIntType, TimestampType } from 'protobus';

// Built-in custom types
registerCustomType('BigInt', BigIntType);
registerCustomType('Timestamp', TimestampType);

// Or define your own
registerCustomType('Money', {
  encode: (value: Money) => ({ amount: value.cents, currency: value.code }),
  decode: (data) => new Money(data.amount, data.currency),
});
```

## Installation

```bash
npm install protobus
npm install --save-dev protobufjs-cli  # For CLI type generation
```

## Quick Start

### 1. Define your service in Protocol Buffers

```protobuf
// proto/Calculator.proto
syntax = "proto3";
package Calculator;

service Service {
  rpc add(AddRequest) returns (AddResponse);
}

message AddRequest {
  int32 a = 1;
  int32 b = 2;
}

message AddResponse {
  int32 result = 1;
}
```

### 2. Generate types and service stub

```bash
npx protobus generate                    # Generate TypeScript types
npx protobus generate:service Calculator # Generate service stub
```

### 3. Implement your service

```typescript
// services/calculator/CalculatorService.ts
import { RunnableService, Context } from 'protobus';
import { Calculator } from '../../common/types/proto';

class CalculatorService extends RunnableService implements Calculator.Service {
    ServiceName = Calculator.ServiceName;

    async add(request: Calculator.IAddRequest): Promise<Calculator.IAddResponse> {
        return { result: (request.a || 0) + (request.b || 0) };
    }
}

// Start the service
const context = new Context();
await context.init('amqp://localhost', ['./proto']);
await RunnableService.start(context, CalculatorService);
```

### 4. Call the service from a client

```typescript
import { Context, ServiceProxy } from 'protobus';

const context = new Context();
await context.init('amqp://localhost', ['./proto']);

const calculator = new ServiceProxy(context, 'Calculator.Service');
await calculator.init();

const response = await calculator.add({ a: 1, b: 2 }); // { result: 3 }
```

## Similar Libraries

Most Node.js microservices frameworks (Moleculer, NestJS, Seneca) are transport-agnostic—they abstract away the broker to support pluggable transports. ProtoBus takes the opposite approach: we're RabbitMQ-native and leverage its full feature set.

See **[Similar Libraries](docs/similar-libraries.md)** for detailed comparisons with Moleculer, NestJS, Seneca, and why we chose this approach.

## CLI

The protobus CLI streamlines development with type generation and service scaffolding:

```bash
npx protobus generate              # Generate TS types from .proto files
npx protobus generate:service Name # Generate service stub
npx protobus init                  # Show project setup instructions
```

Configure in `package.json`:

```json
{
  "protobus": {
    "protoDir": "./proto",
    "typesOutput": "./common/types/proto.ts",
    "servicesDir": "./services"
  }
}
```

See [CLI Documentation](docs/cli.md) for details.

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Step-by-step guide to your first service |
| [Architecture](docs/architecture.md) | System design and component overview |
| [Configuration](docs/configuration.md) | Environment and connection settings |
| [Message Flow](docs/message-flow.md) | How messages travel through the system |
| [Similar Libraries](docs/similar-libraries.md) | Comparison with Moleculer, NestJS, Seneca |

### API Reference

| Component | Description |
|-----------|-------------|
| [Context](docs/api/context.md) | Connection and factory management |
| [MessageService](docs/api/message-service.md) | Base class for implementing services |
| [RunnableService](docs/api/runnable-service.md) | MessageService with lifecycle management |
| [ServiceProxy](docs/api/service-proxy.md) | Client for calling remote services |
| [ServiceCluster](docs/api/service-cluster.md) | Managing multiple service instances |
| [Events](docs/api/events.md) | Pub/sub event system |
| [Custom Types](docs/api/custom-types.md) | Extending Protobuf with custom serialization |
| [CLI](docs/cli.md) | Type generation and service scaffolding |

### Advanced Topics

| Topic | Description |
|-------|-------------|
| [Protobuf Schema](docs/advanced/protobuf-schema.md) | Defining service interfaces |
| [Error Handling](docs/advanced/error-handling.md) | Retry logic and dead-letter queues |
| [Custom Logger](docs/advanced/custom-logger.md) | Integrating your own logger |

### Reference

| Document | Description |
|----------|-------------|
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |
| [Migration Guide](docs/migration.md) | Upgrading between versions |
| [Known Issues](docs/known-issues.md) | Current limitations |

## Requirements

- Node.js 18+
- RabbitMQ 3.8+

## Running Tests

```bash
# Unit tests
npm test

# Integration tests (requires Docker)
npm run test:integration
```

## License

MIT License - Copyright (c) 2018 Remarkable Games Ltd.
