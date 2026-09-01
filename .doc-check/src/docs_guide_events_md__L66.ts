import { RunnableService } from 'protobus';

class NotificationService extends RunnableService {
    public get ServiceName(): string { return 'Notifications.Service'; }

    public async init(): Promise<void> {
        // Must come first. subscribeEvent binds a queue that does not exist
        // until MessageService.init() has declared it.
        await super.init();

        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            console.log(`order ${event.order_id} for user ${event.user_id}`);
        });
    }
}
