# Error Handling

Patterns for handling errors in Protobus services and clients.

## Error Types

### Unhandled Errors (Retriable)

Regular errors that should cause the message to be retried:

```typescript
async processOrder(request: any) {
    const db = await this.getDatabase();
    if (!db.isConnected) {
        // Regular errors will be retried automatically
        throw new Error('Database temporarily unavailable');
    }
    // ...
}
```

**When to use:**
- Temporary database outages
- External API timeouts
- Resource contention
- Transient network issues

### Handled Errors (Non-retriable)

Use `HandledError` for errors where retrying won't help:

```typescript
import { HandledError } from 'protobus';

async processOrder(request: any) {
    if (!request.orderId) {
        throw new HandledError('orderId is required', 'VALIDATION_ERROR');
    }

    const order = await db.findOrder(request.orderId);
    if (!order) {
        throw new HandledError('Order not found', 'NOT_FOUND');
    }
    // ...
}
```

You can also create custom error classes that extend `HandledError`:

```typescript
import { HandledError } from 'protobus';

class ValidationError extends HandledError {
    constructor(message: string) {
        super(message, 'VALIDATION_ERROR');
    }
}

class NotFoundError extends HandledError {
    constructor(resource: string, id: string) {
        super(`${resource} ${id} not found`, 'NOT_FOUND');
    }
}
```

**When to use:**
- Invalid input/validation errors
- Resource not found
- Permission denied
- Business rule violations

## Error Handling Patterns

### Input Validation

```typescript
import { HandledError } from 'protobus';

async createUser(request: CreateUserRequest) {
    // Validate early
    const errors = this.validateCreateUser(request);
    if (errors.length > 0) {
        throw new HandledError(
            `Validation failed: ${errors.join(', ')}`,
            'VALIDATION_ERROR'
        );
    }

    // Proceed with valid input
    return await this.db.createUser(request);
}

private validateCreateUser(request: any): string[] {
    const errors: string[] = [];
    if (!request.email) errors.push('email is required');
    if (!request.name) errors.push('name is required');
    if (request.email && !this.isValidEmail(request.email)) {
        errors.push('email format is invalid');
    }
    return errors;
}
```

### Resource Not Found

```typescript
import { HandledError } from 'protobus';

async getOrder(request: { orderId: string }) {
    const order = await this.db.findOrder(request.orderId);

    if (!order) {
        throw new HandledError(
            `Order ${request.orderId} not found`,
            'NOT_FOUND'
        );
    }

    return order;
}
```

### External Service Failures

```typescript
import { HandledError } from 'protobus';

async processPayment(request: PaymentRequest) {
    try {
        return await this.paymentGateway.charge(request);
    } catch (error) {
        if (error.code === 'GATEWAY_TIMEOUT') {
            // Retriable - throw regular error
            throw new Error('Payment gateway timeout');
        }

        if (error.code === 'CARD_DECLINED') {
            // Not retriable - throw HandledError
            throw new HandledError('Card declined', 'CARD_DECLINED');
        }

        throw error;
    }
}
```

### Graceful Degradation

```typescript
import { HandledError } from 'protobus';

async getProductWithRecommendations(request: { productId: string }) {
    const product = await this.db.getProduct(request.productId);

    if (!product) {
        throw new HandledError('Product not found', 'NOT_FOUND');
    }

    // Optional: Get recommendations, but don't fail if unavailable
    let recommendations = [];
    try {
        recommendations = await this.recommendationService.getRecommendations({
            productId: request.productId
        });
    } catch (error) {
        // Log but don't fail the request
        console.warn('Failed to get recommendations:', error.message);
    }

    return { ...product, recommendations };
}
```

## Client Error Handling

### Basic Error Handling

```typescript
const proxy = new ServiceProxy(context, 'Orders.OrderService');
await proxy.init();

try {
    const result = await proxy.createOrder({ userId: '123', items: [] });
    console.log('Order created:', result.orderId);
} catch (error) {
    console.error('Failed to create order:', error.message);
}
```

### Error Classification

```typescript
async function callService(proxy: ServiceProxy, method: string, request: any) {
    try {
        return await proxy[method](request);
    } catch (error) {
        // Check for specific error types
        if (error.message.includes('not found')) {
            // Handle not found
            return null;
        }

        if (error.message.includes('validation')) {
            // Handle validation error
            throw new ValidationError(error.message);
        }

        if (error.message.includes('timeout')) {
            // Handle timeout
            throw new TimeoutError(error.message);
        }

        // Unknown error
        throw error;
    }
}
```

