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

/**
 * Raised when a unary RPC call gets no reply within its timeout.
 *
 * Before this existed, an unanswered request left the caller's promise pending
 * forever — and its entry in the dispatcher's callback map leaked. That happens
 * whenever nothing is bound to the routing key, the exchange drops the message,
 * or the handler dies without replying.
 */
export class RpcTimeoutError extends Error {
    public readonly code = 'RPC_TIMEOUT';

    constructor(message: string) {
        super(message);
        this.name = 'RpcTimeoutError';
    }
}

/**
 * Base class for streaming RPC errors. See docs/advanced/streaming.md.
 */
export class StreamingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StreamingError';
    }
}

/**
 * Raised inside a streaming `for await` when no chunk arrives within the
 * idle timeout. The total-call timeout does NOT apply to streams — a stream
 * is permitted to take far longer than any single chunk gap.
 */
export class StreamTimeoutError extends StreamingError {
    constructor(message: string) {
        super(message);
        this.name = 'StreamTimeoutError';
    }
}

/**
 * Raised when the streaming reply queue overflows (bounded by config).
 * Almost never reachable in practice with text-token chunks; primarily a
 * safety net for runaway producers.
 */
export class StreamBackpressureError extends StreamingError {
    constructor(message: string) {
        super(message);
        this.name = 'StreamBackpressureError';
    }
}

/**
 * Raised when iterating a stream after it has been closed (e.g. due to
 * a disconnection or explicit cleanup).
 */
export class StreamClosedError extends StreamingError {
    constructor(message: string) {
        super(message);
        this.name = 'StreamClosedError';
    }
}
