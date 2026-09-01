import { HandledError, RunnableService } from 'protobus';

export class OrderService extends RunnableService {
    public get ServiceName(): string { return 'Orders.Service'; }

    async createOrder(request: { orderId?: string }): Promise<{ ok: boolean }> {
        if (!request.orderId) {
            throw new HandledError('orderId is required', 'VALIDATION_ERROR');
        }
        return { ok: true };
    }
}
