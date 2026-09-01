"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatorService = void 0;
const protobus_1 = require("protobus");
// src/calculator-service.ts
class CalculatorService extends protobus_1.RunnableService {
    get ServiceName() { return 'Calculator.Math'; }
    async add(request) {
        return { result: request.a + request.b };
    }
}
exports.CalculatorService = CalculatorService;
