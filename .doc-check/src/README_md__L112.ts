import { Context, ServiceProxy } from 'protobus';
// src/client.ts

interface CalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

async function main() {
    const context = new Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto']);

    const calculator = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calculator.init();

    const response = await calculator.add({ a: 5, b: 3 });
    console.log(`5 + 3 = ${response.result}`);

    // A client must close, or the open AMQP socket keeps the process alive.
    await context.connection.disconnect();
}

main().catch((error) => { console.error(error); process.exit(1); });
