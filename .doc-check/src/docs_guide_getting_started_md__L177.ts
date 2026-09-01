import { RunnableService, IContext } from 'protobus';
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
