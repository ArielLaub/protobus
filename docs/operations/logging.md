# Structured Logging

Protobus can emit its own log lines as structured records instead of free text.
This is opt-in and additive: if you do nothing, or if you installed a custom
`ILogger`, you keep the existing human-readable output unchanged.

## The record

```typescript
interface LogRecord {
    component: 'protobus';
    level: 'debug' | 'info' | 'warn' | 'error';
    timestamp: string;          // ISO 8601
    operation: string;          // 'publish' | 'consume' | 'connect' | ...
    message: string;            // human-readable summary
    messageType?: string;       // e.g. 'example.Service.DoThing'
    messageId?: string;
    correlationId?: string;
    service?: string;
    method?: string;
    queue?: string;
    exchange?: string;
    routingKey?: string;
    errorCode?: string;         // framework-classified, never a broker string
    errorName?: string;         // error constructor name, no message text
    outcome?: 'ok' | 'confirmed' | 'failed' | 'timeout'
            | 'retried' | 'rejected' | 'dropped' | 'unroutable';
    sizeBytes?: number;
    durationMs?: number;
    attempt?: number;
    diagnostics?: unknown;      // only ever what your serializer returns
}
```

A record example:

```json
{
  "component": "protobus",
  "level": "info",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "operation": "publish",
  "message": "published request",
  "messageType": "example.Service.DoThing",
  "messageId": "01H...",
  "correlationId": "8f3c...",
  "sizeBytes": 1234,
  "outcome": "confirmed"
}
```

### What a record never carries

Connection URLs, message headers, message bodies, protobuf-decoded values and
broker-supplied error strings are not in the field set, and fields outside the
list above are dropped rather than copied through. The only route for
payload-level material is `diagnostics`, which stays absent unless you install a
serializer (below).

Field values are normalised before they reach your sink: control characters are
collapsed to spaces so a value cannot forge a second log line, values are
truncated (256 characters; 1024 for `message`), and objects handed to a scalar
field are dropped rather than stringified.

## Receiving records

Implement `log(record)` on your sink. `IStructuredLogger` extends `ILogger`, so
the same object still satisfies every existing API.

```typescript
import { setLogger, IStructuredLogger, LogRecord } from 'protobus';
import pino from 'pino';

const logger = pino();

const sink: IStructuredLogger = {
    log: (record: LogRecord) => logger[record.level](record, record.message),
    // Required: not every framework line is structured yet, and these keep
    // working for anything that logs a plain string.
    info: (msg) => logger.info(msg),
    debug: (msg) => logger.debug(msg),
    warn: (msg) => logger.warn(msg),
    error: (msg) => logger.error(msg),
};

setLogger(sink);
```

A sink without `log()` receives the same content rendered as one line on the
matching severity method:

```
[protobus] publish: published request (messageType=example.Service.DoThing correlationId=8f3c... outcome=confirmed sizeBytes=1234)
```

`formatLogRecord(record)` is exported if you want to produce that exact text
yourself. `isStructuredLogger(sink)` reports whether a sink accepts records.

Level filtering is applied before either path, so `setLogLevel()` and
`LOG_LEVEL` behave identically for structured and string output, and a
suppressed line reaches neither.

## Opt-in payload diagnostics

Call sites can offer payload material lazily. It is assembled only when you have
installed a serializer, and what survives into the record is entirely your
decision — the framework applies no redaction to the value you return.

```typescript
import { setDiagnosticsSerializer } from 'protobus';

// Log field names only, never values.
setDiagnosticsSerializer((diagnostics) => {
    const payload = diagnostics.payload;
    if (!payload || typeof payload !== 'object') return undefined;
    return { fields: Object.keys(payload) };
});
```

The serializer receives the assembled `LogDiagnostics` (`payload`, `headers`,
`error`, plus whatever the call site adds) and a read-only copy of the record it
is about to be attached to:

```typescript
setDiagnosticsSerializer((diagnostics, record) => {
    // Full payloads for one operation, in one environment, and nothing else.
    if (process.env.NODE_ENV === 'production') return undefined;
    if (record.operation !== 'consume') return undefined;
    return { payload: diagnostics.payload };
});

setDiagnosticsSerializer(null); // back off; nothing is assembled again
```

Returning `undefined` omits the field. A serializer that throws is ignored and
the line is still emitted without diagnostics.

Whatever you return is passed to your sink as-is. Redact it there — this hook is
the point at which payloads can leave the process.

## Emitting your own records

`Log` is the structured counterpart to `Logger`, and services can use it for
their own lines:

```typescript
import { Log } from 'protobus';

Log.info('published request', {
    operation: 'publish',
    messageType: 'example.Service.DoThing',
    correlationId,
    sizeBytes: content.length,
    outcome: 'confirmed',
    diagnostics: () => ({ payload: decoded }),   // only read if a serializer is installed
});
```

The `diagnostics` thunk is not invoked unless a serializer is installed and the
line passes the level filter, so building it costs nothing when payload logging
is off.

---

Next: [Custom Logger](./custom-logger.md) | [Security Model](./security.md)
