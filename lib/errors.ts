/**
 * Base error class for handled/expected errors that should NOT trigger retry.
 *
 * When a service method throws a HandledError (or any subclass), the error
 * will be returned to the caller but the message will NOT be retried.
 *
 * Use this for validation errors, business logic errors, etc.
 *
 * @example
 * ```typescript
 * class ValidationError extends HandledError {
 *     constructor(message: string) {
 *         super(message, 'VALIDATION_ERROR');
 *     }
 * }
 *
 * async myMethod(request: MyRequest): Promise<MyResponse> {
 *     if (!request.name) {
 *         throw new ValidationError('name is required');
 *     }
 *     // ...
 * }
 * ```
 */
export class HandledError extends Error {
    public readonly code: string;
    public readonly isHandled: boolean = true;

    constructor(message: string, code: string = 'HANDLED_ERROR') {
        super(message);
        this.name = 'HandledError';
        this.code = code;

        // Maintains proper stack trace for where error was thrown
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, HandledError);
        }
    }
}

/**
 * Check if an error is a handled error that should not be retried
 */
export function isHandledError(error: unknown): error is HandledError {
    return error instanceof HandledError ||
           (error instanceof Error && (error as any).isHandled === true);
}
