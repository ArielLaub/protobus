"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatorService = void 0;
const protobus_1 = require("protobus");
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
