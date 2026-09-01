"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function main() {
    const context = new protobus_1.Context();
    // The schema is in the root before any service asks for it, so the
    // convention-derived filename is never read from disk.
    await context.init('amqp://localhost', [__dirname + '/proto/']);
}
