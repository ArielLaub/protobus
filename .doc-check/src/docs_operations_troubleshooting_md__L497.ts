import { setLogger, setLogLevel, LogLevel, ILogger } from 'protobus';

const debugLogger: ILogger = {
    debug: (msg) => console.log('[DEBUG]', msg),
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
};

setLogger(debugLogger);
setLogLevel(LogLevel.Debug);   // without this line, debug output is discarded
