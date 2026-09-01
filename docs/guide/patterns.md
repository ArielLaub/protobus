# Patterns

> Worked examples assembled from everything in the guide: concurrency, retries, events, service-to-service calls, shutdown and deployment.

**Read this if** you have a service running and want to know the shape of the next thing you are about to build.

| | |
|---|---|
| **Prerequisites** | [Getting Started](./getting-started.md) · [Error Handling](./error-handling.md) |
| **Next** | [Testing](./testing.md) · [Configuration](../reference/configuration.md) |
| **Source** | [`sample/combatGame`](../../sample/combatGame) — six services doing most of this at once |

**On this page** — [Concurrency](#concurrency-control) · [Retries](#retry-configuration) · [Events](#event-driven-patterns) · [Service to service](#service-to-service-calls) · [Shutdown](#graceful-shutdown-with-cleanup) · [Scaling out](#load-balancing-multiple-instances) · [Configuration](#environment-based-configuration) · [Docker](#docker-deployment) · [Resilience](#resilience-patterns)

> [!NOTE]
> Most snippets below are written against **CLI-generated types**
> (`Orders.ServiceName`, `Orders.ICreateOrderRequest`), which is how a real
> project looks. They are marked as not machine-checked for that reason — the
> types come from your schema, not from this repository. The
> [Getting Started](./getting-started.md) examples are executed by CI and are the
> place to copy runnable code from.

---

## Concurrency Control

By default, services process messages one at a time. For CPU-bound or I/O-bound workloads, you can process multiple messages concurrently.

### Setting Max Concurrency

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
import { RunnableService, Context } from 'protobus';
import { ImageProcessor } from './common/types/proto';

class ImageProcessorService extends RunnableService implements ImageProcessor.Service {
    ServiceName = ImageProcessor.ServiceName;

    async resize(request: ImageProcessor.IResizeRequest): Promise<ImageProcessor.IResizeResponse> {
        // This can take 2-5 seconds per image
        const result = await processImage(request.imageUrl, request.width, request.height);
        return { processedUrl: result };
    }
}

// Start with concurrency of 10 - process up to 10 images simultaneously
const context = new Context();
await context.init('amqp://localhost', ['./proto']);

await RunnableService.start(
    context,
    ImageProcessorService,
    { maxConcurrent: 10 }  // Process 10 messages concurrently
);
```

### When to Use Concurrency

| Workload Type | Recommended Concurrency |
|---------------|------------------------|
| CPU-bound (image processing, encryption) | Number of CPU cores |
| I/O-bound (database, HTTP calls) | 10-50+ depending on downstream capacity |
| Mixed | Start with 10, tune based on metrics |
| Sequential required (order processing) | 1 (default) |

### Parallelism Benefits Example

Without concurrency (sequential processing):
```
Request 1: [====2s====]
Request 2:             [====2s====]
Request 3:                         [====2s====]
Total: 6 seconds for 3 requests
```

With `maxConcurrent: 3`:
```
Request 1: [====2s====]
Request 2: [====2s====]
Request 3: [====2s====]
Total: 2 seconds for 3 requests
```

## Retry Configuration

Configure automatic retries for transient failures.

### Basic Retry Setup

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
await RunnableService.start(
    context,
    MyService,
    {
        retry: {
            maxRetries: 5,        // Retry up to 5 times
            retryDelayMs: 3000,   // Wait 3 seconds between retries
            messageTtlMs: 60000,  // Give up after 60 seconds total
        }
    }
);
```

### Retry Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxRetries` | `3` | Maximum retry attempts. Set to `0` to disable retries. |
| `retryDelayMs` | `5000` | Delay between retries in milliseconds. |
| `messageTtlMs` | `undefined` | Total message lifetime. Message is discarded after this time. |

### Preventing Retries for Specific Errors

Use `HandledError` for errors that should not be retried (validation errors, not found, etc.):

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
import { HandledError, RunnableService } from 'protobus';

class OrderService extends RunnableService implements Orders.Service {
    ServiceName = Orders.ServiceName;

    async getOrder(request: Orders.IGetOrderRequest): Promise<Orders.IGetOrderResponse> {
        const order = await db.findOrder(request.orderId);

        if (!order) {
            // This will NOT be retried - it's a handled business error
            throw new HandledError('Order not found', 'NOT_FOUND');
        }

        // This WILL be retried if it fails
        const enrichedOrder = await externalApi.enrichOrder(order);

        return { order: enrichedOrder };
    }
}
```

## Event-Driven Patterns

### Publishing Events

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
class OrderService extends RunnableService implements Orders.Service {
    ServiceName = Orders.ServiceName;

    async createOrder(request: Orders.ICreateOrderRequest): Promise<Orders.ICreateOrderResponse> {
        const order = await db.createOrder(request);

        // Notify other services
        await this.publishEvent('Orders.OrderCreated', {
            orderId: order.id,
            customerId: order.customerId,
            total: order.total,
        });

        return { orderId: order.id };
    }
}
```

### Subscribing to Events

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
class NotificationService extends RunnableService implements Notifications.Service {
    ServiceName = Notifications.ServiceName;

    async init(): Promise<void> {
        await super.init();

        // Subscribe to order events
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.sendEmail(event.customerId, 'Your order has been created!');
        });

        await this.subscribeEvent('Orders.OrderShipped', async (event) => {
            await this.sendSms(event.customerId, `Order ${event.orderId} shipped!`);
        });
    }

    // ... other methods
}
```

### Topic-Based Routing

Use topics for fine-grained event routing:

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
// Publisher: include region in topic
await this.publishEvent('Orders.OrderCreated', orderData, `orders.${order.region}.created`);

// Subscriber: listen to specific region
await this.subscribeEvent('Orders.OrderCreated', handler, 'orders.US.*');

// Subscriber: listen to all regions
await this.subscribeEvent('Orders.OrderCreated', handler, 'orders.*.*');
```

