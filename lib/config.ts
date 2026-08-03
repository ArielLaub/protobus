/**
 * Memo of parsed integer env vars, keyed by variable name.
 *
 * These getters sit on the per-message hot path, so we avoid re-running
 * parseInt on every access. The raw string is stored alongside the parsed
 * value so an env var changed at runtime (or by a test) is still picked up —
 * we re-parse only when the raw value actually differs.
 */
const intCache = new Map<string, { raw: string | undefined; value: number }>();

/**
 * Parse a positive-integer env var, falling back to `fallback` for anything
 * malformed.
 *
 * parseInt() is deliberately not used: it accepts trailing garbage, so a typo
 * like `6oo000` silently became NaN (or `123abc` became 123). NaN was the
 * worse case — setTimeout(fn, NaN) fires immediately, so a mistyped
 * MESSAGE_PROCESSING_TIMEOUT flagged every single message as timed out.
 */
function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    const hit = intCache.get(name);
    if (hit && hit.raw === raw) {
        return hit.value;
    }

    let value = fallback;
    if (raw !== undefined && raw.trim() !== '' && /^\d+$/.test(raw.trim())) {
        const parsed = Number(raw.trim());
        if (Number.isSafeInteger(parsed) && parsed > 0) {
            value = parsed;
        }
    }

    intCache.set(name, { raw, value });
    return value;
}

export default class Config {
    static get busExchangeName() {
        return process.env.BUS_EXCHANGE_NAME || 'proto.bus';
    }

    static get callbacksExchangeName() {
        return process.env.CALLBACKS_EXCHANGE_NAME || 'proto.bus.callback';
    }

    static get eventsExchangeName() {
        return process.env.EVENTS_EXCHANGE_NAME || 'proto.bus.events';
    }

    static get messageProcessingTimeout() {
        return envInt('MESSAGE_PROCESSING_TIMEOUT', 600000);
    }

    /**
     * How long a unary RPC caller waits for a reply before rejecting with
     * RpcTimeoutError. Without this a dropped request (no consumer bound, or a
     * handler that died on the early-ack path) left the caller's promise
     * pending forever and leaked its entry in the dispatcher's callback map.
     *
     * Defaults to messageProcessingTimeout's default rather than something
     * short, so existing deployments with legitimately slow handlers keep
     * working. Override per call via the `timeoutMs` argument.
     */
    static get rpcCallTimeoutMs() {
        return envInt('RPC_CALL_TIMEOUT_MS', 600000);
    }

    /**
     * Idle timeout for streaming RPC calls in milliseconds. A streaming call
     * raises StreamTimeoutError if no chunk arrives within this window.
     * The standard messageProcessingTimeout does NOT apply to streams.
     */
    static get streamIdleTimeoutMs() {
        return envInt('STREAM_IDLE_TIMEOUT_MS', 60000);
    }

    /**
     * Default prefetch for late-ack consumers that don't specify one. Bounds
     * how many unacked messages the broker will push into process memory.
     */
    static get defaultPrefetch() {
        return envInt('DEFAULT_PREFETCH', 1);
    }

    // Headers used by the streaming wire protocol. See docs/advanced/streaming.md.
    static readonly HEADER_FINAL = 'x-protobus-final';
    static readonly HEADER_SEQ = 'x-protobus-seq';
}
