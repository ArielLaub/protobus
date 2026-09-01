import { RunnableService, IContext } from 'protobus';
// ---- from docs/reference/api/runnable-service.md:31 (needs=rs-service) ----

// src/calculator-service.ts

export class CalculatorService extends RunnableService {
    // The only required member. ProtoFileName comes by convention.
    public get ServiceName(): string { return 'Calculator.Math'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}


async function run(context: IContext) {
    const service = new CalculatorService(context, { maxConcurrent: 4 });
    await service.init();

    // ... and on the way out, in this order:
    await service.stopConsuming();
    await context.connection.drainInFlight(30000);
    await context.connection.disconnect();
}
