"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatorService = void 0;
exports.build = build;
const protobus_1 = require("protobus");
// ---- from docs/reference/api/message-service.md:86 (needs=ms-service) ----
// src/calculator-service.ts
class CalculatorService extends protobus_1.MessageService {
    get ServiceName() { return 'Calculator.Math'; }
    get ProtoFileName() { return __dirname + '/proto/Calculator.proto'; }
    async add(request) {
        return { result: request.a + request.b };
    }
}
exports.CalculatorService = CalculatorService;
function build(context) {
    return new CalculatorService(context, {
        maxConcurrent: 10,
        retry: { maxRetries: 5, retryDelayMs: 2000 },
    });
}
async function main(context) {
    const service = new CalculatorService(context);
    await service.init(); // first
    await service.subscribeEvent('Audit.LogEvent', async (event, type, topic) => {
        console.log(`${type} on ${topic}`, event);
    });
    // Wildcards are RabbitMQ topic patterns: * is one segment, # is any number.
    await service.subscribeEvent('Orders.OrderEvent', async (event) => {
        console.log('a US order shipped', event);
    }, 'ORDERS.US.*');
}
