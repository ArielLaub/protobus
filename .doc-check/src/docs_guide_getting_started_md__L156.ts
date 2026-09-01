import { Context, IContext } from 'protobus';
// src/context.ts

export async function createContext(): Promise<IContext> {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];

    const context = new Context();
    await context.init(AMQP_URL, PROTO_PATHS);

    return context;
}
