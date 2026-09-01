"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
async function create(proxy, orderId) {
    try {
        return await proxy.createOrder({ orderId });
    }
    catch (error) {
        // Switch on the code you set, not on the error's class or its text.
        switch (error.code) {
            case 'VALIDATION_ERROR': return null;
            case 'NOT_FOUND': return null;
            default: throw error;
        }
    }
}
