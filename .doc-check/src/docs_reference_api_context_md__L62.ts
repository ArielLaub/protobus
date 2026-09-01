import { Context, IContext } from 'protobus';
// src/context.ts

export async function createContext(): Promise<IContext> {
    const context = new Context();

    await context.init(
        process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/',
        [__dirname + '/proto/', '/shared/proto/'],
    );

    return context;
}
