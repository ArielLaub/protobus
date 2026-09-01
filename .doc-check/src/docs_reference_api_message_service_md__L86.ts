import { MessageService, IContext } from 'protobus';
// src/calculator-service.ts

export class CalculatorService extends MessageService {
    public get ServiceName(): string { return 'Calculator.Math'; }
    public get ProtoFileName(): string { return __dirname + '/proto/Calculator.proto'; }

    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }
}

export function build(context: IContext): CalculatorService {
    return new CalculatorService(context, {
        maxConcurrent: 10,
        retry: { maxRetries: 5, retryDelayMs: 2000 },
    });
}
