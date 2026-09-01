"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatorNode = void 0;
const protobus_1 = require("protobus");
class CalculatorNode extends protobus_1.ProxiedService {
    get ServiceName() { return 'Calculator.Math'; }
    get ProtoFileName() { return __dirname + '/proto/Calculator.proto'; }
    async addViaPeer(a, b) {
        const { result } = await this.proxy.add({ a, b });
        return result;
    }
}
exports.CalculatorNode = CalculatorNode;
