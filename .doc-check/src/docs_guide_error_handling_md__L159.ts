import { RunnableService, IContext } from 'protobus';

export class OrdersService extends RunnableService {
    public get ServiceName(): string { return 'Orders.Service'; }

    constructor(context: IContext) {
        super(context, {
            maxConcurrent: 4,
            retry: {
                maxRetries: 5,      // default 3
                retryDelayMs: 2000, // default 5000
            },
        });
    }
}
