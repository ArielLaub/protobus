"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callWithRetry = callWithRetry;
const protobus_1 = require("protobus");
async function callWithRetry(fn, maxAttempts = 3, backoffMs = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            // A HandledError means the same request fails the same way. Stop.
            if ((0, protobus_1.isHandledError)(error)) {
                throw error;
            }
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
            }
        }
    }
    throw lastError;
}
