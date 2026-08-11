import Config from './config';

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
 * Substituted for an unhandled service error before it crosses back to the
 * caller, unless Config.exposeInternalErrors is enabled.
 *
 * Carries the correlationId so an operator can join the caller's report to the
 * real exception in the service's own log.
 */
export class InternalServiceError extends Error {
    public readonly code = 'INTERNAL_ERROR';

    constructor(correlationId?: string) {
        super(correlationId
            ? `internal service error (correlationId ${correlationId})`
            : 'internal service error');
        this.name = 'InternalServiceError';
    }
}

/**
 * Decide what an error looks like to the *caller*.
 *
 * A HandledError is something the service deliberately chose to expose, so it
 * passes through untouched. Anything else is an internal failure whose message
 * was written for the service's own logs and may quote the very data that
 * caused it — that becomes a generic InternalServiceError.
 */
export function sanitizeErrorForClient(error: unknown, correlationId?: string): unknown {
    if (isHandledError(error)) return error;
    if (Config.exposeInternalErrors) return error;
    return new InternalServiceError(correlationId);
}

/**
 * A non-disclosing description of an error: its class name and `code`, never
 * its message.
 *
 * Exception messages routinely interpolate the values that caused them —
 * connection strings, tokens, the row that failed validation. That is fine in
 * a service's own logs, but this summary is for places the text travels
 * further than the process: retry/DLQ metadata headers, which ops dashboards
 * read and which persist in a queue long after the fact.
 *
 * A HandledError is different: it is by definition something the service chose
 * to expose, so its message is kept.
 */
export function safeErrorSummary(error: unknown): string {
    if (error === null || error === undefined) return 'UnknownError';

    if (isHandledError(error)) {
        return `${error.name}[${error.code}]: ${error.message}`;
    }

    const err = error as any;
    const name = err?.name || err?.constructor?.name || 'Error';
    return err?.code ? `${name}[${err.code}]` : String(name);
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
 * Base class for publish failures.
 *
 * Each subclass is a distinct way a publish can fail to reach a queue.
 *
 * `messageId` is stable across retries of the same logical message, so a
 * consumer can deduplicate on it.
 */
export class PublishError extends Error {
    public readonly messageId?: string;

    constructor(message: string, messageId?: string) {
        super(message);
        this.name = 'PublishError';
        this.messageId = messageId;
    }
}

/**
 * The broker explicitly refused the message (basic.nack). This is a definite
 * negative outcome: the message was NOT stored, and republishing is safe.
 */
export class PublishNackedError extends PublishError {
    public readonly code = 'PUBLISH_NACKED';

    constructor(message: string, messageId?: string) {
        super(message, messageId);
        this.name = 'PublishNackedError';
    }
}

/**
 * A `mandatory` publish reached the exchange but matched no queue, so the
 * broker returned it. RabbitMQ still ACKs a returned message, so confirm-only
 * handling would report success for a message that reached nothing.
 *
 * For an RPC request this usually means no service is bound to the routing
 * key — worth failing fast on rather than waiting out the full RPC timeout.
 */
export class UnroutableError extends PublishError {
    public readonly code = 'UNROUTABLE';

    constructor(message: string, messageId?: string) {
        super(message, messageId);
        this.name = 'UnroutableError';
    }
}

/**
 * No confirm arrived within the configured window. The outcome is genuinely
 * UNKNOWN — the broker may or may not have stored the message — so a retry can
 * duplicate it. Consumers must be idempotent; see docs on message identity.
 */
export class PublishConfirmTimeoutError extends PublishError {
    public readonly code = 'PUBLISH_CONFIRM_TIMEOUT';

    constructor(message: string, messageId?: string) {
        super(message, messageId);
        this.name = 'PublishConfirmTimeoutError';
    }
}

/**
 * The channel closed while a publish was still awaiting its confirm. Like a
 * confirm timeout this is an ambiguous outcome, not a definite failure.
 */
export class ChannelClosedError extends PublishError {
    public readonly code = 'CHANNEL_CLOSED';

    constructor(message: string, messageId?: string) {
        super(message, messageId);
        this.name = 'ChannelClosedError';
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
 * Raised when a stream's buffer exceeds its configured chunk or byte bound.
 * A safety net for a producer outrunning its consumer.
 */
export class StreamBackpressureError extends StreamingError {
    constructor(message: string) {
        super(message);
        this.name = 'StreamBackpressureError';
    }
}

/**
 * Raised when a streaming reply arrives with a gap in its sequence numbers,
 * meaning at least one chunk was lost.
 *
 * Failing is deliberate. The alternative — yielding what did arrive — hands
 * the caller a short stream that looks like a complete one, which is the worst
 * outcome for streamed data: silently wrong rather than visibly broken.
 */
export class StreamSequenceError extends StreamingError {
    constructor(message: string) {
        super(message);
        this.name = 'StreamSequenceError';
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
