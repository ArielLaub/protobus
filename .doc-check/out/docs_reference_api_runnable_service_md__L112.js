"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderService = void 0;
const protobus_1 = require("protobus");
class OrderService extends protobus_1.RunnableService {
    pool;
    get ServiceName() { return 'Orders.Service'; }
    async create(request) {
        return { id: String(request.total) };
    }
    async cleanup() {
        await this.pool.end();
    }
}
exports.OrderService = OrderService;
