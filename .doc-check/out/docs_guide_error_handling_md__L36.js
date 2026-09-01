"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderService = void 0;
const protobus_1 = require("protobus");
class OrderService extends protobus_1.RunnableService {
    get ServiceName() { return 'Orders.Service'; }
    async createOrder(request) {
        if (!request.orderId) {
            throw new protobus_1.HandledError('orderId is required', 'VALIDATION_ERROR');
        }
        return { ok: true };
    }
}
exports.OrderService = OrderService;
