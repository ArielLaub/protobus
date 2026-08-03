export interface ILogger {
    info(message: any): void;
    warn(message: any): void;
    debug(message: any): void;
    error(message: any): void;
}

/**
 * Severity threshold. Lower values are more verbose.
 *
 * Debug is **off by default**. It used to be unconditional — `console.debug`
 * writes to stdout in Node — and several call sites logged full request and
 * response payloads through it, so any deployment shipping stdout to a log
 * aggregator was also shipping every credential and personal detail that
 * crossed the bus. Payload-level logging is now opt-in.
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
