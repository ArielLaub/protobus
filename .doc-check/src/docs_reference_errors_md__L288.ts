import { HandledError } from 'protobus';

export class NotFoundError extends HandledError {
    constructor(resource: string, id: string) {
        super(`${resource} ${id} not found`, 'NOT_FOUND');
    }
}

export class InsufficientFundsError extends HandledError {
    constructor(public readonly shortfallCents: number) {
        super(`short by ${shortfallCents} cents`, 'INSUFFICIENT_FUNDS');
    }
}
