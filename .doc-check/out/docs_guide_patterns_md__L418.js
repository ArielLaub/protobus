"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = void 0;
class CircuitBreaker {
    threshold;
    cooldownMs;
    failures = 0;
    openedAt = 0;
    constructor(threshold = 5, cooldownMs = 30000) {
        this.threshold = threshold;
        this.cooldownMs = cooldownMs;
    }
    async run(fn) {
        if (this.failures >= this.threshold) {
            if (Date.now() - this.openedAt < this.cooldownMs) {
                throw new Error('circuit open');
            }
            this.failures = 0; // half-open: let one through
        }
        try {
            const result = await fn();
            this.failures = 0;
            return result;
        }
        catch (error) {
            this.failures += 1;
            this.openedAt = Date.now();
            throw error;
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
