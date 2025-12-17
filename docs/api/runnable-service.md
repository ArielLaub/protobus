# RunnableService

`RunnableService` extends `MessageService` with lifecycle management, making it easier to create production-ready microservices.

## Features

- **Convention-based proto file resolution**: Automatically derives `ProtoFileName` from `ServiceName`
- **Graceful shutdown handling**: Responds to SIGINT and SIGTERM signals
- **Static `start()` method**: Easy service bootstrap with automatic cleanup
- **Cleanup hook**: Override to add custom shutdown logic

## Basic Usage

```typescript
import { RunnableService, Context } from 'protobus';
import { Calculator } from './common/types/proto';

class CalculatorService extends RunnableService implements Calculator.Service {
    ServiceName = Calculator.ServiceName;

    async add(request: Calculator.IAddRequest): Promise<Calculator.IAddResponse> {
        return { result: (request.a || 0) + (request.b || 0) };
    }
}

// Start the service
const context = new Context();
await context.init('amqp://localhost', ['./proto']);
await RunnableService.start(context, CalculatorService);
```

## API

### Constructor

```typescript
constructor(context: IContext, options?: IMessageServiceOptions)
```

Same as `MessageService`. Options include:
- `maxConcurrent`: Limit concurrent message processing
- `retry`: Retry options for failed messages

### Properties

#### `ServiceName` (abstract)

```typescript
abstract get ServiceName(): string;
```

Must be implemented by subclasses. Returns the full service name (e.g., `'Calculator.Service'`).

#### `ProtoFileName`

```typescript
get ProtoFileName(): string;
```

Convention-based proto file resolution. Derives from `ServiceName`:
- `'Calculator.Service'` → `'Calculator.proto'`
- `'Notifications.Service'` → `'Notifications.proto'`

Override this if your proto files follow a different naming convention.

### Methods

#### `cleanup()`

```typescript
protected async cleanup(): Promise<void>
```

Called during shutdown. Override to add custom cleanup logic:

```typescript
class MyService extends RunnableService {
    private dbConnection: Database;

    protected async cleanup(): Promise<void> {
        await this.dbConnection.close();
        console.log('Database connection closed');
    }
}
```

#### `RunnableService.start()` (static)

```typescript
static async start<T extends RunnableService>(
    context: IContext,
    ServiceClass: new (context: IContext, options?: IMessageServiceOptions) => T,
    options?: IMessageServiceOptions,
    postInit?: (service: T) => Promise<void>
): Promise<T>
```

Starts a service with automatic signal handling.

**Parameters:**
- `context`: The protobus Context instance
- `ServiceClass`: The service class to instantiate
- `options`: Optional service options (maxConcurrent, retry)
- `postInit`: Optional callback after service initialization

**Example with options:**

```typescript
await RunnableService.start(
    context,
    CalculatorService,
    { maxConcurrent: 10 },
    async (service) => {
        console.log(`Service ${service.ServiceName} is ready`);
    }
);
```

## Signal Handling

`RunnableService.start()` automatically handles:

- **SIGINT** (Ctrl+C): Graceful shutdown
- **SIGTERM** (Docker/K8s stop): Graceful shutdown

Shutdown sequence:
1. Calls `service.cleanup()` if defined
2. Calls `context.shutdown()` to close connections
3. Exits with code 0

## Comparison with MessageService

| Feature | MessageService | RunnableService |
|---------|---------------|-----------------|
| Proto file name | Must implement | Convention-based (can override) |
| Signal handling | Manual | Automatic |
| Graceful shutdown | Manual | Built-in |
| Cleanup hook | None | `cleanup()` method |
| Bootstrap helper | None | `start()` static method |

**When to use `MessageService`:**
- You need full control over lifecycle
- You have complex initialization requirements
- You're integrating with a custom DI framework

**When to use `RunnableService`:**
- Standard microservice with straightforward lifecycle
- You want convention over configuration
- Quick service prototyping

## Full Example

```typescript
import { RunnableService, Context } from 'protobus';
import { Notifications } from './common/types/proto';

class NotificationService extends RunnableService implements Notifications.Service {
    ServiceName = Notifications.ServiceName;
    private emailClient: EmailClient;

    constructor(context: IContext) {
        super(context, { maxConcurrent: 5 });
        this.emailClient = new EmailClient();
    }

    async sendEmail(request: Notifications.ISendEmailRequest): Promise<Notifications.ISendEmailResponse> {
        await this.emailClient.send(request.to, request.subject, request.body);
        return { success: true };
    }

    protected async cleanup(): Promise<void> {
        await this.emailClient.disconnect();
    }
}

// Main entry point
async function main() {
    const context = new Context();
    await context.init(
        process.env.AMQP_URL || 'amqp://localhost',
        ['./proto']
    );

    await RunnableService.start(context, NotificationService);
}

main().catch(err => {
    console.error('Failed to start service:', err);
    process.exit(1);
});
```
