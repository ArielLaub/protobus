import { Context, IContext } from 'protobus';
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
    const context = await createContext();

    // ... do the work ...

    // Without this the process hangs: the open AMQP socket and its heartbeat
    // timer keep the event loop alive indefinitely.
    await context.connection.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
