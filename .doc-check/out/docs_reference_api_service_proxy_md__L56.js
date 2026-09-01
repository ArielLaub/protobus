"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const protobus_1 = require("protobus");
async function main() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', [__dirname + '/proto/']);
    const calculator = new protobus_1.ServiceProxy(context, 'Calculator.Math');
    await calculator.init();
    const { result } = await calculator.add({ a: 10, b: 20 });
    console.log(`10 + 20 = ${result}`);
    // A client that does not disconnect never exits: the open AMQP socket and
    // its heartbeat timer hold the event loop open.
    await context.connection.disconnect();
}
