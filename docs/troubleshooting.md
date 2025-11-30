# Troubleshooting

Common issues and their solutions when working with Protobus.

## Connection Issues

### Connection Refused

**Symptom:**
```
Error: connect ECONNREFUSED 127.0.0.1:5672
```

**Causes & Solutions:**

1. **RabbitMQ not running**
   ```bash
   # Check if RabbitMQ is running
   rabbitmqctl status

   # Start RabbitMQ
   sudo systemctl start rabbitmq-server
   # or with Docker
   docker start rabbitmq
   ```

2. **Wrong host/port**
   ```typescript
   // Check your connection string
   const url = 'amqp://guest:guest@localhost:5672/';
   //                             ↑ default port
   ```

3. **Firewall blocking port**
   ```bash
   # Allow port 5672
   sudo ufw allow 5672
   ```

### Authentication Failed

**Symptom:**
```
Error: ACCESS_REFUSED - Login was refused
```

**Solutions:**

1. **Check credentials**
   ```typescript
   // Verify username:password
   const url = 'amqp://username:password@host:5672/';
   ```

2. **Check virtual host**
   ```typescript
   // Default vhost is /
   const url = 'amqp://user:pass@host:5672/';
   // Custom vhost
   const url = 'amqp://user:pass@host:5672/my-vhost';
   ```

3. **Create user in RabbitMQ**
   ```bash
   rabbitmqctl add_user myuser mypassword
   rabbitmqctl set_permissions -p / myuser ".*" ".*" ".*"
   ```

### Connection Drops

**Symptom:**
- Service stops responding after network hiccup
- RabbitMQ shows connection as closed

**Solution:**
Protobus v0.9.8+ automatically reconnects. Check your reconnection configuration:

```typescript
// Ensure reconnection is configured (it's enabled by default)
await context.init(amqpUrl, protoPaths, {
    reconnection: {
        maxRetries: 0,  // 0 = infinite retries
        maxDelayMs: 30000,
    }
});

// Monitor reconnection status
context.connection.on('disconnected', () => {
    console.log('Connection lost, reconnecting...');
});

context.connection.on('reconnected', () => {
    console.log('Connection restored');
});
```

**If reconnection keeps failing:**
1. Check RabbitMQ server is accessible
2. Verify credentials are still valid
3. Check for firewall/network issues
4. Review `maxRetries` setting - set to `0` for infinite retries

## Proto File Issues

### Proto File Not Found

**Symptom:**
```
Error: ENOENT: no such file or directory, open '/path/to/service.proto'
```

**Solutions:**

1. **Use absolute paths**
   ```typescript
   // Wrong
   get ProtoFileName() { return './service.proto'; }

   // Correct
   get ProtoFileName() { return __dirname + '/service.proto'; }
   ```

2. **Check file exists**
   ```bash
   ls -la /path/to/your/proto/
   ```

### Service/Method Not Found

**Symptom:**
```
Error: Service 'Package.ServiceName' not found
Error: Method 'methodName' not found
```

**Solutions:**

1. **Check proto package name**
   ```protobuf
   package MyPackage;  // ← This is the package name

   service MyService {  // ← Service name
       rpc myMethod(Request) returns(Response);
   }
   ```

2. **Use correct service name**
   ```typescript
   // Must be Package.ServiceName
   get ServiceName() { return 'MyPackage.MyService'; }
   ```

3. **Ensure proto is loaded**
   ```typescript
   // Include directory in context init
   await context.init(url, [__dirname + '/proto/']);
   ```

### Type Mismatch

**Symptom:**
```
Error: Cannot read property 'encode' of undefined
```

**Solutions:**

1. **Check message names in proto**
   ```protobuf
   // Types in RPC must include package
   service MyService {
       rpc myMethod(MyPackage.Request) returns(MyPackage.Response);
       //           ↑ Include package name
   }
   ```

2. **Ensure message is defined**
   ```protobuf
   message Request {
       string field = 1;
   }
   // Make sure this message exists in the same or imported proto
   ```

## RPC Issues

### Request Timeout

**Symptom:**
```
Error: Request timed out
```

**Causes & Solutions:**

1. **Service not running**
   ```bash
   # Verify service is consuming from queue
   rabbitmqctl list_queues name consumers
   ```

