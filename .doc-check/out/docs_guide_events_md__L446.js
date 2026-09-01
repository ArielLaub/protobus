"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class OrdersService extends protobus_1.RunnableService {
    get ServiceName() { return 'Orders.Service'; }
    async createOrder(request) {
        const orderId = 'ord-123';
        // Everything a subscriber could want, in the event itself.
        await this.publishEvent('Orders.OrderCreated', {
            order_id: orderId,
            user_id: request.user_id,
            created_at: Date.now(),
            skus: request.skus,
        });
        return { order_id: orderId };
    }
    async shipOrder(request) {
        // The region goes in the TOPIC, so a subscriber can filter on it
        // without decoding anything.
        await this.publishEvent('Orders.OrderShipped', {
            order_id: request.order_id,
            carrier: request.carrier,
            region: request.region,
        }, `ORDERS.${request.region}.SHIPPED`);
        return { ok: true };
    }
}
class EmailService extends protobus_1.RunnableService {
    get ServiceName() { return 'Email.Service'; }
    async init() {
        await super.init();
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.send(event.user_id, event.order_id);
            }
            catch (error) {
                // No retry exists above this line.
                console.error('email failed for', event.order_id, error);
            }
        });
    }
    async send(_userId, _orderId) { }
}
class ShipmentTracker extends protobus_1.RunnableService {
    get ServiceName() { return 'Tracking.Service'; }
    async init() {
        await super.init();
        // Region-scoped: ORDERS.US.SHIPPED matches, ORDERS.EU.SHIPPED does not.
        await this.subscribeEvent('Orders.OrderShipped', async (event, type) => {
            // The topic decides which handler runs; the type never does.
            if (type !== 'Orders.OrderShipped')
                return;
            console.log('US shipment', event.order_id, event.carrier);
        }, 'ORDERS.US.SHIPPED');
    }
}
