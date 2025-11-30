# Error Handling

Patterns for handling errors in Protobus services and clients.

## Error Types

### Service Errors (Retriable)

Errors that should cause the message to be requeued for retry:

```typescript
async processOrder(request: any) {
    const db = await this.getDatabase();
    if (!db.isConnected) {
        // Throwing without 'external' flag causes requeue
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

### External Errors (Non-retriable)

Errors where retrying won't help:

```typescript
async processOrder(request: any) {
    if (!request.orderId) {
        const error = new Error('orderId is required');
        (error as any).external = true;  // Don't requeue
        throw error;
    }

    const order = await db.findOrder(request.orderId);
    if (!order) {
        const error = new Error('Order not found');
        (error as any).external = true;  // Don't requeue
        throw error;
    }
    // ...
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
async createUser(request: CreateUserRequest) {
    // Validate early
    const errors = this.validateCreateUser(request);
    if (errors.length > 0) {
        const error = new Error(`Validation failed: ${errors.join(', ')}`);
        (error as any).external = true;
        throw error;
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
async getOrder(request: { orderId: string }) {
    const order = await this.db.findOrder(request.orderId);

    if (!order) {
        const error = new Error(`Order ${request.orderId} not found`);
        (error as any).external = true;
        (error as any).code = 'NOT_FOUND';
        throw error;
    }

    return order;
}
```

### External Service Failures

```typescript
async processPayment(request: PaymentRequest) {
    try {
        return await this.paymentGateway.charge(request);
    } catch (error) {
        if (error.code === 'GATEWAY_TIMEOUT') {
            // Retriable - don't mark as external
            throw new Error('Payment gateway timeout');
        }

        if (error.code === 'CARD_DECLINED') {
            // Not retriable
            const err = new Error('Card declined');
            (err as any).external = true;
            throw err;
        }

        throw error;
    }
}
```

### Graceful Degradation

```typescript
async getProductWithRecommendations(request: { productId: string }) {
    const product = await this.db.getProduct(request.productId);

    if (!product) {
        const error = new Error('Product not found');
        (error as any).external = true;
        throw error;
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

            // Don't retry external errors
            if ((error as any).external) {
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

```typescript
interface ServiceError {
    message: string;
    code: string;
    details?: Record<string, any>;
}

async createOrder(request: any) {
    try {
        // ...
    } catch (error) {
        const serviceError: ServiceError = {
            message: error.message,
            code: this.getErrorCode(error),
            details: this.getErrorDetails(error)
        };

        const err = new Error(JSON.stringify(serviceError));
        (err as any).external = this.isExternalError(error);
        throw err;
    }
}

private getErrorCode(error: Error): string {
    if (error.message.includes('not found')) return 'NOT_FOUND';
    if (error.message.includes('validation')) return 'VALIDATION_ERROR';
    if (error.message.includes('permission')) return 'PERMISSION_DENIED';
    return 'INTERNAL_ERROR';
}
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

```typescript
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

            // Mark original as external (no requeue)
            const err = new Error(error.message);
            (err as any).external = true;
            throw err;
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
