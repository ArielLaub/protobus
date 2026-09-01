"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
(0, protobus_1.setDiagnosticsSerializer)((diagnostics, record) => {
    // Full payloads for one operation, in one environment, and nothing else.
    if (process.env.NODE_ENV === 'production') {
        return undefined;
    }
    if (record.operation !== 'consume') {
        return undefined;
    }
    return { payload: diagnostics.payload };
});
(0, protobus_1.setDiagnosticsSerializer)(null); // back off; nothing is assembled again
