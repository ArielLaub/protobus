import { RunnableService, Context } from 'protobus';
// ---- from docs/guide/events.md:66 (needs=ev-subscriber-class) ----


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


async function main(): Promise<void> {
    const context = new Context();
    await context.init(
        process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/',
        [__dirname + '/proto/'],
    );

    const subscriber = new NotificationService(context);
    await subscriber.init();

    await subscriber.subscribeEvent('Orders.OrderShipped', async (event) => {
        console.log('shipped', event.order_id);
    }, 'ORDERS.*.SHIPPED');

    console.log('listening');

    // A long-lived listener stays here. A short-lived script must disconnect,
    // or the process never exits.
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    await context.connection.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
