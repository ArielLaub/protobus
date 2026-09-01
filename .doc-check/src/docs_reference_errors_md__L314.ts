
export interface WireError extends Error { code?: string }

export async function placeOrder(call: () => Promise<{ id: string }>) {
    try {
        return await call();
    } catch (error) {
        switch ((error as WireError).code) {
            case 'NOT_FOUND':          return null;
            case 'INSUFFICIENT_FUNDS': throw error;          // the user must act
            case 'VALIDATION_ERROR':   throw error;          // our bug; do not retry
            case 'RPC_TIMEOUT':        return placeOrder(call);
            default:                   throw error;
        }
    }
}
