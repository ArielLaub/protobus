import { RunnableService, IContext } from 'protobus';
// after — one service per process

class OrdersService extends RunnableService {
    get ServiceName(): string { return 'Orders.Service'; }
}

export async function boot(context: IContext): Promise<void> {
    await RunnableService.start(context, OrdersService, { maxConcurrent: 2 });
}
