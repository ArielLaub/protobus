import { Context, IContext, RunnableService } from 'protobus';
// ---- from docs/guide/getting-started.md:156 (needs=gs-context) ----

// src/context.ts

export async function createContext(): Promise<IContext> {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];

    const context = new Context();
    await context.init(AMQP_URL, PROTO_PATHS);

    return context;
}

// src/event-subscriber.ts

class EventSubscriber extends RunnableService {
    public get ServiceName(): string { return 'Calculator.Subscriber'; }

    constructor(context: IContext) {
        super(context);
    }
}

async function main() {
    const context = await createContext();

    const subscriber = new EventSubscriber(context);
    await subscriber.init();

    await subscriber.subscribeEvent('Calculator.CalculationEvent', async (event) => {
        console.log(`Received event: ${event.operation} = ${event.result}`);
    });

    console.log('Listening for events...');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
