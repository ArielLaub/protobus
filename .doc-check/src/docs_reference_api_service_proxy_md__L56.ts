import { Context, ServiceProxy } from 'protobus';

export interface CalculatorMath {
    add(request: { a: number; b: number }, actor?: string): Promise<{ result: number }>;
    divide(request: { a: number; b: number }, actor?: string): Promise<{ result: number }>;
}

export async function main() {
    const context = new Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', [__dirname + '/proto/']);

    const calculator = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calculator.init();

    const { result } = await calculator.add({ a: 10, b: 20 });
    console.log(`10 + 20 = ${result}`);

    // A client that does not disconnect never exits: the open AMQP socket and
    // its heartbeat timer hold the event loop open.
    await context.connection.disconnect();
}
