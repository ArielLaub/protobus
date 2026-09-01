"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotFoundError = exports.ValidationError = void 0;
const protobus_1 = require("protobus");
class ValidationError extends protobus_1.HandledError {
    constructor(message) { super(message, 'VALIDATION_ERROR'); }
}
exports.ValidationError = ValidationError;
class NotFoundError extends protobus_1.HandledError {
    constructor(resource, id) {
        super(`${resource} ${id} not found`, 'NOT_FOUND');
    }
}
exports.NotFoundError = NotFoundError;
