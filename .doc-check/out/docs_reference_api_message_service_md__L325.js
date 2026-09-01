"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderService = void 0;
const protobus_1 = require("protobus");
class NotFoundError extends protobus_1.HandledError {
    constructor(id) { super(`order ${id} not found`, 'NOT_FOUND'); }
}
class OrderService extends protobus_1.MessageService {
    get ServiceName() { return 'Orders.Service'; }
    get ProtoFileName() { return __dirname + '/proto/Orders.proto'; }
    async get(request) {
        if (!request.orderId) {
            // Answered at once. Retrying a request with no id cannot help.
            throw new protobus_1.HandledError('orderId is required', 'VALIDATION_ERROR');
        }
        const order = await this.load(request.orderId);
        if (!order)
            throw new NotFoundError(request.orderId);
        // A throw from here — a dropped database connection, say — is an
        // infrastructure failure and DOES go round the retry ladder.
        return { total: order.total };
    }
    async load(_id) {
        return { total: 0 };
    }
}
exports.OrderService = OrderService;
