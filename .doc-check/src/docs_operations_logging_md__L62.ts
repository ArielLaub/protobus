import { setLogger, ILogger } from 'protobus';

const sink: ILogger = {
    debug: (msg) => console.debug('[DEBUG]', msg),
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
};

setLogger(sink);
