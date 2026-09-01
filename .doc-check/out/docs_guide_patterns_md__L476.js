"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireFields = requireFields;
const protobus_1 = require("protobus");
function requireFields(request, fields) {
    const missing = fields.filter((f) => request[f] === undefined || request[f] === null);
    if (missing.length) {
        throw new protobus_1.HandledError(`missing required field(s): ${missing.join(', ')}`, 'VALIDATION_ERROR');
    }
}
