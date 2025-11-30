# ServiceProxy API

`ServiceProxy` provides a dynamic proxy for calling remote services. It generates methods based on the proto service definition.

## Import

```typescript
import { ServiceProxy, IServiceProxy, IContext } from 'protobus';
```

## Class

```typescript
class ServiceProxy implements IServiceProxy {
    constructor(context: IContext, serviceName: string);

    async init(): Promise<void>;

    // Dynamic methods generated from proto
    [methodName: string]: (request: any, actor?: string) => Promise<any>;
}
```

## Constructor

```typescript
const proxy = new ServiceProxy(context, serviceName);
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `context` | `IContext` | Initialized context with proto files loaded |
| `serviceName` | `string` | Full service name (e.g., `Calculator.Math`) |

## Methods

### init()

Initializes the proxy, setting up the callback listener for responses.

**Returns:** `Promise<void>`

```typescript
const proxy = new ServiceProxy(context, 'Calculator.Math');
await proxy.init();
```

### Dynamic RPC Methods

After initialization, the proxy has methods matching the proto service definition:

```protobuf
service Math {
    rpc add(AddRequest) returns(AddResponse);
    rpc multiply(MultiplyRequest) returns(MultiplyResponse);
}
```

```typescript
// Methods are available after init()
const addResult = await proxy.add({ a: 5, b: 3 });
const multiplyResult = await proxy.multiply({ a: 4, b: 7 });
```

**Method Signature:**
```typescript
async methodName(request: RequestType, actor?: string): Promise<ResponseType>
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `request` | `object` | Request data matching proto message |
| `actor` | `string?` | Optional identifier for the caller |

**Returns:** `Promise<ResponseType>` - The response from the service

**Throws:** `Error` if the service returns an error

## Basic Example

```typescript
import { Context, ServiceProxy } from 'protobus';

async function main() {
    const context = new Context();
    await context.init('amqp://localhost', ['./proto/']);

    const calculator = new ServiceProxy(context, 'Calculator.Math');
    await calculator.init();

    try {
        const result = await calculator.add({ a: 10, b: 20 });
        console.log(`10 + 20 = ${result.result}`);
    } catch (error) {
        console.error('RPC failed:', error.message);
    }
}
```

## With Actor Identification

```typescript
const result = await calculator.add(
    { a: 5, b: 3 },
    'user-123'  // Actor identifier
);

// On the service side:
async add(request, actor) {
    console.log(`Request from: ${actor}`);  // "Request from: user-123"
    return { result: request.a + request.b };
}
```

## Error Handling

```typescript
try {
    const result = await calculator.divide({ a: 10, b: 0 });
} catch (error) {
    // Error from service
    console.error('Service error:', error.message);
    // "Service error: Division by zero"
}
```

## Timeout Handling

RPC calls timeout based on `MESSAGE_PROCESSING_TIMEOUT` (default: 10 minutes):

```typescript
try {
    const result = await longRunningService.process({ data: largeDataset });
} catch (error) {
    if (error.message.includes('timeout')) {
        console.error('Request timed out');
    }
}
```

Set custom timeout via environment variable:
```bash
export MESSAGE_PROCESSING_TIMEOUT=30000  # 30 seconds
```

## Type-Safe Proxies

For better TypeScript support, use `ProxiedService`:

```typescript
import { ProxiedService, ServiceProxy, IContext } from 'protobus';

// Define interface matching proto
interface ICalculatorService {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
    multiply(request: { a: number; b: number }): Promise<{ result: number }>;
}

// Create typed wrapper
class CalculatorClient extends ProxiedService<ICalculatorService> {
    constructor(context: IContext) {
        super(new ServiceProxy(context, 'Calculator.Math'));
    }
}

// Usage with full type safety
async function main() {
    const client = new CalculatorClient(context);
    await client.init();

    // TypeScript knows the types!
    const result = await client.proxy.add({ a: 1, b: 2 });
    console.log(result.result);  // number
}
```

## Multiple Service Proxies

```typescript
async function main() {
    const context = await createContext();

    // Create multiple proxies sharing the same context
    const calculator = new ServiceProxy(context, 'Calculator.Math');
    const orders = new ServiceProxy(context, 'Orders.OrderService');
    const users = new ServiceProxy(context, 'Users.UserService');

    // Initialize all
    await Promise.all([
        calculator.init(),
        orders.init(),
        users.init()
    ]);

    // Use them
    const user = await users.getUser({ id: '123' });
    const order = await orders.createOrder({ userId: user.id, items: [...] });
}
```

## Calling Services from Services

Services can call other services using proxies:

```typescript
class OrderService extends MessageService {
    private userService: ServiceProxy;
    private paymentService: ServiceProxy;

    constructor(context: IContext) {
        super(context);
        this.userService = new ServiceProxy(context, 'Users.UserService');
        this.paymentService = new ServiceProxy(context, 'Payments.PaymentService');
    }

    async init(): Promise<void> {
        await super.init();
        await this.userService.init();
        await this.paymentService.init();
    }

    async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
        // Call user service
        const user = await this.userService.getUser({ id: request.userId });

        // Call payment service
        await this.paymentService.charge({
            userId: user.id,
            amount: request.total
        });

        // Create the order
        const order = await db.createOrder(request);
        return { orderId: order.id };
    }
}
```

## Best Practices

1. **Initialize once, reuse**
   ```typescript
   // Good - single initialization
   const proxy = new ServiceProxy(context, 'My.Service');
   await proxy.init();
   await proxy.method1({});
   await proxy.method2({});

   // Avoid - multiple initializations
   for (const item of items) {
       const proxy = new ServiceProxy(context, 'My.Service');
       await proxy.init();  // Unnecessary overhead
       await proxy.process(item);
   }
   ```

2. **Handle errors gracefully**
   ```typescript
   async function callWithRetry(proxy, method, request, retries = 3) {
       for (let i = 0; i < retries; i++) {
           try {
               return await proxy[method](request);
           } catch (error) {
               if (i === retries - 1) throw error;
               await sleep(1000 * (i + 1));  // Exponential backoff
           }
       }
   }
   ```

3. **Use typed proxies for safety**
   ```typescript
   // Catches errors at compile time
   const result = await client.proxy.add({ a: 'string', b: 2 });
   // TypeScript error: 'string' is not assignable to 'number'
   ```

---

Next: [ServiceCluster](./service-cluster.md) | [Events](./events.md)
