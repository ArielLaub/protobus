"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function callWithBudget(context) {
    const calculator = new protobus_1.ServiceProxy(context, 'Calculator.Math');
    await calculator.init();
    try {
        await calculator.add({ a: 1, b: 2 }, undefined, true, 30000);
    }
    catch (error) {
        if (error instanceof protobus_1.RpcTimeoutError) {
            // Nobody replied in 30s. The request may still be being processed.
            console.error('no reply in time');
        }
        else if (error instanceof protobus_1.UnroutableError) {
            // Nothing is bound to REQUEST.Calculator.Math.add at all.
            console.error('no service is listening');
        }
        else {
            throw error;
        }
    }
}