## Service-to-Service Calls

### Calling Another Service

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
import { Context, ServiceProxy, RunnableService } from 'protobus';

class CheckoutService extends RunnableService implements Checkout.Service {
    ServiceName = Checkout.ServiceName;
    private inventoryProxy: ServiceProxy;
    private paymentProxy: ServiceProxy;

    constructor(context: IContext) {
        super(context);
        this.inventoryProxy = new ServiceProxy(context, 'Inventory.Service');
        this.paymentProxy = new ServiceProxy(context, 'Payment.Service');
    }

    async init(): Promise<void> {
        await super.init();
        await this.inventoryProxy.init();
        await this.paymentProxy.init();
    }

    async checkout(request: Checkout.ICheckoutRequest): Promise<Checkout.ICheckoutResponse> {
        // Check inventory
        const inventory = await this.inventoryProxy.checkStock({ productId: request.productId });
        if (!inventory.available) {
            throw new HandledError('Out of stock', 'OUT_OF_STOCK');
        }

        // Process payment
        const payment = await this.paymentProxy.charge({
            amount: request.amount,
            customerId: request.customerId,
        });

        return { orderId: payment.transactionId };
    }

    protected async cleanup(): Promise<void> {
        // Cleanup is handled by context shutdown
    }
}
```

## Graceful Shutdown with Cleanup

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
class DatabaseService extends RunnableService implements Database.Service {
    ServiceName = Database.ServiceName;
    private dbConnection: Connection;

    constructor(context: IContext) {
        super(context);
    }

    async init(): Promise<void> {
        // Connect to database before starting service
        this.dbConnection = await createDatabaseConnection();
        await super.init();
    }

    protected async cleanup(): Promise<void> {
        // Called on SIGINT/SIGTERM
        console.log('Closing database connection...');
        await this.dbConnection.close();
        console.log('Database connection closed');
    }

    async query(request: Database.IQueryRequest): Promise<Database.IQueryResponse> {
        const results = await this.dbConnection.query(request.sql);
        return { rows: results };
    }
}
```

## Load Balancing (Multiple Instances)

RabbitMQ automatically load balances across multiple service instances:

```bash
# Terminal 1
INSTANCE_ID=1 npx tsx services/calculator/CalculatorService.ts

# Terminal 2
INSTANCE_ID=2 npx tsx services/calculator/CalculatorService.ts

# Terminal 3
INSTANCE_ID=3 npx tsx services/calculator/CalculatorService.ts
```

