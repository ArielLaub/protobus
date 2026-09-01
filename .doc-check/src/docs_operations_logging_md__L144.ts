
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
