import { RunnableService } from 'protobus';

class OrderService extends RunnableService {
    public get ServiceName(): string { return 'Orders.Service'; }

    async createOrder(request: { user_id: string }): Promise<{ order_id: string }> {
        const orderId = 'ord-123';

        // Default topic: EVENT.Orders.OrderCreated
        await this.publishEvent('Orders.OrderCreated', {
            order_id: orderId,
            user_id: request.user_id,
        });

        return { order_id: orderId };
    }

    async shipOrder(request: { order_id: string; region: string }): Promise<{ ok: boolean }> {
        // Custom topic, so subscribers can filter by region without decoding.
        await this.publishEvent(
            'Orders.OrderShipped',
            { order_id: request.order_id },
            `ORDERS.${request.region}.SHIPPED`,
        );

        return { ok: true };
    }
}
