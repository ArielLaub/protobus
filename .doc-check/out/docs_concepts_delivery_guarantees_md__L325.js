"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class ValidationError extends protobus_1.HandledError {
    constructor(message) {
        super(message, 'VALIDATION_ERROR');
    }
}
async function createOrder(request) {
    if (!request.customerId) {
        // Answered immediately. No retry, no DLQ entry, no parked caller.
        throw new ValidationError('customerId is required');
    }
    return { id: 'order-1' };
}