2. **Handler taking too long**
   ```bash
   # Increase timeout (default: 10 minutes)
   export MESSAGE_PROCESSING_TIMEOUT=1800000  # 30 minutes
   ```

3. **Message stuck in queue**
   ```bash
   # Check queue in RabbitMQ management
   # http://localhost:15672/#/queues
   ```

### No Response Received

**Symptom:**
- RPC call hangs indefinitely
- No error thrown

**Solutions:**

1. **Check callback exchange**
   ```bash
   rabbitmqctl list_exchanges | grep callback
   # Should show: proto.bus.callback
   ```

2. **Verify correlation ID handling**
   - Ensure service is sending responses to correct reply queue

### Error: Method is not a function

**Symptom:**
```
TypeError: proxy.myMethod is not a function
```

**Solutions:**

1. **Initialize proxy first**
   ```typescript
   const proxy = new ServiceProxy(context, 'Package.Service');
   await proxy.init();  // ← Don't forget this!
   const result = await proxy.myMethod({});
   ```

2. **Method name must match proto**
   ```protobuf
   service MyService {
       rpc myMethod(...);  // ← Exact name
   }
   ```

## Event Issues

### Events Not Received

**Symptom:**
- `publishEvent()` succeeds but handlers not called

**Solutions:**

1. **Subscribe before publishing**
   ```typescript
   // Subscriber must be running first
   await subscriber.subscribeEvent('Type', handler);
   // Then publish
   await publisher.publishEvent('Type', data);
   ```

2. **Check topic pattern**
   ```typescript
   // Publisher topic
   await this.publishEvent('Event', data, 'ORDERS.US.SHIPPED');

   // Subscriber pattern must match
   await this.subscribeEvent('Event', handler, 'ORDERS.US.*');     // ✓
   await this.subscribeEvent('Event', handler, 'ORDERS.*.SHIPPED'); // ✓
   await this.subscribeEvent('Event', handler, 'ORDERS.EU.*');     // ✗
   ```

3. **Verify exchange exists**
   ```bash
   rabbitmqctl list_exchanges | grep events
   # Should show: proto.bus.events
   ```

### Duplicate Event Handling

**Symptom:**
- Same event processed multiple times

**Causes:**
- Multiple subscriptions in same service
- Handler throwing error (causes requeue)

**Solutions:**

1. **Subscribe once**
   ```typescript
   // Only subscribe in init()
   async init() {
       await super.init();
       await this.subscribeEvent('Type', this.handleEvent.bind(this));
   }
   ```

2. **Implement idempotency**
   ```typescript
   const processedEvents = new Set();

   async handleEvent(event) {
       if (processedEvents.has(event.id)) return;
       processedEvents.add(event.id);
       // Process event...
   }
   ```

## Performance Issues

### High Memory Usage

**Causes & Solutions:**

1. **Unbounded message accumulation**
   ```typescript
   // Limit concurrent processing
   get maxConcurrent() { return 10; }
   ```

2. **Large messages**
   - Consider streaming or chunking
   - Compress payloads

### Slow Message Processing

**Solutions:**

1. **Profile handler**
   ```typescript
   async myMethod(request) {
       const start = Date.now();
       const result = await this.process(request);
       console.log(`Processed in ${Date.now() - start}ms`);
       return result;
   }
   ```

2. **Add more listeners**
   ```typescript
   cluster.use(MyService, 4);  // 4 concurrent listeners
   ```

3. **Optimize database queries**
   - Use connection pooling
   - Add indexes
   - Batch operations

## Debugging Tips

### Enable Debug Logging

```typescript
import { setLogger, ILogger } from 'protobus';

const debugLogger: ILogger = {
    info: (msg) => console.log('[INFO]', msg),
    debug: (msg) => console.log('[DEBUG]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg)
};

setLogger(debugLogger);
```

### RabbitMQ Management UI

Access at `http://localhost:15672` (default: guest/guest)

Check:
- Queue message counts
- Consumer connections
- Exchange bindings
- Message rates

### Inspect Messages

```bash
# List queues with message counts
rabbitmqctl list_queues name messages consumers

# Purge a queue (use carefully!)
rabbitmqctl purge_queue MyService.Events
```

### Trace Messages

```bash
# Enable tracing
rabbitmqctl trace_on

# View traces in management UI or logs
# Disable when done
rabbitmqctl trace_off
```

---

Next: [Known Issues](./known-issues.md) | [Architecture](./architecture.md)
