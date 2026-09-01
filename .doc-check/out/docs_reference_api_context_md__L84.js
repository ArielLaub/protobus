"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function main() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/', [__dirname + '/proto/'], {
        reconnection: {
            maxRetries: 0, // 0 means keep retrying forever
            initialDelayMs: 500,
            maxDelayMs: 10000,
            backoffMultiplier: 2,
        },
    });
}
