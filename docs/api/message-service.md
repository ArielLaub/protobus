# MessageService API

`MessageService` is the base class for implementing microservices. Extend this class to create services that respond to RPC calls and publish/subscribe to events.

## Import

```typescript
import { MessageService, IMessageService, IContext } from 'protobus';
```

## Abstract Class

```typescript
abstract class MessageService extends BaseListener implements IMessageService {
    constructor(context: IContext);

    // Required abstract properties
    abstract get ServiceName(): string;
    abstract get ProtoFileName(): string;

    // Optional override
    get maxConcurrent(): number;

    // Lifecycle
    async init(): Promise<void>;

    // Events
    async publishEvent(type: string, data: any, topic?: string): Promise<void>;
    async subscribeEvent(type: string, handler: EventHandler, topic?: string): Promise<void>;
}
```

## Required Properties

### ServiceName

The fully qualified service name matching the proto definition.

**Format:** `<Package>.<ServiceName>`

```typescript
public get ServiceName(): string {
    return 'Calculator.Math';
}
```

### ProtoFileName

Absolute path to the .proto file defining this service.

```typescript
public get ProtoFileName(): string {
    return __dirname + '/calculator.proto';
}
```

## Optional Properties

### maxConcurrent

Maximum number of messages processed concurrently. Default: `undefined` (unlimited).

```typescript
public get maxConcurrent(): number {
    return 10;  // Process up to 10 messages at once
}
```

## Methods

### init()

Initializes the service, setting up queues and starting to listen for messages.

**Returns:** `Promise<void>`

```typescript
const service = new MyService(context);
await service.init();
```

### publishEvent(type, data, topic?)

Publishes an event to the event bus.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `type` | `string` | Event type from proto (e.g., `Package.EventType`) |
| `data` | `any` | Event payload matching the proto message |
| `topic` | `string?` | Optional custom routing topic |

**Returns:** `Promise<void>`

```typescript
// Simple event
await this.publishEvent('Calculator.CalculationEvent', {
    operation: 'add',
    result: 42
});

// Event with custom topic for wildcard routing
await this.publishEvent('Orders.OrderEvent', {
    orderId: '123',
    status: 'shipped'
}, 'ORDERS.US.SHIPPED');
```

### subscribeEvent(type, handler, topic?)

Subscribes to events of a specific type.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `type` | `string` | Event type to subscribe to |
| `handler` | `EventHandler` | Async function to handle events |
| `topic` | `string?` | Optional wildcard topic pattern |

**Returns:** `Promise<void>`

```typescript
// Subscribe to specific event type
await this.subscribeEvent('Calculator.CalculationEvent', async (event) => {
    console.log(`Calculation: ${event.operation} = ${event.result}`);
});

// Subscribe with wildcard pattern
await this.subscribeEvent('Orders.OrderEvent', async (event) => {
    console.log(`US Order: ${event.orderId}`);
}, 'ORDERS.US.*');
```

## Implementing RPC Methods

RPC methods are defined in the proto file and implemented as async methods on your service class:

```protobuf
// calculator.proto
service Math {
    rpc add(AddRequest) returns(AddResponse);
    rpc multiply(MultiplyRequest) returns(MultiplyResponse);
}
```

```typescript
class CalculatorService extends MessageService {
    // Method names must match proto service definition
    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }

    async multiply(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a * request.b };
    }
}
```

### Method Signature

RPC handler methods receive up to three parameters:

```typescript
async methodName(
    request: RequestType,    // Decoded request message
    actor?: string,          // Optional actor identifier from client
    correlationId?: string   // Request correlation ID
): Promise<ResponseType>
```

### Error Handling

Throw errors to return error responses to clients:

```typescript
async divide(request: { a: number; b: number }): Promise<{ result: number }> {
    if (request.b === 0) {
        // This error will be sent back to the client
        throw new Error('Division by zero');
    }
    return { result: request.a / request.b };
}
```

For errors that should not cause message requeuing:

```typescript
async processOrder(request: { orderId: string }): Promise<{ success: boolean }> {
    const order = await db.findOrder(request.orderId);
    if (!order) {
        const error = new Error('Order not found');
        (error as any).external = true;  // Don't requeue
        throw error;
    }
    // ...
}
```

## Complete Example

```typescript
import { MessageService, IContext } from 'protobus';

interface AddRequest { a: number; b: number; }
interface AddResponse { result: number; }
interface CalculationEvent { operation: string; result: number; }

class CalculatorService extends MessageService {
    constructor(context: IContext) {
        super(context);
    }

    public get ServiceName(): string {
        return 'Calculator.Math';
    }

    public get ProtoFileName(): string {
        return __dirname + '/calculator.proto';
    }

    public get maxConcurrent(): number {
        return 5;
    }

    async add(request: AddRequest, actor?: string): Promise<AddResponse> {
        console.log(`Add request from ${actor || 'unknown'}`);

        const result = request.a + request.b;

        // Publish event about the calculation
        await this.publishEvent('Calculator.CalculationEvent', {
            operation: `${request.a} + ${request.b}`,
            result
        });

        return { result };
    }

    // Called after init() to set up event subscriptions
    async onInitialized(): Promise<void> {
        // Subscribe to events from other services
        await this.subscribeEvent('Audit.LogEvent', async (event) => {
            console.log('Audit log:', event);
        });
    }
}

// Usage
async function main() {
    const context = await createContext();
    const service = new CalculatorService(context);
    await service.init();
    console.log('Calculator service running');
}
```

## Lifecycle Hooks

Override these methods to hook into the service lifecycle:

```typescript
class MyService extends MessageService {
    // Called before starting to listen
    protected async onBeforeStart(): Promise<void> {
        console.log('Service starting...');
    }

    // Called after init completes
    protected async onInitialized(): Promise<void> {
        console.log('Service initialized');
        // Good place to set up event subscriptions
    }
}
```

## Best Practices

1. **Keep methods focused**
   ```typescript
   // Good - single responsibility
   async createOrder(req) { /* create only */ }
   async processPayment(req) { /* payment only */ }

   // Avoid - doing too much
   async createOrderAndProcessPayment(req) { /* ... */ }
   ```

2. **Use events for side effects**
   ```typescript
   async createOrder(request) {
       const order = await db.createOrder(request);

       // Notify other services via events
       await this.publishEvent('Orders.OrderCreated', { orderId: order.id });

       return { orderId: order.id };
   }
   ```

3. **Validate inputs early**
   ```typescript
   async processOrder(request) {
       if (!request.orderId) {
           const error = new Error('orderId is required');
           (error as any).external = true;
           throw error;
       }
       // ...
   }
   ```

---

Next: [ServiceProxy](./service-proxy.md) | [Events](./events.md)
