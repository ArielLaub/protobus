export interface ILogger {
    info(message: any): void;
    warn(message: any): void;
    debug(message: any): void;
    error(message: any): void;
}

/**
 * Severity threshold. Lower values are more verbose.
 *
 * Debug is **off by default**, because `console.debug` writes to stdout in
 * Node: anything logged at that level reaches whatever aggregator collects
 * stdout. Payload-level logging is opt-in.
 */
export enum LogLevel {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
    Silent = 100,
}

function levelFromEnv(): LogLevel {
    switch ((process.env.LOG_LEVEL || '').trim().toLowerCase()) {
        case 'debug': return LogLevel.Debug;
        case 'info': return LogLevel.Info;
        case 'warn': case 'warning': return LogLevel.Warn;
        case 'error': return LogLevel.Error;
        case 'silent': case 'off': case 'none': return LogLevel.Silent;
        default: return LogLevel.Info;
    }
}

let currentLevel: LogLevel = levelFromEnv();

/** Set the minimum severity that will be emitted. */
export function setLevel(level: LogLevel): void {
    currentLevel = level;
}

/** Current minimum severity. */
export function getLevel(): LogLevel {
    return currentLevel;
}

export class DefaultLogger implements ILogger {
    info(message: any) {
        console.log(message);
    }
    debug(message: any) {
        console.debug(message);
    }
    warn(message: any) {
        console.warn(message);
    }
    error(message: any) {
        console.error(message);
    }
}

let sink: ILogger = new DefaultLogger();

/**
 * The exported Logger applies the level filter before delegating to the sink,
 * so a custom logger installed via set() gets level filtering for free and
 * never sees suppressed messages at all.
 */
export const Logger: ILogger = {
    debug(message: any) { if (currentLevel <= LogLevel.Debug) { sink.debug(message); } },
    info(message: any) { if (currentLevel <= LogLevel.Info) { sink.info(message); } },
    warn(message: any) { if (currentLevel <= LogLevel.Warn) { sink.warn(message); } },
    error(message: any) { if (currentLevel <= LogLevel.Error) { sink.error(message); } },
};

export function set(newLogger: ILogger) {
    sink = newLogger;
}

/** Severity of a structured record, as a name rather than a threshold number. */
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

/**
 * How an operation ended. A small closed vocabulary keeps the field groupable
 * in a log aggregator; anything finer belongs in `message`.
 */
export type LogOutcome =
    | 'ok'
    | 'confirmed'
    | 'failed'
    | 'timeout'
    | 'retried'
    | 'rejected'
    | 'dropped'
    | 'unroutable';

/**
 * One framework log line as data.
 *
 * Every field is either framework-generated or a low-cardinality identifier:
 * connection URLs, message headers, payloads, protobuf-decoded values and raw
 * broker error strings are deliberately absent. The only route for any of
 * those is `diagnostics`, which stays undefined unless the application
 * installs a serializer via setDiagnosticsSerializer().
 */
export interface LogRecord {
    /** Always `protobus`, stamped here so a log line's origin is unambiguous. */
    component: 'protobus';
    level: LogLevelName;
    /** ISO 8601, generated at emit time. */
    timestamp: string;
    /** What the framework was doing: `publish`, `consume`, `connect`, … */
    operation: string;
    /** Human-readable summary; the same text the string sink would receive. */
    message: string;
    /** Fully qualified protobuf type or RPC name, e.g. `example.Service.DoThing`. */
    messageType?: string;
    messageId?: string;
    correlationId?: string;
    service?: string;
    method?: string;
    queue?: string;
    exchange?: string;
    routingKey?: string;
    /** Framework-classified code, never a broker-supplied string. */
    errorCode?: string;
    /** Error constructor name, e.g. `TimeoutError`. Carries no message text. */
    errorName?: string;
    outcome?: LogOutcome;
    sizeBytes?: number;
    durationMs?: number;
    attempt?: number;
    /** Whatever the installed diagnostics serializer returned, if anything. */
    diagnostics?: unknown;
}

