
export class CircuitBreaker {
    private failures = 0;
    private openedAt = 0;

    constructor(
        private readonly threshold = 5,
        private readonly cooldownMs = 30000,
    ) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.failures >= this.threshold) {
            if (Date.now() - this.openedAt < this.cooldownMs) {
                throw new Error('circuit open');
            }
            this.failures = 0;   // half-open: let one through
        }
        try {
            const result = await fn();
            this.failures = 0;
            return result;
        } catch (error) {
            this.failures += 1;
            this.openedAt = Date.now();
            throw error;
        }
    }
}
