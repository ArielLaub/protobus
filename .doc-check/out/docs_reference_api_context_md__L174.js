"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContext = createContext;
const protobus_1 = require("protobus");
// ---- from docs/reference/api/context.md:62 (needs=ctx-create) ----
// src/context.ts
async function createContext() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/', [__dirname + '/proto/', '/shared/proto/']);
    return context;
}
async function main() {
    const context = await createContext();
    // Was the schema actually loaded? A `false` here is why a service's init()
    // will throw MissingProto later.
    if (!context.factory.hasService('Calculator.Math')) {
        throw new Error('Calculator.proto was not on any of the proto paths');
    }
    console.log(context.factory.getServiceMethodNames('Calculator.Math'));
    await context.connection.disconnect();
}
