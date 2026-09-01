"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatorService = void 0;
exports.createContext = createContext;
const protobus_1 = require("protobus");
// ---- from docs/guide/getting-started.md:156 (needs=gs-context) ----
// src/context.ts
async function createContext() {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];
    const context = new protobus_1.Context();
    await context.init(AMQP_URL, PROTO_PATHS);
    return context;
}
// ---- from docs/guide/getting-started.md:181 (needs=gs-service) ----
// src/calculator-service.ts
class CalculatorService extends protobus_1.RunnableService {
    constructor(context) {
        super(context);
    }
    // Required: the full service name from the proto — package + service.
    get ServiceName() {
        return 'Calculator.Math';
    }
    // One method per rpc, matching the name in the proto exactly.
    async add(request) {
        const result = request.a + request.b;
        // Optional: tell anyone who cares that this happened.
        await this.publishEvent('Calculator.CalculationEvent', {
            operation: 'add',
            result,
        });
        return { result };
    }
}
exports.CalculatorService = CalculatorService;
// src/server.ts
async function main() {
    const context = await createContext();
    await protobus_1.RunnableService.start(context, CalculatorService, {
        maxConcurrent: 2, // in-flight messages per process; the default is 1
    });
    console.log('Calculator service is running');
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
