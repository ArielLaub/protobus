# ProtoBus

**Scalable microservices. Any language. Zero bloat.**

ProtoBus is an ultra-lightweight message bus with just 2 dependencies. Define your API once in Protocol Buffers, then call services across TypeScript, Python, or any language—with built-in load balancing via RabbitMQ.

> Also available: [protobus-py](https://github.com/ArielLaub/protobus-py) for Python

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

```ts
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

```ts
import { Context, ServiceProxy } from 'protobus';

const context = new Context();
await context.init('amqp://localhost', ['./proto']);

const calculator = new ServiceProxy(context, 'Calculator.Service');
await calculator.init();

const response = await calculator.add({ a: 1, b: 2 }); // { result: 3 }
```

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

### API Reference

| Component | Description |
|-----------|-------------|
| [Context](docs/api/context.md) | Connection and factory management |
| [MessageService](docs/api/message-service.md) | Base class for implementing services |
| [RunnableService](docs/api/runnable-service.md) | MessageService with lifecycle management |
| [ServiceProxy](docs/api/service-proxy.md) | Client for calling remote services |
| [ServiceCluster](docs/api/service-cluster.md) | Managing multiple service instances |
| [Events](docs/api/events.md) | Pub/sub event system |
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
