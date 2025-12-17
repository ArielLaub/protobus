# Examples & Common Patterns

This document covers common patterns and practical examples for protobus.

## Concurrency Control

By default, services process messages one at a time. For CPU-bound or I/O-bound workloads, you can process multiple messages concurrently.

### Setting Max Concurrency

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
INSTANCE_ID=1 ts-node services/calculator/CalculatorService.ts

# Terminal 2
INSTANCE_ID=2 ts-node services/calculator/CalculatorService.ts

# Terminal 3
INSTANCE_ID=3 ts-node services/calculator/CalculatorService.ts
```

Requests are distributed round-robin across all instances automatically.

## Environment-Based Configuration

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
FROM node:18-alpine

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

Next: [CLI](./cli.md) | [Configuration](./configuration.md)
