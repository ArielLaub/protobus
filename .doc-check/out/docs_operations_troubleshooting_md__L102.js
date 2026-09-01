"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function main() {
    const context = new protobus_1.Context();
    await context.init('amqp://localhost', ['./proto']);
    const calc = new protobus_1.ServiceProxy(context, 'Calculator.Math');
    await calc.init();
    console.log(await calc.add({ a: 5, b: 3 }));
    await context.connection.disconnect(); // this is the missing line
}
main().catch((error) => { console.error(error); process.exit(1); });
