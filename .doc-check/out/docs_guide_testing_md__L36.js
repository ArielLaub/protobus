"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrdersService = void 0;
exports.stubContext = stubContext;
const protobus_1 = require("protobus");
/** Enough of a context to construct a service. Never call init() on this. */
function stubContext() {
    return { connection: { on() { }, removeListener() { } } };
}
class OrdersService extends protobus_1.MessageService {
    get ServiceName() { return 'Orders.Service'; }
    get ProtoFileName() { return 'Orders.proto'; }
    async create(request) {
        if (!request.customerId)
            throw new protobus_1.HandledError('customerId is required', 'VALIDATION_ERROR');
        return { id: `order-${request.customerId}`, cents: request.cents ?? 0 };
    }
}
exports.OrdersService = OrdersService;
