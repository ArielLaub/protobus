import { IContext, ServiceProxy } from 'protobus';

interface Users { getUser(req: { id: string }): Promise<{ id: string }>; }
interface Orders { createOrder(req: { userId: string }): Promise<{ orderId: string }>; }

export class Clients {
    users: ServiceProxy & Users;
    orders: ServiceProxy & Orders;

    constructor(context: IContext) {
        this.users = new ServiceProxy(context, 'Users.Service') as ServiceProxy & Users;
        this.orders = new ServiceProxy(context, 'Orders.Service') as ServiceProxy & Orders;
    }

    async init(): Promise<void> {
        // They share one context, so one connection and one callback queue.
        await Promise.all([this.users.init(), this.orders.init()]);
    }
}
