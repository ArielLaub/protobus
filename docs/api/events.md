# Events API

Protobus supports publish/subscribe patterns through events. Events are fire-and-forget messages that can be received by multiple subscribers.

## Overview

```
Publisher ──► Event Exchange ──► Subscriber Queue ──► Handler
                    │
                    ├──► Subscriber Queue ──► Handler
                    │
                    └──► Subscriber Queue ──► Handler
```

## Publishing Events

Events are published from within a `MessageService`:

```typescript
class MyService extends MessageService {
    async someMethod(request: any): Promise<any> {
        // Do work...

        // Publish event
        await this.publishEvent('Package.EventType', {
            field1: 'value1',
            field2: 123
        });

        return { success: true };
    }
}
```

### publishEvent(type, data, topic?)

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `type` | `string` | Event type from proto (e.g., `Package.EventType`) |
| `data` | `any` | Event payload matching proto message |
| `topic` | `string?` | Custom routing topic (for wildcard matching) |

### Simple Event

```typescript
// Proto definition
// message OrderCreated { string orderId = 1; string userId = 2; }

await this.publishEvent('Orders.OrderCreated', {
    orderId: 'ord-123',
    userId: 'usr-456'
});
```

### Event with Custom Topic

```typescript
// Publish to specific topic for wildcard routing
await this.publishEvent('Orders.OrderEvent', {
    orderId: 'ord-123',
    status: 'shipped'
}, 'ORDERS.US.SHIPPED');

// Another event with different topic
await this.publishEvent('Orders.OrderEvent', {
    orderId: 'ord-456',
    status: 'delivered'
}, 'ORDERS.EU.DELIVERED');
```

## Subscribing to Events

### subscribeEvent(type, handler, topic?)

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `type` | `string` | Event type to subscribe to |
| `handler` | `EventHandler` | Async function to handle events |
| `topic` | `string?` | Wildcard topic pattern |

**Handler signature:**
```typescript
type EventHandler = (event: any) => Promise<void>;
```

### Simple Subscription

```typescript
class NotificationService extends MessageService {
    async init(): Promise<void> {
        await super.init();

        // Subscribe to order events
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.sendEmail(event.userId, `Order ${event.orderId} created`);
        });
    }
}
```

### Wildcard Subscriptions

```typescript
// Subscribe to all US orders
await this.subscribeEvent('Orders.OrderEvent', async (event) => {
    console.log('US Order:', event.orderId, event.status);
}, 'ORDERS.US.*');

// Subscribe to all shipped orders globally
await this.subscribeEvent('Orders.OrderEvent', async (event) => {
    console.log('Shipped:', event.orderId);
}, 'ORDERS.*.SHIPPED');

// Subscribe to all order events
await this.subscribeEvent('Orders.OrderEvent', async (event) => {
    console.log('Any order event:', event);
}, 'ORDERS.#');
```

## Wildcard Patterns

| Pattern | Matches | Example |
|---------|---------|---------|
| `*` | Exactly one word | `ORDERS.*.SHIPPED` matches `ORDERS.US.SHIPPED` |
| `#` | Zero or more words | `ORDERS.#` matches `ORDERS.US.CA.SHIPPED` |

### Pattern Examples

```
Pattern: ORDERS.*
  ✓ ORDERS.US
  ✓ ORDERS.EU
  ✗ ORDERS.US.CA

Pattern: ORDERS.*.SHIPPED
  ✓ ORDERS.US.SHIPPED
  ✓ ORDERS.EU.SHIPPED
  ✗ ORDERS.SHIPPED
  ✗ ORDERS.US.CA.SHIPPED

Pattern: ORDERS.#
  ✓ ORDERS
  ✓ ORDERS.US
  ✓ ORDERS.US.CA.SHIPPED

Pattern: ORDERS.#.SHIPPED
  ✓ ORDERS.SHIPPED
  ✓ ORDERS.US.SHIPPED
  ✓ ORDERS.US.CA.SHIPPED
```

## Event Durability

### Persistent Events
- All events are sent with `deliveryMode: 2` (persistent)
- Events survive broker restarts
- Unacknowledged events are redelivered

### Queue Behavior
- Event queues are named: `<ServiceName>.Events`
- Queues are durable (survive restarts)
- Messages remain until acknowledged

