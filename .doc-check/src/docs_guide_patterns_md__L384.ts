import { isHandledError } from 'protobus';

export async function callWithRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 3,
    backoffMs = 1000,
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            // A HandledError means the same request fails the same way. Stop.
            if (isHandledError(error)) { throw error; }
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
            }
        }
    }
    throw lastError;
}
