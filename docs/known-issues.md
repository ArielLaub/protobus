# Known Issues

Current limitations and potential improvements for ProtoBus.

## Minor Issues

### No Graceful Shutdown

**Severity:** Low

**Description:**
There is no built-in mechanism to gracefully shut down services. For most applications, this is handled at the application level.

**Workaround:**
```typescript
async function gracefulShutdown(context: IContext) {
    console.log('Shutting down...');

    // Wait for in-flight messages to complete
    await new Promise(r => setTimeout(r, 2000));

    // Close connection
    await context.connection.disconnect();

    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown(context));
process.on('SIGINT', () => gracefulShutdown(context));
```

---

### No Request Tracing

**Description:**
No built-in support for distributed tracing (e.g., OpenTelemetry, Jaeger).

**Workaround:**
Add tracing manually in your service methods:

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
The `routeHttp()` feature is experimental and may change in future versions.

---

## Reporting Issues

If you encounter issues not listed here:

1. Check existing issues on GitHub
2. Include in your report:
   - ProtoBus version
   - Node.js version
   - RabbitMQ version
   - Minimal reproduction code
   - Error messages and stack traces

---

Next: [Troubleshooting](./troubleshooting.md) | [Architecture](./architecture.md)
