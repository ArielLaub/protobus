# Getting Started

This guide walks you through creating your first Protobus microservice.

## Prerequisites

- Node.js 14+ (recommended: 18 LTS or later)
- RabbitMQ server running locally or remotely
- TypeScript knowledge

## Installation

```bash
npm install protobus --save
# or
yarn add protobus
```

## Step 1: Define Your Service Schema

Create a `.proto` file that defines your service interface:

```protobuf
// calculator.proto
syntax = "proto3";
package Calculator;

message AddRequest {
    int32 a = 1;
    int32 b = 2;
}

message AddResponse {
    int32 result = 1;
}

message CalculationEvent {
    string operation = 1;
    int32 result = 2;
}

service Math {
    rpc add(Calculator.AddRequest) returns(Calculator.AddResponse);
}
```

**Important conventions:**
- Package name + Service name = Full service name (e.g., `Calculator.Math`)
- All types must be prefixed with package name in RPC definitions
- Events are message types (not part of service definition)

## Step 2: Create the Context

The Context is your connection to the message bus:

```typescript
// context.ts
import { Context, IContext } from 'protobus';

export async function createContext(): Promise<IContext> {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];

    const context = new Context();
    await context.init(AMQP_URL, PROTO_PATHS);

    return context;
}
```

## Step 3: Implement the Service

Create a class that extends `MessageService`:

```typescript
// calculator-service.ts
import { MessageService, IContext } from 'protobus';

export class CalculatorService extends MessageService {
    constructor(context: IContext) {
        super(context);
    }

    // Required: Full service name from proto
    public get ServiceName(): string {
        return 'Calculator.Math';
    }

    // Required: Path to the proto file
    public get ProtoFileName(): string {
        return __dirname + '/proto/calculator.proto';
    }

    // Implement RPC methods matching proto service definition
    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        const result = request.a + request.b;

        // Optionally publish an event
        await this.publishEvent('Calculator.CalculationEvent', {
            operation: 'add',
            result
        });

        return { result };
    }
}
```

## Step 4: Start the Service

```typescript
// server.ts
import { createContext } from './context';
import { CalculatorService } from './calculator-service';

async function main() {
    const context = await createContext();

    const service = new CalculatorService(context);
    await service.init();

    console.log('Calculator service is running');
}

main().catch(console.error);
```

## Step 5: Create a Client

Use `ServiceProxy` to call the service:

```typescript
// client.ts
import { ServiceProxy } from 'protobus';
import { createContext } from './context';

async function main() {
    const context = await createContext();

    const calculator = new ServiceProxy(context, 'Calculator.Math');
    await calculator.init();

    try {
        const response = await calculator.add({ a: 5, b: 3 });
        console.log(`5 + 3 = ${response.result}`);
    } catch (error) {
        console.error('RPC call failed:', error);
    }
}

main().catch(console.error);
```

## Step 6: Subscribe to Events

```typescript
// event-subscriber.ts
import { createContext } from './context';
import { MessageService, IContext } from 'protobus';

class EventSubscriber extends MessageService {
    public get ServiceName(): string { return 'Calculator.Subscriber'; }
    public get ProtoFileName(): string { return __dirname + '/proto/calculator.proto'; }

    constructor(context: IContext) {
        super(context);
    }
}

async function main() {
    const context = await createContext();

    const subscriber = new EventSubscriber(context);
    await subscriber.init();

    // Subscribe to calculation events
    await subscriber.subscribeEvent('Calculator.CalculationEvent', async (event) => {
        console.log(`Received event: ${event.operation} = ${event.result}`);
    });

    console.log('Listening for events...');
}

main().catch(console.error);
```

## Running the Example

1. Start RabbitMQ:
   ```bash
   docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:management
   ```

2. Start the service:
   ```bash
   npx ts-node server.ts
   ```

3. In another terminal, run the client:
   ```bash
   npx ts-node client.ts
   ```

## Project Structure

Recommended project layout:

```
my-project/
├── src/
│   ├── proto/
│   │   └── calculator.proto
│   ├── services/
│   │   └── calculator-service.ts
│   ├── context.ts
│   ├── server.ts
│   └── client.ts
├── package.json
└── tsconfig.json
```

## Using ServiceCluster

For multiple services in one process:

```typescript
import { ServiceCluster } from 'protobus';
import { createContext } from './context';
import { CalculatorService } from './services/calculator-service';
import { LoggingService } from './services/logging-service';

async function main() {
    const context = await createContext();

    const cluster = new ServiceCluster(context);

    // Add services with optional listener count
    cluster.use(CalculatorService, 2);  // 2 concurrent listeners
    cluster.use(LoggingService, 1);     // 1 listener

    await cluster.init();

    console.log('Service cluster running');
}

main().catch(console.error);
```

## Type-Safe Proxies

For better type safety, create typed proxy wrappers:

```typescript
import { ProxiedService, ServiceProxy, IContext } from 'protobus';

interface ICalculatorService {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

export class CalculatorClient extends ProxiedService<ICalculatorService> {
    constructor(context: IContext) {
        super(new ServiceProxy(context, 'Calculator.Math'));
    }
}

// Usage
const client = new CalculatorClient(context);
await client.init();
const result = await client.proxy.add({ a: 1, b: 2 }); // Fully typed!
```

---

Next: [Configuration](./configuration.md) | [Architecture](./architecture.md)
