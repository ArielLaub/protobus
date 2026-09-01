import { RunnableService } from 'protobus';
// src/calculator-service.ts

export class CalculatorService extends RunnableService {
    // The only required member. ProtoFileName comes by convention.
    public get ServiceName(): string { return 'Calculator.Math'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}
