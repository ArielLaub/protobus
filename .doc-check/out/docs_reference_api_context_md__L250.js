"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function main() {
    const context = new protobus_1.Context();
    try {
        await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto/']);
    }
    catch (error) {
        if (error?.code === 'ECONNREFUSED') {
            console.error('RabbitMQ is not reachable');
        }
        else if (error instanceof protobus_1.ReconnectionError) {
            console.error('gave up reconnecting');
        }
        else {
            console.error(`schema or broker setup failed: ${error?.message}`);
        }
        process.exit(1);
    }
}