### Retry Logic

```typescript
import { isHandledError } from 'protobus';

async function callWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    backoffMs: number = 1000
): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Don't retry handled errors (validation, not found, etc.)
            if (isHandledError(error)) {
                throw error;
            }

            if (attempt < maxRetries) {
                const delay = backoffMs * Math.pow(2, attempt - 1);
                console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    throw lastError!;
}

// Usage
const result = await callWithRetry(() =>
    proxy.processOrder({ orderId: '123' })
);
```

### Circuit Breaker

```typescript
class CircuitBreaker {
    private failures = 0;
    private lastFailure: number = 0;
    private state: 'closed' | 'open' | 'half-open' = 'closed';

    constructor(
        private threshold: number = 5,
        private resetTimeout: number = 30000
    ) {}

    async call<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === 'open') {
            if (Date.now() - this.lastFailure > this.resetTimeout) {
                this.state = 'half-open';
            } else {
                throw new Error('Circuit breaker is open');
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    private onSuccess() {
        this.failures = 0;
        this.state = 'closed';
    }

    private onFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) {
            this.state = 'open';
        }
    }
}

// Usage
const breaker = new CircuitBreaker(5, 30000);

try {
    const result = await breaker.call(() =>
        proxy.riskyOperation({ data: 'test' })
    );
} catch (error) {
    if (error.message === 'Circuit breaker is open') {
        // Fallback logic
        return cachedResult;
    }
    throw error;
}
```

## Error Response Structure

### Consistent Error Format

`HandledError` already provides a consistent error format with `message` and `code` properties:

```typescript
import { HandledError } from 'protobus';

// HandledError has: message, code, isHandled properties
throw new HandledError('Order not found', 'NOT_FOUND');
// error.message = 'Order not found'
// error.code = 'NOT_FOUND'
// error.isHandled = true
```

For more complex error data, you can extend `HandledError`:

```typescript
import { HandledError } from 'protobus';

class DetailedError extends HandledError {
    public readonly details: Record<string, any>;

    constructor(message: string, code: string, details: Record<string, any> = {}) {
        super(message, code);
        this.details = details;
    }
}

// Usage
throw new DetailedError(
    'Validation failed',
    'VALIDATION_ERROR',
    { fields: ['email', 'name'] }
);
```

### Client Error Parsing

```typescript
try {
    await proxy.createOrder(request);
} catch (error) {
    try {
        const serviceError = JSON.parse(error.message);
        switch (serviceError.code) {
            case 'NOT_FOUND':
                handleNotFound(serviceError);
                break;
            case 'VALIDATION_ERROR':
                handleValidation(serviceError);
                break;
            default:
                handleUnknown(serviceError);
        }
    } catch {
        // Not a structured error
        console.error('Unexpected error:', error.message);
    }
}
```

## Event Error Handling

### In Event Handlers

```typescript
await this.subscribeEvent('Orders.OrderCreated', async (event) => {
    try {
        await this.processOrderEvent(event);
    } catch (error) {
        // Log and decide whether to requeue
        console.error('Failed to process order event:', error);

        if (this.isRetriableError(error)) {
            throw error;  // Will requeue
        }

        // Non-retriable: acknowledge and log
        await this.logFailedEvent(event, error);
        // Don't throw - message will be acknowledged
    }
});
```

### Dead Letter Queue Pattern

Note: Protobus has built-in retry and DLQ support. Configure it via `RetryOptions` when creating your `MessageService`. The example below shows manual DLQ handling if needed:

```typescript
import { HandledError } from 'protobus';

await this.subscribeEvent('Orders.OrderCreated', async (event) => {
    const maxRetries = 3;
    const retryCount = event._retryCount || 0;

    try {
        await this.processOrderEvent(event);
    } catch (error) {
        if (retryCount < maxRetries) {
            // Requeue with retry count
            event._retryCount = retryCount + 1;
            await this.publishEvent('Orders.OrderCreated', event);

            // Mark as handled so original message is not retried
            throw new HandledError(error.message, 'RETRY_SCHEDULED');
        }

        // Max retries exceeded - send to dead letter
        await this.publishEvent('DeadLetter.FailedEvent', {
            originalEvent: event,
            error: error.message,
            retryCount
        });
    }
});
```

---

Next: [HTTP Routing](./http-routing.md) | [Troubleshooting](../troubleshooting.md)
