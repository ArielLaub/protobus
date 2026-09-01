import { Context, ServiceProxy } from 'protobus';

interface CalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

async function main() {
    const context = new Context();
    await context.init('amqp://localhost', ['./proto']);

    const calc = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calc.init();
    console.log(await calc.add({ a: 5, b: 3 }));

    await context.connection.disconnect();   // this is the missing line
}

main().catch((error) => { console.error(error); process.exit(1); });
