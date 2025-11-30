# ServiceCluster API

`ServiceCluster` orchestrates multiple services in a single process, sharing a common context.

## Import

```typescript
import { ServiceCluster, IContext } from 'protobus';
```

## Class

```typescript
class ServiceCluster {
    constructor(context: IContext);

    use<T extends MessageService>(
        ServiceClass: new (context: IContext) => T,
        count?: number
    ): T;

    async init(): Promise<void>;

    get ServiceNames(): string[];
}
```

## Constructor

```typescript
const cluster = new ServiceCluster(context);
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `context` | `IContext` | Initialized context |

## Methods

### use(ServiceClass, count?)

Registers a service class to be managed by the cluster.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `ServiceClass` | `constructor` | - | Service class extending `MessageService` |
| `count` | `number` | `1` | Number of service instances to create |

**Returns:** The last created service instance.

```typescript
cluster.use(CalculatorService);           // 1 instance
cluster.use(OrderService, 3);             // 3 instances
```

### init()

Initializes all registered services.

**Returns:** `Promise<void>`

```typescript
await cluster.init();
```

### ServiceNames

Returns the names of all registered services.

**Returns:** `string[]`

```typescript
const names = cluster.ServiceNames;
// ['Calculator.Math', 'Order.Service', 'Order.Service', 'Order.Service']
```

## Basic Example

```typescript
import { Context, ServiceCluster } from 'protobus';
import { CalculatorService } from './services/calculator';
import { OrderService } from './services/order';
import { NotificationService } from './services/notification';

async function main() {
    const context = new Context();
    await context.init('amqp://localhost', ['./proto/']);

    const cluster = new ServiceCluster(context);

    // Register services with instance counts
    cluster.use(CalculatorService, 2);      // 2 instances for load balancing
    cluster.use(OrderService, 4);           // 4 instances
    cluster.use(NotificationService);       // 1 instance (default)

    await cluster.init();

    console.log('Service cluster running');
}

main().catch(console.error);
```

## Instance Scaling

The `count` parameter controls how many instances of the service are created. All instances share the same queue, so RabbitMQ load-balances messages between them:

```
                    RabbitMQ Queue
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │Instance 1│   │Instance 2│   │Instance 3│
    └─────────┘    └─────────┘    └─────────┘
```

**Guidelines:**
- **CPU-bound work:** Match instance count to CPU cores
- **I/O-bound work:** Higher count (2-4x CPU cores)
- **Memory-intensive:** Lower count based on available memory

## Service Dependencies

Handle dependencies between services:

```typescript
import { ServiceCluster, MessageService, ServiceProxy, IContext } from 'protobus';

class DatabaseService extends MessageService {
    private db: Database;

    async init() {
        this.db = await Database.connect();
        await super.init();
    }

    get ServiceName() { return 'Core.Database'; }
    get ProtoFileName() { return './database.proto'; }
}

class UserService extends MessageService {
    private dbProxy: ServiceProxy;

    constructor(context: IContext) {
        super(context);
        this.dbProxy = new ServiceProxy(context, 'Core.Database');
    }

    async init() {
        await this.dbProxy.init();
        await super.init();
    }

    get ServiceName() { return 'Users.UserService'; }
    get ProtoFileName() { return './users.proto'; }
}

// Usage - order matters for dependencies
const cluster = new ServiceCluster(context);
cluster.use(DatabaseService);    // Initialize first
cluster.use(UserService, 2);     // Depends on DatabaseService
await cluster.init();
```

## Graceful Shutdown

Implement graceful shutdown for the cluster:

```typescript
async function main() {
    const context = new Context();
    await context.init('amqp://localhost', ['./proto/']);

    const cluster = new ServiceCluster(context);
    cluster.use(Service1);
    cluster.use(Service2);
    await cluster.init();

    // Handle shutdown signals
    const shutdown = async () => {
        console.log('Shutting down...');
        await context.connection.disconnect();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
```

## Complete Example

```typescript
import { Context, ServiceCluster, MessageService, IContext } from 'protobus';

// Service implementations
class CalculatorService extends MessageService {
    get ServiceName() { return 'Calculator.Math'; }
    get ProtoFileName() { return __dirname + '/calculator.proto'; }

    async add(req: { a: number; b: number }) {
        return { result: req.a + req.b };
    }
}

class LoggingService extends MessageService {
    get ServiceName() { return 'Logging.Logger'; }
    get ProtoFileName() { return __dirname + '/logging.proto'; }

    async log(req: { level: string; message: string }) {
        console.log(`[${req.level}] ${req.message}`);
        return { success: true };
    }
}

class AuditService extends MessageService {
    get ServiceName() { return 'Audit.AuditService'; }
    get ProtoFileName() { return __dirname + '/audit.proto'; }

    async init() {
        await super.init();
        // Subscribe to events
        await this.subscribeEvent('Calculator.CalculationEvent', async (event) => {
            console.log('Audit:', event);
        });
    }

    async recordAudit(req: { action: string; userId: string }) {
        return { recorded: true };
    }
}

// Main application
async function main() {
    const context = new Context();
    await context.init(
        process.env.AMQP_URL || 'amqp://localhost',
        [__dirname + '/proto/']
    );

    const cluster = new ServiceCluster(context);

    // Register services
    cluster.use(CalculatorService, 2);  // High throughput
    cluster.use(LoggingService);        // Sequential logging
    cluster.use(AuditService);          // Event subscriber

    await cluster.init();

    console.log('Cluster running with services:');
    console.log('  - Calculator.Math (2 instances)');
    console.log('  - Logging.Logger (1 instance)');
    console.log('  - Audit.AuditService (1 instance)');
}

main().catch(console.error);
```

---

Next: [Events](./events.md) | [MessageService](./message-service.md)
