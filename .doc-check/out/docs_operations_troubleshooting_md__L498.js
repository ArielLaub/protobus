"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
const debugLogger = {
    debug: (msg) => console.log('[DEBUG]', msg),
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
};
(0, protobus_1.setLogger)(debugLogger);
(0, protobus_1.setLogLevel)(protobus_1.LogLevel.Debug); // without this line, debug output is discarded
