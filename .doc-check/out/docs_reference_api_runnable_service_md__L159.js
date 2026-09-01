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
// src/server.ts
async function main() {
    const context = new protobus_1.Context();
    await context.init(process.env.AMQP_URL || 'amqp://localhost', [__dirname + '/proto/']);
    await protobus_1.RunnableService.start(context, CalculatorService, { maxConcurrent: 10 }, async (service) => {
        await service.subscribeEvent('Audit.LogEvent', async (event) => {
            console.log('audit', event);
        });
    });
    console.log('Calculator service is running');
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
