"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
// ---- from docs/guide/events.md:66 (needs=ev-subscriber-class) ----
class NotificationService extends protobus_1.RunnableService {
    get ServiceName() { return 'Notifications.Service'; }
    async init() {
        // Must come first. subscribeEvent binds a queue that does not exist
        // until MessageService.init() has declared it.
        await super.init();
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            console.log(`order ${event.order_id} for user ${event.user_id}`);
        });
    }
}
async function main() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/', [__dirname + '/proto/']);
    const subscriber = new NotificationService(context);
    await subscriber.init();
    await subscriber.subscribeEvent('Orders.OrderShipped', async (event) => {
        console.log('shipped', event.order_id);
    }, 'ORDERS.*.SHIPPED');
    console.log('listening');
    // A long-lived listener stays here. A short-lived script must disconnect,
    // or the process never exits.
    await new Promise((resolve) => process.once('SIGINT', () => resolve()));
    await context.connection.disconnect();
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
