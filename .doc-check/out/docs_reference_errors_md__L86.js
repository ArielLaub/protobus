"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class ValidationError extends protobus_1.HandledError {
    constructor(field) {
        super(`${field} is required`, 'VALIDATION_ERROR');
    }
}
class OrdersService extends protobus_1.MessageService {
    async create(request) {
        if (!request.customerId)
            throw new ValidationError('customerId');
        return { id: 'order-1' };
    }
}
// Duck-typed: no inheritance required, only the flag.
const foreign = Object.assign(new Error('rejected by the payment gateway'), {
    isHandled: true,
    code: 'PAYMENT_DECLINED',
});
console.log((0, protobus_1.isHandledError)(foreign)); // true
