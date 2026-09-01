"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
const sink = {
    log: (record) => process.stdout.write(JSON.stringify(record) + '\n'),
    // Still required: not every framework line is structured yet, and these
    // keep working for anything that logs a plain string.
    debug: (msg) => console.debug(msg),
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
};
(0, protobus_1.setLogger)(sink);
