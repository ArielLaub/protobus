# Logging

> Levels, your own sink, structured records, and the one hook that can let payloads out of the process.

**Read this if** you are wiring protobus into your log pipeline, or you turned on debug logging and got nothing.

| | |
|---|---|
| **Prerequisites** | [Getting Started](../guide/getting-started.md) |
| **Next** | [Security](./security.md) — what a log line must never carry · [Troubleshooting](./troubleshooting.md) |
| **Source** | [`lib/logger.ts`](../../lib/logger.ts) |

**On this page** — [Levels](#levels-first) · [Your own sink](#install-your-own-sink) · [Structured records](#structured-records) · [What a record never carries](#what-a-record-never-carries) · [Payload diagnostics](#opt-in-payload-diagnostics) · [Your own records](#emitting-your-own-records) · [Testing](#silencing-it-in-tests)

---

## Levels first

> [!IMPORTANT]
> **Installing a sink does not turn on debug logging.** The level filter is
> applied *before* the sink is called ([`lib/logger.ts`](../../lib/logger.ts)),
> so a logger with a perfectly good `debug` method receives nothing until the
> level allows it. This is the single most common confusion about protobus
> logging, and the reason the old troubleshooting page told readers something
> untrue.

| Level | Value | Emitted when the level is |
|---|---:|---|
| `LogLevel.Debug` | 10 | `Debug` |
| `LogLevel.Info` | 20 | `Debug`, `Info` |
| `LogLevel.Warn` | 30 | `Debug`, `Info`, `Warn` |
| `LogLevel.Error` | 40 | anything but `Silent` |
| `LogLevel.Silent` | 100 | never |

The default is `Info`. Set it either way:

```bash
LOG_LEVEL=debug node dist/server.js   # debug | info | warn | error | silent
```

<!-- doc-check: compile -->
```typescript
import { setLogLevel, getLogLevel, LogLevel } from 'protobus';

setLogLevel(LogLevel.Debug);
console.log(getLogLevel() === LogLevel.Debug);
```

> [!CAUTION]
> Debug is off by default on purpose. `console.debug` writes to **stdout**, so
> anything logged at that level reaches whatever aggregates your process output.
> Debug lines can include payload detail. Turn it on deliberately, and read
> [Security](./security.md) first if the environment is production.

---

## Install your own sink

`ILogger` is four methods. Anything satisfying it can receive protobus's lines:

<!-- doc-check: compile -->
```typescript
import { setLogger, ILogger } from 'protobus';

const sink: ILogger = {
    debug: (msg) => console.debug('[DEBUG]', msg),
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
};

setLogger(sink);
```

Adapting a real logging library is the same four lines. Winston, Pino and Bunyan
all expose `debug` / `info` / `warn` / `error` taking a string, so:

<details>
<summary>Winston, Pino and Bunyan adapters</summary>

<!-- doc-check: ignore why="needs winston/pino/bunyan installed; the adapter shape is checked by the ILogger example above" -->
```typescript
import { setLogger, ILogger } from 'protobus';
import winston from 'winston';
import pino from 'pino';
import bunyan from 'bunyan';

const adapt = (target: {
    debug(m: string): void; info(m: string): void;
    warn(m: string): void; error(m: string): void;
}): ILogger => ({
    debug: (m) => target.debug(m),
    info: (m) => target.info(m),
    warn: (m) => target.warn(m),
    error: (m) => target.error(m),
});

setLogger(adapt(winston.createLogger({ level: 'info' })));
// or
setLogger(adapt(pino({ level: process.env.LOG_LEVEL || 'info' })));
// or
setLogger(adapt(bunyan.createLogger({ name: 'protobus', level: 'info' })));
```

</details>

> [!TIP]
> **Do not reimplement level filtering in your sink.** Protobus already applies
> it, and a second filter downstream only makes `setLogLevel` look broken. Set
> the level on protobus; let your logger do transport and formatting.

---

## Structured records

Protobus can emit its own lines as structured records instead of free text. It is
opt-in and additive: do nothing, or install a plain `ILogger`, and the
human-readable output is unchanged.

Implement `log(record)` on your sink. `IStructuredLogger` extends `ILogger`, so
one object satisfies both:

<!-- doc-check: compile -->
```typescript
import { setLogger, IStructuredLogger, LogRecord } from 'protobus';

const sink: IStructuredLogger = {
    log: (record: LogRecord) => process.stdout.write(JSON.stringify(record) + '\n'),
    // Still required: not every framework line is structured yet, and these
    // keep working for anything that logs a plain string.
    debug: (msg) => console.debug(msg),
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
};

setLogger(sink);
```

<details>
<summary>The full <code>LogRecord</code> shape</summary>

<!-- doc-check: compile -->
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

</details>

One record, as emitted:

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

A sink **without** `log()` receives the same content rendered as one line on the
matching severity method:

```
[protobus] publish: published request (messageType=example.Service.DoThing correlationId=8f3c... outcome=confirmed sizeBytes=1234)
```

`formatLogRecord(record)` is exported if you want to produce that exact text
yourself. Level filtering happens before either path, so `setLogLevel()` and
`LOG_LEVEL` behave identically for structured and string output, and a suppressed
line reaches neither.

---

## What a record never carries

Connection URLs, message headers, message bodies, protobuf-decoded values and
broker-supplied error strings are not in the field set, and fields outside the
list above are dropped rather than passed through.

Values are normalised before they reach your sink: control characters collapse to
spaces so a value cannot forge a second log line, values are truncated (256
characters; 1024 for `message`), and an object handed to a scalar field is
dropped rather than stringified.

The only route for payload-level material is `diagnostics`, which stays absent
unless you install a serializer.

---

## Opt-in payload diagnostics

Call sites can offer payload material lazily. It is assembled only once you have
installed a serializer, and what survives into the record is entirely your
decision — **the framework applies no redaction to the value you return.**

<!-- doc-check: compile -->
```typescript
import { setDiagnosticsSerializer } from 'protobus';

// Log field names only, never values.
setDiagnosticsSerializer((diagnostics) => {
    const payload = (diagnostics as { payload?: unknown }).payload;
    if (!payload || typeof payload !== 'object') { return undefined; }
    return { fields: Object.keys(payload as object) };
});
```

The serializer receives the assembled `LogDiagnostics` (`payload`, `headers`,
`error`, plus whatever the call site adds) and a read-only copy of the record it
is about to be attached to:

<!-- doc-check: compile -->
```typescript
import { setDiagnosticsSerializer } from 'protobus';

setDiagnosticsSerializer((diagnostics, record) => {
    // Full payloads for one operation, in one environment, and nothing else.
    if (process.env.NODE_ENV === 'production') { return undefined; }
    if (record.operation !== 'consume') { return undefined; }
    return { payload: (diagnostics as { payload?: unknown }).payload };
});

setDiagnosticsSerializer(null);   // back off; nothing is assembled again
```

Returning `undefined` omits the field. A serializer that throws is ignored and the
line is still emitted without diagnostics.

> [!CAUTION]
> This hook is the point at which payloads can leave the process. Whatever you
> return is passed to your sink as-is — redact it there.

---

## Emitting your own records

`Log` is the structured counterpart to `Logger`, and your services can use it for
their own lines:

<!-- doc-check: compile -->
```typescript
import { Log } from 'protobus';

export function recordPublish(correlationId: string, content: Buffer, decoded: unknown): void {
    Log.info('published request', {
        operation: 'publish',
        messageType: 'example.Service.DoThing',
        correlationId,
        sizeBytes: content.length,
        outcome: 'confirmed',
        diagnostics: () => ({ payload: decoded }),   // read only if a serializer is installed
    });
}
```

The `diagnostics` thunk is not invoked unless a serializer is installed **and**
the line passes the level filter, so building it costs nothing when payload
logging is off.

---

## Silencing it in tests

<!-- doc-check: compile -->
```typescript
import { setLogger, setLogLevel, LogLevel, ILogger } from 'protobus';

const silent: ILogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export function quietProtobus(): void {
    setLogger(silent);
    setLogLevel(LogLevel.Silent);
}
```

Either alone is enough; both together also stop anything reaching the default
console sink if a later test replaces the logger. See [Testing](../guide/testing.md).

---

<div align="center">

**[← Queue Migration](./queue-migration.md)** · **[Docs index](../README.md)** · **[Security →](./security.md)**

</div>
