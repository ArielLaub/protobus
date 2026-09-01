"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InsufficientFundsError = exports.NotFoundError = void 0;
const protobus_1 = require("protobus");
class NotFoundError extends protobus_1.HandledError {
    constructor(resource, id) {
        super(`${resource} ${id} not found`, 'NOT_FOUND');
    }
}
exports.NotFoundError = NotFoundError;
class InsufficientFundsError extends protobus_1.HandledError {
    shortfallCents;
    constructor(shortfallCents) {
        super(`short by ${shortfallCents} cents`, 'INSUFFICIENT_FUNDS');
        this.shortfallCents = shortfallCents;
    }
}
exports.InsufficientFundsError = InsufficientFundsError;
