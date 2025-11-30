# ServiceCluster API

`ServiceCluster` orchestrates multiple services in a single process, sharing a common context.

## Import

```typescript
import { ServiceCluster, IServiceCluster, IContext } from 'protobus';
```

## Class

```typescript
class ServiceCluster implements IServiceCluster {
    constructor(context: IContext);

    use<T extends IMessageService>(
        ServiceClass: new (context: IContext) => T,
        listenerCount?: number,
        httpPath?: string
    ): void;

    async init(): Promise<void>;

    routeHttp(): Express.Application;
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

### use(ServiceClass, listenerCount?, httpPath?)

Registers a service class to be managed by the cluster.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `ServiceClass` | `constructor` | - | Service class extending `MessageService` |
| `listenerCount` | `number` | `1` | Number of concurrent listeners |
| `httpPath` | `string?` | - | Base HTTP path for routing (experimental) |

```typescript
cluster.use(CalculatorService);           // 1 listener
cluster.use(OrderService, 3);             // 3 listeners
cluster.use(ApiService, 1, '/api/v1');    // With HTTP routing
```

### init()

Initializes all registered services.

**Returns:** `Promise<void>`

```typescript
await cluster.init();
```

### routeHttp()

Returns an Express application with all service HTTP routes mounted.

**Returns:** `Express.Application`

```typescript
const app = cluster.routeHttp();
app.listen(3000);
```

**Note:** This feature is experimental.

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

    // Register services with listener counts
    cluster.use(CalculatorService, 2);      // 2 concurrent listeners
    cluster.use(OrderService, 4);           // 4 concurrent listeners
    cluster.use(NotificationService, 1);    // 1 listener

    await cluster.init();

    console.log('Service cluster running');
}

main().catch(console.error);
```

## Listener Scaling

The `listenerCount` parameter controls how many instances of the service listen for messages:

```
                    RabbitMQ Queue
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │Listener 1│   │Listener 2│   │Listener 3│
    └─────────┘    └─────────┘    └─────────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
                   Service Handler
```

**Guidelines:**
- **CPU-bound work:** Match listener count to CPU cores
- **I/O-bound work:** Higher count (2-4x CPU cores)
- **Memory-intensive:** Lower count based on available memory

## HTTP Routing (Experimental)

Mount services as HTTP endpoints:

```typescript
const cluster = new ServiceCluster(context);

cluster.use(UserService, 1, '/api/users');
cluster.use(OrderService, 1, '/api/orders');
cluster.use(ProductService, 1, '/api/products');

await cluster.init();

const app = cluster.routeHttp();
app.listen(3000);

// Now available:
// POST /api/users/createUser
// POST /api/orders/createOrder
// POST /api/products/getProduct
```

**Note:** HTTP routing is experimental and may change.

## Service Dependencies

Handle dependencies between services:

```typescript
import { ServiceCluster, MessageService, IContext } from 'protobus';

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

// Usage
const cluster = new ServiceCluster(context);
cluster.use(DatabaseService, 1);
cluster.use(UserService, 2);
await cluster.init();
```

## Graceful Shutdown

Implement graceful shutdown for the cluster:

```typescript
async function main() {
    const context = await createContext();
    const cluster = new ServiceCluster(context);

    cluster.use(Service1);
    cluster.use(Service2);

    await cluster.init();

    // Handle shutdown signals
    process.on('SIGTERM', async () => {
        console.log('Shutting down...');
        // Note: Protobus doesn't have built-in shutdown
        // Close connection manually
        await context.connection.close();
        process.exit(0);
    });
}
```

## Monitoring Services

Track service health:

```typescript
class MonitoredService extends MessageService {
    private requestCount = 0;
    private errorCount = 0;

    async methodHandler(request: any): Promise<any> {
        this.requestCount++;
        try {
            return await this.processRequest(request);
        } catch (error) {
            this.errorCount++;
            throw error;
        }
    }

    getMetrics() {
        return {
            requests: this.requestCount,
            errors: this.errorCount,
            errorRate: this.errorCount / this.requestCount
        };
    }
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
        // Subscribe to all calculation events
        await this.subscribeEvent('Calculator.CalculationEvent', async (event) => {
            console.log('Audit:', event);
        });
    }

    async recordAudit(req: { action: string; userId: string }) {
        // Store audit record
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
    cluster.use(LoggingService, 1);     // Sequential logging
    cluster.use(AuditService, 1);       // Event subscriber

    await cluster.init();

    console.log('Cluster running with services:');
    console.log('  - Calculator.Math (2 listeners)');
    console.log('  - Logging.Logger (1 listener)');
    console.log('  - Audit.AuditService (1 listener)');
}

main().catch(console.error);
```

---

Next: [Events](./events.md) | [MessageService](./message-service.md)