Requests are distributed round-robin across all instances automatically.

## Environment-Based Configuration

<!-- doc-check: ignore why="written against CLI-generated types from your own schema" -->
```typescript
class MyService extends RunnableService {
    ServiceName = MyProto.ServiceName;
}

async function main() {
    const context = new Context();
    await context.init(
        process.env.AMQP_URL || 'amqp://localhost',
        [process.env.PROTO_PATH || './proto']
    );

    await RunnableService.start(
        context,
        MyService,
        {
            maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '1'),
            retry: {
                maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
                retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '5000'),
            },
        }
    );
}
```

## Docker Deployment

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY proto/ ./proto/

ENV AMQP_URL=amqp://rabbitmq:5672
ENV PROTO_PATH=./proto

CMD ["node", "dist/services/calculator/CalculatorService.js"]
```

```yaml
# docker-compose.yml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"

  calculator:
    build: .
    environment:
      AMQP_URL: amqp://rabbitmq:5672
      MAX_CONCURRENT: "10"
    depends_on:
      - rabbitmq
    deploy:
      replicas: 3  # Run 3 instances for load balancing
```

---

## Resilience patterns

These are ordinary application patterns rather than protobus features, and they
live here so the [Error Handling](./error-handling.md) page can stay about what
protobus actually does. Use them around a `ServiceProxy` call the same way you
would around any remote call.

### Retry a call from the caller's side

Protobus retries on the **server**. A caller that wants its own attempts — for a
timeout, or a service that was briefly not running — needs its own loop, and must
not retry a terminal failure:

<!-- doc-check: compile -->
```typescript
import { isHandledError } from 'protobus';

export async function callWithRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 3,
    backoffMs = 1000,
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            // A HandledError means the same request fails the same way. Stop.
            if (isHandledError(error)) { throw error; }
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
            }
        }
    }
    throw lastError;
}
```

> [!WARNING]
> A caller-side retry stacks on top of the server-side ladder. With the defaults
> a single `callWithRetry` of three attempts can mean twelve handler invocations
> and roughly 45 seconds. Decide which layer owns the retry; rarely both.

### Circuit breaker

<!-- doc-check: compile -->
```typescript
export class CircuitBreaker {
    private failures = 0;
    private openedAt = 0;

    constructor(
        private readonly threshold = 5,
        private readonly cooldownMs = 30000,
    ) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.failures >= this.threshold) {
            if (Date.now() - this.openedAt < this.cooldownMs) {
                throw new Error('circuit open');
            }
            this.failures = 0;   // half-open: let one through
        }
        try {
            const result = await fn();
            this.failures = 0;
            return result;
        } catch (error) {
            this.failures += 1;
            this.openedAt = Date.now();
            throw error;
        }
    }
}
```

### Graceful degradation

When a dependency is optional, answer without it rather than failing the whole
request — but say so in the response, so the caller can tell a real answer from a
degraded one:

<!-- doc-check: compile -->
```typescript
interface Profile { id: string; recommendations: string[]; degraded: boolean; }

export async function buildProfile(
    id: string,
    fetchRecommendations: (id: string) => Promise<string[]>,
): Promise<Profile> {
    try {
        return { id, recommendations: await fetchRecommendations(id), degraded: false };
    } catch {
        return { id, recommendations: [], degraded: true };
    }
}
```

### Input validation at the edge

Validate before doing any work, and throw `HandledError` so the message is
answered rather than retried four times:

<!-- doc-check: compile -->
```typescript
import { HandledError } from 'protobus';

export function requireFields<T extends object>(request: T, fields: (keyof T)[]): void {
    const missing = fields.filter((f) => request[f] === undefined || request[f] === null);
    if (missing.length) {
        throw new HandledError(`missing required field(s): ${missing.join(', ')}`, 'VALIDATION_ERROR');
    }
}
```

---

<div align="center">

**[← Testing](./testing.md)** · **[Docs index](../README.md)** · **[CLI →](../reference/cli.md)**

</div>
