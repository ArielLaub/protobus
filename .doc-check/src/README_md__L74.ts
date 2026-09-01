import { RunnableService } from 'protobus';
// src/calculator-service.ts

export class CalculatorService extends RunnableService {
    public get ServiceName(): string { return 'Calculator.Math'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}
