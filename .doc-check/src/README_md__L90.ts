import { RunnableService, Context } from 'protobus';
// ---- from README.md:74 (needs=rm-service) ----

// src/calculator-service.ts

export class CalculatorService extends RunnableService {
    public get ServiceName(): string { return 'Calculator.Math'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}

// src/server.ts

async function main() {
    const context = new Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto']);

    await RunnableService.start(context, CalculatorService);
    console.log('Calculator.Math is up');
}

main().catch((error) => { console.error(error); process.exit(1); });
