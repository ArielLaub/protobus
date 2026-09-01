import { Context, IContext, ServiceProxy } from 'protobus';
// ---- from docs/reference/api/context.md:62 (needs=ctx-create) ----

// src/context.ts

export async function createContext(): Promise<IContext> {
    const context = new Context();

    await context.init(
        process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/',
        [__dirname + '/proto/', '/shared/proto/'],
    );

    return context;
}


async function main() {
    // Every service and proxy in the process shares one context.
    const context = await createContext();

    const orders = new ServiceProxy(context, 'Orders.Service');
    const users = new ServiceProxy(context, 'Users.Service');
    await Promise.all([orders.init(), users.init()]);

    await context.connection.disconnect();
}
