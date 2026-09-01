import { MessageService, HandledError } from 'protobus';

class NotFoundError extends HandledError {
    constructor(id: string) { super(`order ${id} not found`, 'NOT_FOUND'); }
}

export class OrderService extends MessageService {
    public get ServiceName(): string { return 'Orders.Service'; }
    public get ProtoFileName(): string { return __dirname + '/proto/Orders.proto'; }

    async get(request: { orderId: string }): Promise<{ total: number }> {
        if (!request.orderId) {
            // Answered at once. Retrying a request with no id cannot help.
            throw new HandledError('orderId is required', 'VALIDATION_ERROR');
        }

        const order = await this.load(request.orderId);
        if (!order) throw new NotFoundError(request.orderId);

        // A throw from here — a dropped database connection, say — is an
        // infrastructure failure and DOES go round the retry ladder.
        return { total: order.total };
    }

    private async load(_id: string): Promise<{ total: number } | null> {
        return { total: 0 };
    }
}
