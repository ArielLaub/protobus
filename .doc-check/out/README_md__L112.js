"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function main() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto']);
    const calculator = new protobus_1.ServiceProxy(context, 'Calculator.Math');
    await calculator.init();
    const response = await calculator.add({ a: 5, b: 3 });
    console.log(`5 + 3 = ${response.result}`);
    // A client must close, or the open AMQP socket keeps the process alive.
    await context.connection.disconnect();
}
main().catch((error) => { console.error(error); process.exit(1); });
