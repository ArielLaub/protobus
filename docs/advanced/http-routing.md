# HTTP Routing (Experimental)

Protobus includes experimental support for exposing services as HTTP endpoints using Express.

> **Warning:** This feature is experimental and may change in future versions.

## Overview

HTTP routing allows you to tunnel HTTP requests to RPC methods, enabling REST-like access to your microservices.

```
HTTP Client                Protobus                    Service
     │                         │                          │
     │  POST /api/orders/create│                          │
     │ ───────────────────────►│                          │
     │                         │ createOrder()            │
     │                         │ ─────────────────────────►
     │                         │                          │
     │                         │ ◄─────────────────────────
     │ ◄───────────────────────│                          │
     │  { orderId: "123" }     │                          │
```

## Basic Usage

### Single Service

```typescript
import express from 'express';
import { Context, MessageService } from 'protobus';

class OrderService extends MessageService {
    get ServiceName() { return 'Orders.OrderService'; }
    get ProtoFileName() { return './orders.proto'; }

    async createOrder(request: any) {
        return { orderId: '123' };
    }
}

async function main() {
    const context = new Context();
    await context.init('amqp://localhost', ['./proto/']);

    const service = new OrderService(context);
    await service.init();

    // Get Express app with routes
    const app = service.routeHttp();

    app.listen(3000, () => {
        console.log('HTTP server on port 3000');
    });
}
```

### ServiceCluster

```typescript
import { ServiceCluster } from 'protobus';

const cluster = new ServiceCluster(context);

// Register services with HTTP paths
cluster.use(OrderService, 1, '/api/orders');
cluster.use(UserService, 1, '/api/users');
cluster.use(ProductService, 1, '/api/products');

await cluster.init();

const app = cluster.routeHttp();
app.listen(3000);

// Available endpoints:
// POST /api/orders/createOrder
// POST /api/orders/getOrder
// POST /api/users/createUser
// POST /api/products/getProduct
```

## Route Mapping

RPC methods are exposed as POST endpoints:

| RPC Method | HTTP Endpoint |
|------------|---------------|
| `createOrder` | `POST /api/orders/createOrder` |
| `getOrder` | `POST /api/orders/getOrder` |
| `updateOrder` | `POST /api/orders/updateOrder` |

### Request Format

```bash
# RPC request via HTTP
curl -X POST http://localhost:3000/api/orders/createOrder \
  -H "Content-Type: application/json" \
  -d '{"userId": "123", "items": [{"productId": "p1", "quantity": 2}]}'
```

### Response Format

```json
{
  "orderId": "ord-123",
  "status": "pending"
}
```

### Error Response

```json
{
  "error": "Order not found",
  "code": "NOT_FOUND"
}
```

## Customizing the Express App

### Add Middleware

```typescript
const app = cluster.routeHttp();

// Add middleware before routes
app.use(express.json());
app.use(cors());
app.use(helmet());

// Add authentication
app.use('/api', authMiddleware);

app.listen(3000);
```

### Add Custom Routes

```typescript
const app = cluster.routeHttp();

// Add health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Add custom endpoint
app.get('/api/orders/:id', async (req, res) => {
    const proxy = new ServiceProxy(context, 'Orders.OrderService');
    await proxy.init();
    const order = await proxy.getOrder({ orderId: req.params.id });
    res.json(order);
});

app.listen(3000);
```

## Actor Header

Pass actor information via HTTP header:

```bash
curl -X POST http://localhost:3000/api/orders/createOrder \
  -H "Content-Type: application/json" \
  -H "X-Actor: user-123" \
  -d '{"items": [...]}'
```

In the service:

```typescript
async createOrder(request: any, actor?: string) {
    console.log(`Order created by: ${actor}`);  // "user-123"
    // ...
}
```

## Example: Full HTTP Gateway

```typescript
import express from 'express';
import cors from 'cors';
import { Context, ServiceCluster } from 'protobus';
import { OrderService } from './services/order';
import { UserService } from './services/user';

async function main() {
    const context = new Context();
    await context.init(
        process.env.AMQP_URL || 'amqp://localhost',
        ['./proto/']
    );

    const cluster = new ServiceCluster(context);
    cluster.use(OrderService, 2, '/api/orders');
    cluster.use(UserService, 2, '/api/users');
    await cluster.init();

    const app = cluster.routeHttp();

    // Middleware
    app.use(cors());
    app.use(express.json());

    // Health check
    app.get('/health', (req, res) => {
        res.json({ status: 'healthy', timestamp: Date.now() });
    });

    // Error handler
    app.use((err, req, res, next) => {
        console.error('HTTP Error:', err);
        res.status(500).json({
            error: err.message,
            code: 'INTERNAL_ERROR'
        });
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`HTTP gateway running on port ${port}`);
    });
}

main().catch(console.error);
```

## Limitations

1. **All methods are POST** - No RESTful routing (GET, PUT, DELETE)
2. **JSON only** - No support for other content types
3. **No streaming** - Request/response only
4. **No WebSocket** - Use events for real-time updates

## Alternative: Dedicated API Gateway

For production use, consider a dedicated API gateway:

```typescript
// api-gateway.ts
import express from 'express';
import { Context, ServiceProxy } from 'protobus';

const app = express();
app.use(express.json());

let orderProxy: ServiceProxy;
let userProxy: ServiceProxy;

async function init() {
    const context = new Context();
    await context.init('amqp://localhost', ['./proto/']);

    orderProxy = new ServiceProxy(context, 'Orders.OrderService');
    userProxy = new ServiceProxy(context, 'Users.UserService');

    await Promise.all([orderProxy.init(), userProxy.init()]);
}

// RESTful routes
app.post('/api/orders', async (req, res, next) => {
    try {
        const result = await orderProxy.createOrder(req.body);
        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

app.get('/api/orders/:id', async (req, res, next) => {
    try {
        const result = await orderProxy.getOrder({ orderId: req.params.id });
        res.json(result);
    } catch (error) {
        if (error.message.includes('not found')) {
            res.status(404).json({ error: 'Order not found' });
        } else {
            next(error);
        }
    }
});

app.get('/api/users/:id', async (req, res, next) => {
    try {
        const result = await userProxy.getUser({ userId: req.params.id });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

init().then(() => {
    app.listen(3000, () => console.log('API Gateway on port 3000'));
});
```

---

Next: [Error Handling](./error-handling.md) | [Getting Started](../getting-started.md)