/** Raw material offered to the diagnostics serializer, never logged as-is. */
export interface LogDiagnostics {
    /** Decoded message, plain object or Buffer, depending on the call site. */
    payload?: unknown;
    headers?: Record<string, unknown>;
    error?: unknown;
    [key: string]: unknown;
}

/**
 * Fields a call site attaches to a structured line. Only the properties
 * declared here reach a LogRecord; anything else is discarded, so a call site
 * cannot widen the envelope by accident.
 */
export interface LogFields {
    operation: string;
    messageType?: string;
    messageId?: string;
    correlationId?: string;
    service?: string;
    method?: string;
    queue?: string;
    exchange?: string;
    routingKey?: string;
    errorCode?: string;
    errorName?: string;
    outcome?: LogOutcome;
    sizeBytes?: number;
    durationMs?: number;
    attempt?: number;
    /**
     * Lazily produces payload-level material for the diagnostics serializer.
     * It is invoked only when a serializer is installed and the line passes the
     * level filter, so with no serializer the sensitive values are never even
     * assembled.
     */
    diagnostics?: () => LogDiagnostics;
}

/**
 * Opt-in hook that decides what, if anything, of a line's payload material is
 * safe to log. Returning undefined omits the field. The application owns the
 * redaction policy here — the framework applies none to the returned value.
 */
export type DiagnosticsSerializer = (
    diagnostics: LogDiagnostics,
    record: Readonly<LogRecord>,
) => unknown;

/** A sink that accepts records. Extends ILogger so it works everywhere ILogger does. */
export interface IStructuredLogger extends ILogger {
    log(record: LogRecord): void;
}

/** True when the sink can accept records rather than only formatted strings. */
export function isStructuredLogger(candidate: ILogger): candidate is IStructuredLogger {
    return typeof (candidate as IStructuredLogger).log === 'function';
}

let diagnosticsSerializer: DiagnosticsSerializer | null = null;

/**
 * Install (or, with null, remove) the diagnostics serializer.
 *
 * Off by default: with no serializer, no call site's payload thunk is ever
 * invoked and `diagnostics` never appears on a record.
 */
export function setDiagnosticsSerializer(serializer: DiagnosticsSerializer | null): void {
    diagnosticsSerializer = serializer;
}

/** The installed diagnostics serializer, or null when payload logging is off. */
export function getDiagnosticsSerializer(): DiagnosticsSerializer | null {
    return diagnosticsSerializer;
}

/** Order here is the field order of both the record and its formatted form. */
const TEXT_FIELDS = [
    'messageType', 'messageId', 'correlationId', 'service', 'method',
    'queue', 'exchange', 'routingKey', 'errorCode', 'errorName', 'outcome',
] as const;

const NUMERIC_FIELDS = ['sizeBytes', 'durationMs', 'attempt'] as const;

const FIELD_MAX_LENGTH = 256;
const MESSAGE_MAX_LENGTH = 1024;

/**
 * Normalise one field value, or drop it.
 *
 * Objects are rejected rather than stringified: a caller that hands an object
 * to a scalar field is most likely handing over a payload, and `String(obj)`
 * can run user code via toString(). Control characters are collapsed to spaces
 * so a value carrying a newline cannot forge a second log line, and long values
 * are truncated so one field cannot flood the log.
 */
function sanitizeValue(value: unknown, maxLength: number): string | undefined {
    if (value === null || value === undefined) return undefined;

    let text: string;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
    else if (typeof value === 'boolean' || typeof value === 'bigint') text = String(value);
    else return undefined;

    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildRecord(level: LogLevelName, message: string, fields: LogFields): LogRecord {
    const record: LogRecord = {
        component: 'protobus',
        level,
        timestamp: new Date().toISOString(),
        operation: sanitizeValue(fields?.operation, FIELD_MAX_LENGTH) || 'unknown',
        message: sanitizeValue(message, MESSAGE_MAX_LENGTH) || '',
    };

    for (const key of TEXT_FIELDS) {
        const value = sanitizeValue(fields?.[key], FIELD_MAX_LENGTH);
        if (value !== undefined) (record as any)[key] = value;
    }
    for (const key of NUMERIC_FIELDS) {
        const value = sanitizeNumber(fields?.[key]);
        if (value !== undefined) record[key] = value;
    }

    return record;
}

function stringifyDiagnostics(value: unknown): string {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? '<unserializable>' : text;
    } catch {
        return '<unserializable>';
    }
}

