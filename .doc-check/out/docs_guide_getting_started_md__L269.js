"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContext = createContext;
const protobus_1 = require("protobus");
// ---- from docs/guide/getting-started.md:156 (needs=gs-context) ----
// src/context.ts
async function createContext() {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];
    const context = new protobus_1.Context();
    await context.init(AMQP_URL, PROTO_PATHS);
    return context;
}
async function main() {
    const context = await createContext();
    const calculator = new protobus_1.ServiceProxy(context, 'Calculator.Math');
    await calculator.init();
    const response = await calculator.add({ a: 5, b: 3 });
    console.log(`5 + 3 = ${response.result}`);
    // Close the connection, or the process never exits: an open AMQP socket and
    // its heartbeat timer keep the event loop alive indefinitely.
    await context.connection.disconnect();
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
