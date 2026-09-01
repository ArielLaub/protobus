import { HandledError } from 'protobus';

export function requireFields<T extends object>(request: T, fields: (keyof T)[]): void {
    const missing = fields.filter((f) => request[f] === undefined || request[f] === null);
    if (missing.length) {
        throw new HandledError(`missing required field(s): ${missing.join(', ')}`, 'VALIDATION_ERROR');
    }
}
