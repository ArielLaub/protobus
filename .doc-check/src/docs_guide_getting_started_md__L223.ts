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

// ---- from docs/guide/getting-started.md:181 (needs=gs-service) ----

// src/calculator-service.ts

export class CalculatorService extends RunnableService {
    constructor(context: IContext) {
        super(context);
    }

    // Required: the full service name from the proto — package + service.
    public get ServiceName(): string {
        return 'Calculator.Math';
    }

    // One method per rpc, matching the name in the proto exactly.
    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        const result = request.a + request.b;

        // Optional: tell anyone who cares that this happened.
        await this.publishEvent('Calculator.CalculationEvent', {
            operation: 'add',
            result,
        });

        return { result };
    }
}

// src/server.ts

async function main() {
    const context = await createContext();

    await RunnableService.start(context, CalculatorService, {
        maxConcurrent: 2,   // in-flight messages per process; the default is 1
    });

    console.log('Calculator service is running');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
