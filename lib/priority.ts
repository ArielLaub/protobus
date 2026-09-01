import Config from './config';

/**
 * A `maxPriority` or per-message `priority` that AMQP cannot carry.
 *
 * Raised client-side, before anything reaches the broker, because both of the
 * failures it prevents are expensive:
 *
 *  - An out-of-range `x-max-priority` is a 406 PRECONDITION_FAILED on
 *    `queue.declare`, which kills the channel the declare was issued on. Each
 *    listener opens its own channel, so this does not take the whole process
 *    down with it — but the listener's `init()` rejects and the service fails
 *    to start, with an opaque broker message rather than a useful one.
 *  - A non-integer per-message `priority` is worse, because it is silent:
 *    amqplib encodes the priority as a single byte and 1.5 arrives at the
 *    broker as 1. Nothing errors, and the message simply sorts somewhere the
 *    caller did not ask for.
 */
export class InvalidPriorityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidPriorityError';
    }
}

/** AMQP carries the priority in one byte. */
const MIN_PRIORITY = 0;
const MAX_PRIORITY = 255;

function requireIntegerInRange(
    value: unknown, label: string, min: number, max: number, extra: string,
): number | undefined {
    if (value === undefined) return undefined;

    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new InvalidPriorityError(
            `${label} must be an integer between ${min} and ${max}, got ${
                typeof value === 'number' ? value : JSON.stringify(value)
            } (${typeof value}). ${extra}`,
        );
    }
    if (value < min || value > max) {
        throw new InvalidPriorityError(
            `${label} must be between ${min} and ${max}, got ${value}. ${extra}`,
        );
    }
    return value;
}

/**
 * Validate the queue-level `maxPriority` — the value that becomes
 * `x-max-priority` on `queue.declare`.
 *
 * The floor is 1, not 0: `x-max-priority: 0` is accepted by RabbitMQ but gives
 * a single priority level, which is a plain queue with a priority queue's
 * overhead *and* an argument set that no longer matches the plain queue it
 * replaced. Nobody wants that on purpose, so it is refused rather than
 * declared.
 */
export function validateMaxPriority(value: unknown): number | undefined {
    return requireIntegerInRange(
        value, 'maxPriority', 1, MAX_PRIORITY,
        `RabbitMQ maintains internal structures per priority level, so keep the range small — ` +
        `${Config.RECOMMENDED_MAX_PRIORITY} is the recommended value and gives ` +
        `${Config.RECOMMENDED_MAX_PRIORITY + 1} levels.`,
    );
}

/** Validate a per-message `priority`. 0 is valid and is RabbitMQ's default. */
export function validatePriority(value: unknown): number | undefined {
    return requireIntegerInRange(
        value, 'priority', MIN_PRIORITY, MAX_PRIORITY,
        'A priority above the queue\'s x-max-priority is clamped by the broker, not rejected.',
    );
}
