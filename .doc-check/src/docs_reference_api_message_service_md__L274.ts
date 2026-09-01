import { MessageService, IContext } from 'protobus';
// ---- from docs/reference/api/message-service.md:86 (needs=ms-service) ----

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


async function main(context: IContext) {
    const service = new CalculatorService(context);
    await service.init();          // first

    await service.subscribeEvent('Audit.LogEvent', async (event, type, topic) => {
        console.log(`${type} on ${topic}`, event);
    });

    // Wildcards are RabbitMQ topic patterns: * is one segment, # is any number.
    await service.subscribeEvent('Orders.OrderEvent', async (event) => {
        console.log('a US order shipped', event);
    }, 'ORDERS.US.*');
}
