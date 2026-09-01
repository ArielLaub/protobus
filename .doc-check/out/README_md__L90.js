"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatorService = void 0;
const protobus_1 = require("protobus");
// ---- from README.md:74 (needs=rm-service) ----
// src/calculator-service.ts
class CalculatorService extends protobus_1.RunnableService {
    get ServiceName() { return 'Calculator.Math'; }
    async add(request) {
        return { result: request.a + request.b };
    }
}
exports.CalculatorService = CalculatorService;
// src/server.ts
async function main() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto']);
    await protobus_1.RunnableService.start(context, CalculatorService);
    console.log('Calculator.Math is up');
}
main().catch((error) => { console.error(error); process.exit(1); });
