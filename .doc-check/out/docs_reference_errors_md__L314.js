"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.placeOrder = placeOrder;
async function placeOrder(call) {
    try {
        return await call();
    }
    catch (error) {
        switch (error.code) {
            case 'NOT_FOUND': return null;
            case 'INSUFFICIENT_FUNDS': throw error; // the user must act
            case 'VALIDATION_ERROR': throw error; // our bug; do not retry
            case 'RPC_TIMEOUT': return placeOrder(call);
            default: throw error;
        }
    }
}
