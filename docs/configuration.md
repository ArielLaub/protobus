# Configuration

Protobus is configured through environment variables, constructor parameters, and reconnection options.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BUS_EXCHANGE_NAME` | `proto.bus` | Main exchange for RPC requests |
| `CALLBACKS_EXCHANGE_NAME` | `proto.bus.callback` | Exchange for RPC responses |
| `EVENTS_EXCHANGE_NAME` | `proto.bus.events` | Exchange for pub/sub events |
| `MESSAGE_PROCESSING_TIMEOUT` | `600000` | RPC timeout in milliseconds (10 minutes) |

## Reconnection Options

Protobus automatically reconnects when the RabbitMQ connection is lost. Configure reconnection behavior when initializing the context:

```typescript
import { Context, ReconnectionOptions } from 'protobus';

const reconnectionOptions: ReconnectionOptions = {
    maxRetries: 10,           // Max attempts (0 = infinite)
    initialDelayMs: 1000,     // First retry delay
    maxDelayMs: 30000,        // Max delay between retries
    backoffMultiplier: 2,     // Exponential backoff multiplier
};

const context = new Context();
await context.init(amqpUrl, protoPaths, { reconnection: reconnectionOptions });
```

### Reconnection Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxRetries` | `10` | Maximum reconnection attempts. Set to `0` for infinite retries. |
| `initialDelayMs` | `1000` | Delay before first reconnection attempt (ms). |
| `maxDelayMs` | `30000` | Maximum delay between attempts (ms). |
| `backoffMultiplier` | `2` | Multiplier for exponential backoff. |

### Reconnection Behavior

1. **Connection loss detected** - All channels become invalid
2. **Pending RPC calls rejected** - With `DisconnectedError`
3. **Exponential backoff** - Delay doubles after each failed attempt (with jitter)
4. **Automatic re-initialization** - Channels, queues, and consumers are restored
5. **Services resume** - Once reconnected, services continue processing

### Connection Events

Monitor connection state via the connection object:

```typescript
// Listen for connection events
context.connection.on('disconnected', () => {
    console.log('Connection lost');
});

context.connection.on('reconnecting', ({ attempt, delay }) => {
    console.log(`Reconnecting (attempt ${attempt}, delay ${delay}ms)`);
});

context.connection.on('reconnected', () => {
    console.log('Connection restored');
});

context.connection.on('error', (err) => {
    console.error('Connection error:', err.message);
});

// Check connection state
if (context.isConnected) {
    // Safe to make RPC calls
}

if (context.isReconnecting) {
    // Currently attempting to reconnect
}
```

### Handling Disconnections in Client Code

```typescript
import { ServiceProxy, DisconnectedError } from 'protobus';

try {
    const result = await proxy.someMethod({ data: 'test' });
} catch (error) {
    if (error instanceof DisconnectedError) {
        // Connection was lost during the RPC call
        // The system is automatically reconnecting
        // You may want to retry after a delay
        console.log('Connection lost, will retry after reconnection');
    } else {
        throw error;
    }
}
```

### Infinite Retries

For services that should never give up:

```typescript
await context.init(amqpUrl, protoPaths, {
    reconnection: {
        maxRetries: 0,  // Infinite retries
        maxDelayMs: 60000,  // Cap at 1 minute between attempts
    }
});
```

### Example

```bash
export BUS_EXCHANGE_NAME=myapp.bus
export CALLBACKS_EXCHANGE_NAME=myapp.bus.callback
export EVENTS_EXCHANGE_NAME=myapp.bus.events
export MESSAGE_PROCESSING_TIMEOUT=30000  # 30 seconds
```

## AMQP Connection String

The connection string follows the standard AMQP URI format:

```
amqp://[username:password@]host[:port][/vhost]
```

### Examples

```typescript
// Local development
const url = 'amqp://guest:guest@localhost:5672/';

// With virtual host
const url = 'amqp://user:password@rabbitmq.example.com:5672/production';

// CloudAMQP
const url = 'amqps://user:password@rabbit.cloudamqp.com/vhost';

// Amazon MQ
const url = 'amqps://user:password@b-xxx.mq.region.amazonaws.com:5671';
```

## Context Initialization

```typescript
const context = new Context();
await context.init(amqpUrl, protoPaths);
```

**Parameters:**
- `amqpUrl`: AMQP connection string
- `protoPaths`: Array of directories containing .proto files

## Service Configuration

### MessageService Options

```typescript
class MyService extends MessageService {
    // Required: Service identifier
    public get ServiceName(): string {
        return 'Package.ServiceName';
    }

    // Required: Path to proto file
    public get ProtoFileName(): string {
        return __dirname + '/service.proto';
    }

    // Optional: Maximum concurrent messages (default: unlimited)
    public get maxConcurrent(): number {
        return 10;
    }
}
```

### ServiceCluster Configuration

```typescript
const cluster = new ServiceCluster(context);

// Add service with listener count
cluster.use(MyService, 3);  // 3 concurrent listeners

// Optional: HTTP base path for routing
cluster.use(MyService, 1, '/api/myservice');

await cluster.init();
```

## Queue Configuration

Protobus creates queues with the following defaults:

### Service Queues
- **Name:** `<ServiceName>` (e.g., `Calculator.Math`)
- **Durable:** `true` - survives broker restart
- **Auto-delete:** `false`
- **Exclusive:** `false`

### Callback Queues
- **Name:** Auto-generated unique ID
- **Durable:** `false`
- **Auto-delete:** `true` - deleted when client disconnects
- **Exclusive:** `true` - only accessible by creating connection

### Event Queues
- **Name:** `<ServiceName>.Events` (e.g., `Calculator.Math.Events`)
- **Durable:** `true`
- **Auto-delete:** `false`

## Exchange Configuration

All exchanges are created with:
- **Type:** `topic` (main, events) or `direct` (callback)
- **Durable:** `true`
- **Auto-delete:** `false`

## Message Options

### Persistence
All messages are sent with `deliveryMode: 2` (persistent), ensuring they survive broker restarts.

### Timeout
RPC calls timeout after `MESSAGE_PROCESSING_TIMEOUT` milliseconds. Adjust this for long-running operations:

```bash
# For operations that may take up to 5 minutes
export MESSAGE_PROCESSING_TIMEOUT=300000
```

## Logging Configuration

Replace the default console logger:

```typescript
import { setLogger, ILogger } from 'protobus';

const customLogger: ILogger = {
    info: (message: string) => myLogger.info(message),
    debug: (message: string) => myLogger.debug(message),
    warn: (message: string) => myLogger.warn(message),
    error: (message: string) => myLogger.error(message)
};

setLogger(customLogger);
```

## RabbitMQ Server Configuration

Recommended RabbitMQ settings for production:

```ini
# rabbitmq.conf

# Increase heartbeat interval for cloud environments
heartbeat = 60

# Memory high watermark
vm_memory_high_watermark.relative = 0.7

# Disk free limit
disk_free_limit.relative = 2.0
```

## Docker Compose Example

```yaml
version: '3.8'
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: protobus
      RABBITMQ_DEFAULT_PASS: secret
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

  my-service:
    build: .
    environment:
      AMQP_URL: amqp://protobus:secret@rabbitmq:5672/
      BUS_EXCHANGE_NAME: myapp.bus
      MESSAGE_PROCESSING_TIMEOUT: 60000
    depends_on:
      - rabbitmq

volumes:
  rabbitmq_data:
```

---

Next: [Message Flow](./message-flow.md) | [Architecture](./architecture.md)