### Acknowledgment
- Events are acknowledged after successful handler execution
- Failed handlers cause the message to be requeued
- Set `external: true` on errors to prevent requeuing

```typescript
await this.subscribeEvent('Orders.OrderCreated', async (event) => {
    try {
        await this.processOrder(event);
    } catch (error) {
        if (error.message === 'Invalid order') {
            // Don't retry invalid orders
            const err = new Error('Invalid order');
            (err as any).external = true;
            throw err;
        }
        throw error;  // Will be requeued
    }
});
```

## Multiple Handlers

Subscribe to the same event type with different handlers:

```typescript
class AnalyticsService extends MessageService {
    async init(): Promise<void> {
        await super.init();

        // Handler 1: Store in database
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.db.insert('orders', event);
        });

        // Handler 2: Update metrics
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.metrics.increment('orders.created');
        });

        // Handler 3: Notify dashboard
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.websocket.broadcast('new-order', event);
        });
    }
}
```

## Cross-Service Events

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  OrderService   │     │  EmailService   │     │ AnalyticsService│
│                 │     │                 │     │                 │
│ publishEvent()  │────►│ subscribeEvent()│     │ subscribeEvent()│
│ OrderCreated    │     │ OrderCreated    │◄────│ OrderCreated    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                                               ▲
        │                                               │
        └───────────────────────────────────────────────┘
```

## Event Schema Best Practices

```protobuf
syntax = "proto3";
package Orders;

// Include context in events
message OrderCreated {
    string order_id = 1;
    string user_id = 2;
    int64 timestamp = 3;       // When it happened
    string source = 4;         // What triggered it
    repeated Item items = 5;   // Relevant data
}

// Use specific event types
message OrderShipped {
    string order_id = 1;
    string tracking_number = 2;
    string carrier = 3;
}

// Avoid generic catch-all events
// Bad: message OrderEvent { string type = 1; bytes data = 2; }
```

## Complete Example

```typescript
// order-service.ts
class OrderService extends MessageService {
    get ServiceName() { return 'Orders.OrderService'; }
    get ProtoFileName() { return './orders.proto'; }

    async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
        const order = await this.db.createOrder(request);

        // Publish event
        await this.publishEvent('Orders.OrderCreated', {
            orderId: order.id,
            userId: request.userId,
            timestamp: Date.now(),
            items: request.items
        });

        return { orderId: order.id };
    }

    async shipOrder(request: ShipOrderRequest): Promise<ShipOrderResponse> {
        const order = await this.db.updateOrder(request.orderId, { status: 'shipped' });

        // Publish with topic for geographic routing
        const region = order.shippingAddress.country === 'US' ? 'US' : 'INTL';
        await this.publishEvent('Orders.OrderShipped', {
            orderId: order.id,
            trackingNumber: request.trackingNumber,
            carrier: request.carrier
        }, `ORDERS.${region}.SHIPPED`);

        return { success: true };
    }
}

// notification-service.ts
class NotificationService extends MessageService {
    get ServiceName() { return 'Notifications.NotificationService'; }
    get ProtoFileName() { return './notifications.proto'; }

    async init(): Promise<void> {
        await super.init();

        // Subscribe to new orders
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.sendEmail(event.userId, 'Order Confirmation', {
                orderId: event.orderId,
                items: event.items
            });
        });

        // Subscribe to US shipments only
        await this.subscribeEvent('Orders.OrderShipped', async (event) => {
            await this.sendSMS(event.trackingNumber);
        }, 'ORDERS.US.SHIPPED');
    }
}

// analytics-service.ts
class AnalyticsService extends MessageService {
    get ServiceName() { return 'Analytics.AnalyticsService'; }
    get ProtoFileName() { return './analytics.proto'; }

    async init(): Promise<void> {
        await super.init();

        // Subscribe to all order events
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.recordMetric('orders.created', 1);
        });

        // Track all shipments globally
        await this.subscribeEvent('Orders.OrderShipped', async (event) => {
            await this.recordMetric('orders.shipped', 1, { carrier: event.carrier });
        }, 'ORDERS.#.SHIPPED');
    }
}
```

---

Next: [Troubleshooting](../troubleshooting.md) | [MessageService](./message-service.md)
