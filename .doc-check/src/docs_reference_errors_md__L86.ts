import { HandledError, isHandledError, MessageService } from 'protobus';

class ValidationError extends HandledError {
    constructor(field: string) {
        super(`${field} is required`, 'VALIDATION_ERROR');
    }
}

abstract class OrdersService extends MessageService {
    async create(request: { customerId?: string }) {
        if (!request.customerId) throw new ValidationError('customerId');
        return { id: 'order-1' };
    }
}

// Duck-typed: no inheritance required, only the flag.
const foreign = Object.assign(new Error('rejected by the payment gateway'), {
    isHandled: true,
    code: 'PAYMENT_DECLINED',
});
console.log(isHandledError(foreign));   // true
