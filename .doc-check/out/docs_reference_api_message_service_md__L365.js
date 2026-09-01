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
async function shutdown(context, service) {
    await service.stopConsuming(); // no new work
    await context.connection.drainInFlight(30000); // let current work finish
    await context.connection.disconnect(); // then close the socket
}
