"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContext = createContext;
const protobus_1 = require("protobus");
// src/context.ts
async function createContext() {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];
    const context = new protobus_1.Context();
    await context.init(AMQP_URL, PROTO_PATHS);
    return context;
}
