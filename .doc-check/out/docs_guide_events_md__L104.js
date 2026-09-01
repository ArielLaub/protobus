"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class OrderService extends protobus_1.RunnableService {
    get ServiceName() { return 'Orders.Service'; }
    async createOrder(request) {
        const orderId = 'ord-123';
        // Default topic: EVENT.Orders.OrderCreated
        await this.publishEvent('Orders.OrderCreated', {
            order_id: orderId,
            user_id: request.user_id,
        });
        return { order_id: orderId };
    }
    async shipOrder(request) {
        // Custom topic, so subscribers can filter by region without decoding.
        await this.publishEvent('Orders.OrderShipped', { order_id: request.order_id }, `ORDERS.${request.region}.SHIPPED`);
        return { ok: true };
    }
}
