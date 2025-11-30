# Known Issues

Current limitations and planned improvements for Protobus.

## ~~Critical Issues~~ Resolved

### ~~No Automatic Reconnection~~ (FIXED in v0.9.8)

**Status:** Resolved

Protobus now automatically reconnects when the RabbitMQ connection is lost. See the [Configuration Guide](./configuration.md) for reconnection options.

---

### Double Message Parsing

**Severity:** Medium (Performance)

**Description:**
The `decodeRequest()` method in `MessageFactory` parses the inner protobuf message twice, causing unnecessary CPU overhead on every RPC request.

**Location:** `lib/message_factory.ts:197-208`

**Current Code:**
```typescript
public decodeRequest(data: Buffer): IRequestContainer {
    const request = RequestContainer.decode(data);
    const TMethod = this.getMethodType(request.method);
    const result = request.toJSON();
    const messageType = TMethod.requestType;

    result.data = this.decodeMessage(messageType, request.data);  // Parse 1
    return {
        method: result.method,
        data: this.decodeMessage(messageType, request.data),      // Parse 2 (redundant!)
        actor: result.actor
    };
}
```

**Impact:**
- Every incoming RPC request does 2x the decoding work
- Noticeable in high-throughput scenarios
- Memory allocation overhead

**Workaround:**
None available without modifying source code.

**Fix:**
```typescript
public decodeRequest(data: Buffer): IRequestContainer {
    const request = RequestContainer.decode(data);
    const TMethod = this.getMethodType(request.method);
    const messageType = TMethod.requestType;
    const decodedData = this.decodeMessage(messageType, request.data);

    return {
        method: request.method,
        data: decodedData,
        actor: request.actor
    };
}
```

---

## Medium Issues

### No Graceful Shutdown

**Severity:** Medium

**Description:**
There is no built-in mechanism to gracefully shut down services, which can lead to:
- Messages being lost mid-processing
- Connections not being properly closed
- Resource leaks

**Workaround:**
```typescript
async function gracefulShutdown(context: IContext) {
    console.log('Shutting down...');

    // Stop accepting new messages
    // (would need to track channels and call channel.cancel())

    // Wait for in-flight messages
    await new Promise(r => setTimeout(r, 5000));

    // Close connection
    try {
        await context.connection.close();
    } catch (e) {
        // Connection may already be closed
    }

    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown(context));
process.on('SIGINT', () => gracefulShutdown(context));
```

---

### Outdated Dependencies

**Severity:** Medium

**Description:**
Several dependencies are significantly outdated and may have security vulnerabilities or compatibility issues.

**Affected Dependencies:**

| Package | Current | Latest | Risk |
|---------|---------|--------|------|
| `@types/node` | 9.6.61 | 20.x+ | Type safety issues |
| `amqplib` | 0.8.0 | 0.10.x | Missing features, potential security |
| `mocha` | 5.0.0 | 10.x | Test framework outdated |
| `tslint` | 5.20.1 | Deprecated | Use ESLint instead |

**Workaround:**
You can update dependencies manually, but test thoroughly:

```bash
# Update type definitions
npm install @types/node@latest --save-dev

# Update amqplib (may require code changes)
npm install amqplib@latest @types/amqplib@latest

# Migrate from tslint to eslint
npm uninstall tslint
npm install eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin --save-dev
```

---

### No Connection Pooling

**Severity:** Low

**Description:**
Each context maintains a single AMQP connection. For high-throughput applications, this may become a bottleneck.

**Workaround:**
Create multiple contexts (not recommended as it increases complexity):

```typescript
// Not ideal, but possible
const contexts = await Promise.all([
    createContext(),
    createContext(),
    createContext()
]);

// Round-robin or load-balance between them
```

---

## Minor Issues

### Missing TypeScript Strict Mode

**Description:**
The project doesn't use TypeScript strict mode, which could allow certain type errors.

**Location:** `tsconfig.json`

---

### No Request Tracing

**Description:**
No built-in support for distributed tracing (e.g., OpenTelemetry, Jaeger).

**Workaround:**
Add tracing manually:

```typescript
async myMethod(request: any, actor?: string, correlationId?: string) {
    const span = tracer.startSpan('myMethod', { correlationId });
    try {
        const result = await this.doWork(request);
        span.end();
        return result;
    } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
    }
}
```

---

### HTTP Routing Experimental

**Description:**
The `routeHttp()` feature is marked as experimental and may change or be removed.

---

## Reporting Issues

If you encounter issues not listed here:

1. Check existing issues: https://github.com/anthropics/protobus/issues
2. Include in your report:
   - Protobus version
   - Node.js version
   - RabbitMQ version
   - Minimal reproduction code
   - Error messages and stack traces

---

## Contributing Fixes

Pull requests welcome for any of these issues. Priority areas:

1. **Connection recovery** - Most impactful
2. **Double parsing fix** - Easy win
3. **Dependency updates** - Important for security
4. **Graceful shutdown** - Production necessity

---

Next: [Troubleshooting](./troubleshooting.md) | [Architecture](./architecture.md)
