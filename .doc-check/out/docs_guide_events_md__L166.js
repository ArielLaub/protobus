"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class AnalyticsService extends protobus_1.RunnableService {
    get ServiceName() { return 'Analytics.Service'; }
    async init() {
        await super.init();
        // Default topic: binds EVENT.Orders.OrderCreated.
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            console.log('created', event.order_id);
        });
        // Explicit topic with a wildcard: binds ORDERS.*.SHIPPED.
        await this.subscribeEvent('Orders.OrderShipped', async (event, type, topic) => {
            console.log(`${type} on ${topic}: ${event.order_id}`);
        }, 'ORDERS.*.SHIPPED');
    }
}
