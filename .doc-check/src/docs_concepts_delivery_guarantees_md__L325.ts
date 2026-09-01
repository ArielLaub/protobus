import { HandledError } from 'protobus';

class ValidationError extends HandledError {
    constructor(message: string) {
        super(message, 'VALIDATION_ERROR');
    }
}

async function createOrder(request: { customerId?: string }): Promise<{ id: string }> {
    if (!request.customerId) {
        // Answered immediately. No retry, no DLQ entry, no parked caller.
        throw new ValidationError('customerId is required');
    }
    return { id: 'order-1' };
}
