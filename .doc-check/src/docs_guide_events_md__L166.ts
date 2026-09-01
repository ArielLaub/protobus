import { RunnableService } from 'protobus';

class AnalyticsService extends RunnableService {
    public get ServiceName(): string { return 'Analytics.Service'; }

    public async init(): Promise<void> {
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
