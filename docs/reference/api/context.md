# Context API

The `Context` class is the main entry point for Protobus. It initializes and orchestrates all components needed for service communication.

## Import

```typescript
import { Context, IContext } from 'protobus';
```

## Interface

```typescript
interface IContext {
    connection: IConnection;
    messageFactory: IMessageFactory;
    messageDispatcher: IMessageDispatcher;
    eventDispatcher: IEventDispatcher;

    init(amqpUrl: string, protoPaths: string[]): Promise<void>;
}
```

## Constructor

```typescript
const context = new Context();
```

No parameters required for construction. Configuration happens during `init()`.

## Methods

### init(amqpUrl, protoPaths)

Initializes the context by connecting to RabbitMQ and loading proto files.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `amqpUrl` | `string` | AMQP connection string |
| `protoPaths` | `string[]` | Array of directories containing .proto files |

**Returns:** `Promise<void>`

**Example:**
```typescript
const context = new Context();
await context.init(
    'amqp://guest:guest@localhost:5672/',
    [__dirname + '/proto/', '/shared/proto/']
);
```

**Throws:**
- `Error` if connection fails
- `Error` if proto files cannot be loaded

## Properties

### connection

The AMQP connection wrapper.

**Type:** `IConnection`

**Usage:**
```typescript
// Rarely needed directly
const channel = await context.connection.openChannel();
```

### messageFactory

The Protocol Buffer message factory.

**Type:** `IMessageFactory`

**Usage:**
```typescript
// Rarely needed directly - used internally by services and proxies
const encoded = context.messageFactory.buildRequest('Service.method', data, 'actor');
```

### messageDispatcher

Dispatcher for sending RPC messages.

**Type:** `IMessageDispatcher`

**Usage:**
```typescript
// Rarely needed directly - used by ServiceProxy
await context.messageDispatcher.publishMessage(routingKey, buffer, correlationId);
```

### eventDispatcher

Dispatcher for publishing events.

**Type:** `IEventDispatcher`

**Usage:**
```typescript
// Rarely needed directly - used by MessageService
await context.eventDispatcher.publish(topic, buffer);
```

## Lifecycle

```
┌─────────────┐
│   Created   │
└──────┬──────┘
       │ init()
       ▼
┌─────────────┐
│ Connecting  │ ──► Connect to AMQP
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Loading   │ ──► Parse .proto files
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Ready     │ ──► Create dispatchers
└─────────────┘
```

## Complete Example

```typescript
import { Context, IContext, MessageService, ServiceProxy } from 'protobus';

async function main() {
    // Create and initialize context
    const context = new Context();
    await context.init(
        process.env.AMQP_URL || 'amqp://localhost',
        [__dirname + '/proto/']
    );

    // Use context for services
    class MyService extends MessageService {
        constructor(ctx: IContext) {
            super(ctx);
        }
        get ServiceName() { return 'My.Service'; }
        get ProtoFileName() { return __dirname + '/proto/my.proto'; }

        async myMethod(req: any) {
            return { success: true };
        }
    }

    const service = new MyService(context);
    await service.init();

    // Use context for clients
    const client = new ServiceProxy(context, 'My.Service');
    await client.init();

    const result = await client.myMethod({ input: 'test' });
}

main().catch(console.error);
```

## Error Handling

```typescript
try {
    await context.init(amqpUrl, protoPaths);
} catch (error) {
    if (error.code === 'ECONNREFUSED') {
        console.error('RabbitMQ not available');
    } else if (error.message.includes('proto')) {
        console.error('Failed to load proto files');
    }
    process.exit(1);
}
```

## Best Practices

1. **Single Context per Process**
   ```typescript
   // Good - share context
   const context = await createContext();
   const service1 = new Service1(context);
   const service2 = new Service2(context);

   // Avoid - multiple connections
   const context1 = await createContext();
   const context2 = await createContext();
   ```

2. **Centralized Proto Paths**
   ```typescript
   const protoPaths = [
       __dirname + '/proto/',      // Local service protos
       '/shared/proto/',           // Shared package protos
   ];
   ```

3. **Environment-based Configuration**
   ```typescript
   const context = new Context();
   await context.init(
       process.env.AMQP_URL || 'amqp://localhost',
       [process.env.PROTO_PATH || './proto/']
   );
   ```

---

Next: [MessageService](./message-service.md) | [ServiceProxy](./service-proxy.md)
