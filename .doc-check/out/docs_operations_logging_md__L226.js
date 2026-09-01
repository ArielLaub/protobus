"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
// Log field names only, never values.
(0, protobus_1.setDiagnosticsSerializer)((diagnostics) => {
    const payload = diagnostics.payload;
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    return { fields: Object.keys(payload) };
});
