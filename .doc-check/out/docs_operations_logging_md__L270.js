"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordPublish = recordPublish;
const protobus_1 = require("protobus");
function recordPublish(correlationId, content, decoded) {
    protobus_1.Log.info('published request', {
        operation: 'publish',
        messageType: 'example.Service.DoThing',
        correlationId,
        sizeBytes: content.length,
        outcome: 'confirmed',
        diagnostics: () => ({ payload: decoded }), // read only if a serializer is installed
    });
}
