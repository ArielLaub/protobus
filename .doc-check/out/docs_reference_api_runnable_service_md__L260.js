"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatorService = void 0;
const protobus_1 = require("protobus");
// ---- from docs/reference/api/runnable-service.md:31 (needs=rs-service) ----
// src/calculator-service.ts
class CalculatorService extends protobus_1.RunnableService {
    // The only required member. ProtoFileName comes by convention.
    get ServiceName() { return 'Calculator.Math'; }
    async add(request) {
        return { result: request.a + request.b };
    }
}
exports.CalculatorService = CalculatorService;
async function run(context) {
    const service = new CalculatorService(context, { maxConcurrent: 4 });
    await service.init();
    // ... and on the way out, in this order:
    await service.stopConsuming();
    await context.connection.drainInFlight(30000);
    await context.connection.disconnect();
}
