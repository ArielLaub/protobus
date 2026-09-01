import { HandledError } from 'protobus';

export class ValidationError extends HandledError {
    constructor(message: string) { super(message, 'VALIDATION_ERROR'); }
}

export class NotFoundError extends HandledError {
    constructor(resource: string, id: string) {
        super(`${resource} ${id} not found`, 'NOT_FOUND');
    }
}
