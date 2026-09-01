import { Context, IContext, ServiceProxy } from 'protobus';
// ---- from docs/guide/getting-started.md:156 (needs=gs-context) ----

// src/context.ts

export async function createContext(): Promise<IContext> {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];

    const context = new Context();
    await context.init(AMQP_URL, PROTO_PATHS);

    return context;
}

// src/client.ts

// ServiceProxy builds its methods from the schema at init(), so TypeScript
// cannot know them ahead of time. Declare the shape you expect and intersect
// it — `npx protobus generate` writes this interface for you.
interface CalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

async function main() {
    const context = await createContext();

    const calculator = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calculator.init();

    const response = await calculator.add({ a: 5, b: 3 });
    console.log(`5 + 3 = ${response.result}`);

    // Close the connection, or the process never exits: an open AMQP socket and
    // its heartbeat timer keep the event loop alive indefinitely.
    await context.connection.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
