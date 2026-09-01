import { HandledError, IContext, MessageService } from 'protobus';

/** Enough of a context to construct a service. Never call init() on this. */
export function stubContext(): IContext {
    return { connection: { on() { /* no-op */ }, removeListener() { /* no-op */ } } } as unknown as IContext;
}

export class OrdersService extends MessageService {
    get ServiceName() { return 'Orders.Service'; }
    get ProtoFileName() { return 'Orders.proto'; }

    async create(request: { customerId?: string; cents?: number }) {
        if (!request.customerId) throw new HandledError('customerId is required', 'VALIDATION_ERROR');
        return { id: `order-${request.customerId}`, cents: request.cents ?? 0 };
    }
}
