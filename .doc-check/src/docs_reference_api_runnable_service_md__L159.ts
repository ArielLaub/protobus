import { RunnableService, Context } from 'protobus';
// ---- from docs/reference/api/runnable-service.md:31 (needs=rs-service) ----

// src/calculator-service.ts

export class CalculatorService extends RunnableService {
    // The only required member. ProtoFileName comes by convention.
    public get ServiceName(): string { return 'Calculator.Math'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}

// src/server.ts

async function main() {
    const context = new Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', [__dirname + '/proto/']);

    await RunnableService.start(
        context,
        CalculatorService,
        { maxConcurrent: 10 },
        async (service) => {
            await service.subscribeEvent('Audit.LogEvent', async (event) => {
                console.log('audit', event);
            });
        },
    );

    console.log('Calculator service is running');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