/**
 * Render a record as the single human-readable line a string-only sink gets.
 * Exported so an application formatting records itself can match the framework's
 * default output.
 */
export function formatLogRecord(record: LogRecord): string {
    const parts: string[] = [];

    for (const key of TEXT_FIELDS) {
        const value = record[key];
        if (value !== undefined) parts.push(`${key}=${value}`);
    }
    for (const key of NUMERIC_FIELDS) {
        const value = record[key];
        if (value !== undefined) parts.push(`${key}=${value}`);
    }
    if (record.diagnostics !== undefined) {
        parts.push(`diagnostics=${stringifyDiagnostics(record.diagnostics)}`);
    }

    const detail = parts.length ? ` (${parts.join(' ')})` : '';
    return `[${record.component}] ${record.operation}: ${record.message}${detail}`;
}

function writeText(target: ILogger, level: LogLevelName, text: string): void {
    switch (level) {
        case 'debug': target.debug(text); break;
        case 'info': target.info(text); break;
        case 'warn': target.warn(text); break;
        case 'error': target.error(text); break;
    }
}

function emit(level: LogLevelName, threshold: LogLevel, message: string, fields: LogFields): void {
    if (currentLevel > threshold) return;

    const record = buildRecord(level, message, fields);

    const serializer = diagnosticsSerializer;
    if (serializer && typeof fields?.diagnostics === 'function') {
        try {
            const extra = serializer(fields.diagnostics(), record);
            if (extra !== undefined) record.diagnostics = extra;
        } catch {
            // A failing hook, or a payload that cannot be assembled, must not
            // take down the operation being logged or swallow the line itself.
        }
    }

    const target = sink;
    if (isStructuredLogger(target)) {
        try {
            target.log(record);
            return;
        } catch {
            // A structured sink that throws degrades to the string path rather
            // than losing the line.
        }
    }

    writeText(target, level, formatLogRecord(record));
}

/**
 * Structured counterpart to Logger: the framework describes what happened as
 * data, and the sink decides the shape.
 *
 * A sink implementing IStructuredLogger receives the LogRecord through log().
 * A plain ILogger receives the same content rendered by formatLogRecord() on
 * its matching severity method, so installing a structured sink is optional and
 * changes nothing for existing loggers. Level filtering happens first either
 * way, so a suppressed line reaches neither.
 *
 * A call site looks like:
 *
 *     Log.info('published request', {
 *         operation: 'publish',
 *         messageType: 'example.Service.DoThing',
 *         correlationId,
 *         sizeBytes: content.length,
 *         outcome: 'confirmed',
 *         diagnostics: () => ({ payload: decoded }),
 *     });
 */
export const Log = {
    debug(message: string, fields: LogFields): void { emit('debug', LogLevel.Debug, message, fields); },
    info(message: string, fields: LogFields): void { emit('info', LogLevel.Info, message, fields); },
    warn(message: string, fields: LogFields): void { emit('warn', LogLevel.Warn, message, fields); },
    error(message: string, fields: LogFields): void { emit('error', LogLevel.Error, message, fields); },
};

/**
 * Strip credentials out of a broker URL so it is safe to log.
 *
 * An AMQP URL carries its password in the userinfo section
 * (`amqp://user:s3cret@host/vhost`), so logging one verbatim leaks the
 * broker credentials to wherever stdout ends up. The password is replaced
 * with `***`; the username, host, port and vhost are kept because they are
 * what makes the line useful when diagnosing a connection problem.
 *
 * Anything that does not parse as a URL is reported as `<redacted>` rather
 * than passed through — an unparseable string may still be a credential.
 */
export function redactUrl(url: string): string {
    if (!url) return String(url);

    try {
        const parsed = new URL(url);
        if (parsed.password) parsed.password = '***';
        return parsed.toString();
    } catch {
        return '<redacted>';
    }
}
