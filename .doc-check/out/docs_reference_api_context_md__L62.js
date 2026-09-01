"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContext = createContext;
const protobus_1 = require("protobus");
// src/context.ts
async function createContext() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/', [__dirname + '/proto/', '/shared/proto/']);
    return context;
}
