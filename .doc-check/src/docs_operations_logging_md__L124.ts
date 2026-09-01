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
