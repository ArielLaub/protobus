# ProtoBus

A lightweight, scalable microservices message bus written in TypeScript.

ProtoBus uses **RabbitMQ** for message routing and load balancing, and **Protocol Buffers** for fast, type-safe serialization.

## Installation

```bash
npm install protobus
```

## Quick Start

```ts
import { Context, MessageService, ServiceProxy } from 'protobus';

// Initialize context
const context = new Context();
await context.init('amqp://localhost:5672/', ['./proto/']);

// Create a service
class Calculator extends MessageService {
    get ServiceName() { return 'Math.Calculator'; }
    get ProtoFileName() { return './calculator.proto'; }

    async add(request: { a: number, b: number }) {
        return { result: request.a + request.b };
    }
}

const service = new Calculator(context);
await service.init();

// Call the service
const client = new ServiceProxy(context, 'Math.Calculator');
await client.init();
const response = await client.add({ a: 1, b: 2 }); // { result: 3 }
```

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Step-by-step guide to your first service |
| [Architecture](docs/architecture.md) | System design and component overview |
| [Configuration](docs/configuration.md) | Environment and connection settings |
| [Message Flow](docs/message-flow.md) | How messages travel through the system |

### API Reference

| Component | Description |
|-----------|-------------|
| [Context](docs/api/context.md) | Connection and factory management |
| [MessageService](docs/api/message-service.md) | Base class for implementing services |
| [ServiceProxy](docs/api/service-proxy.md) | Client for calling remote services |
| [ServiceCluster](docs/api/service-cluster.md) | Managing multiple service instances |
| [Events](docs/api/events.md) | Pub/sub event system |

### Advanced Topics

| Topic | Description |
|-------|-------------|
| [Protobuf Schema](docs/advanced/protobuf-schema.md) | Defining service interfaces |
| [Error Handling](docs/advanced/error-handling.md) | Retry logic and dead-letter queues |
| [Custom Logger](docs/advanced/custom-logger.md) | Integrating your own logger |
| [HTTP Routing](docs/advanced/http-routing.md) | Exposing services over HTTP |

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
