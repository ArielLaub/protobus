"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
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
