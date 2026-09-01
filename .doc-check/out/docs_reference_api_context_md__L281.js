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
    // Every service and proxy in the process shares one context.
    const context = await createContext();
    const orders = new protobus_1.ServiceProxy(context, 'Orders.Service');
    const users = new protobus_1.ServiceProxy(context, 'Users.Service');
    await Promise.all([orders.init(), users.init()]);
    await context.connection.disconnect();
}
