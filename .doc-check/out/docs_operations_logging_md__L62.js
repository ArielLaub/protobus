"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
const sink = {
    debug: (msg) => console.debug('[DEBUG]', msg),
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
};
(0, protobus_1.setLogger)(sink);
