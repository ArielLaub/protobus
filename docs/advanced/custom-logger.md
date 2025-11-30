# Custom Logger

Integrate your preferred logging library with Protobus.

## Logger Interface

```typescript
interface ILogger {
    info(message: string): void;
    debug(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
```

## Setting a Custom Logger

```typescript
import { setLogger, ILogger } from 'protobus';

const myLogger: ILogger = {
    info: (msg) => console.log('[INFO]', msg),
    debug: (msg) => console.debug('[DEBUG]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg)
};

setLogger(myLogger);
```

## Integration Examples

### Winston

```typescript
import winston from 'winston';
import { setLogger, ILogger } from 'protobus';

const winstonLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'protobus.log' })
    ]
});

const protobusLogger: ILogger = {
    info: (msg) => winstonLogger.info(msg),
    debug: (msg) => winstonLogger.debug(msg),
    warn: (msg) => winstonLogger.warn(msg),
    error: (msg) => winstonLogger.error(msg)
};

setLogger(protobusLogger);
```

### Pino

```typescript
import pino from 'pino';
import { setLogger, ILogger } from 'protobus';

const pinoLogger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

const protobusLogger: ILogger = {
    info: (msg) => pinoLogger.info(msg),
    debug: (msg) => pinoLogger.debug(msg),
    warn: (msg) => pinoLogger.warn(msg),
    error: (msg) => pinoLogger.error(msg)
};

setLogger(protobusLogger);
```

### Bunyan

```typescript
import bunyan from 'bunyan';
import { setLogger, ILogger } from 'protobus';

const bunyanLogger = bunyan.createLogger({
    name: 'protobus',
    level: 'info'
});

const protobusLogger: ILogger = {
    info: (msg) => bunyanLogger.info(msg),
    debug: (msg) => bunyanLogger.debug(msg),
    warn: (msg) => bunyanLogger.warn(msg),
    error: (msg) => bunyanLogger.error(msg)
};

setLogger(protobusLogger);
```

### Console with Timestamps

```typescript
import { setLogger, ILogger } from 'protobus';

const timestamp = () => new Date().toISOString();

const protobusLogger: ILogger = {
    info: (msg) => console.log(`[${timestamp()}] [INFO] ${msg}`),
    debug: (msg) => console.debug(`[${timestamp()}] [DEBUG] ${msg}`),
    warn: (msg) => console.warn(`[${timestamp()}] [WARN] ${msg}`),
    error: (msg) => console.error(`[${timestamp()}] [ERROR] ${msg}`)
};

setLogger(protobusLogger);
```

## Structured Logging

For better log analysis, use structured logging:

```typescript
import { setLogger, ILogger } from 'protobus';

const structuredLogger: ILogger = {
    info: (msg) => console.log(JSON.stringify({
        level: 'info',
        timestamp: new Date().toISOString(),
        service: 'protobus',
        message: msg
    })),
    debug: (msg) => console.log(JSON.stringify({
        level: 'debug',
        timestamp: new Date().toISOString(),
        service: 'protobus',
        message: msg
    })),
    warn: (msg) => console.log(JSON.stringify({
        level: 'warn',
        timestamp: new Date().toISOString(),
        service: 'protobus',
        message: msg
    })),
    error: (msg) => console.log(JSON.stringify({
        level: 'error',
        timestamp: new Date().toISOString(),
        service: 'protobus',
        message: msg
    }))
};

setLogger(structuredLogger);
```

## Conditional Logging

```typescript
import { setLogger, ILogger } from 'protobus';

const logLevel = process.env.LOG_LEVEL || 'info';
const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[logLevel] || 1;

const conditionalLogger: ILogger = {
    info: (msg) => {
        if (currentLevel <= levels.info) {
            console.log('[INFO]', msg);
        }
    },
    debug: (msg) => {
        if (currentLevel <= levels.debug) {
            console.log('[DEBUG]', msg);
        }
    },
    warn: (msg) => {
        if (currentLevel <= levels.warn) {
            console.warn('[WARN]', msg);
        }
    },
    error: (msg) => {
        if (currentLevel <= levels.error) {
            console.error('[ERROR]', msg);
        }
    }
};

setLogger(conditionalLogger);
```

## Silent Logger (Testing)

```typescript
import { setLogger, ILogger } from 'protobus';

const silentLogger: ILogger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {}
};

// Use in tests
beforeEach(() => {
    setLogger(silentLogger);
});
```

## Logger with Context

```typescript
import { setLogger, ILogger } from 'protobus';

function createContextLogger(context: Record<string, any>): ILogger {
    const log = (level: string, msg: string) => {
        console.log(JSON.stringify({
            level,
            timestamp: new Date().toISOString(),
            ...context,
            message: msg
        }));
    };

    return {
        info: (msg) => log('info', msg),
        debug: (msg) => log('debug', msg),
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg)
    };
}

// Usage
setLogger(createContextLogger({
    service: 'order-service',
    version: '1.0.0',
    environment: process.env.NODE_ENV
}));
```

---

Next: [Error Handling](./error-handling.md) | [Configuration](../configuration.md)
