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
    // ... do the work ...
    // Without this the process hangs: the open AMQP socket and its heartbeat
    // timer keep the event loop alive indefinitely.
    await context.connection.disconnect();
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
