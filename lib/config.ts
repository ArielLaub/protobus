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

/** Parse a boolean env var. Only an explicit affirmative counts as true. */
function envBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return fallback;
}

export default class Config {
    /**
     * Send the message of an *unhandled* service error back to the caller.
     *
     * **On by default**, which is the 1.x behaviour.
     *
     * The audit grouped this with its logging findings, but the threat models
     * differ. Logs and DLQ metadata escape into systems with looser access
     * control than the bus — aggregators with broad read access and long
     * retention, dashboards, queue browsers — so those are redacted
     * unconditionally (see the default handlers and `safeErrorSummary`).
     *
     * A protobus caller is a different matter: it is another of your own
     * services, already inside the trust boundary and already holding the
     * broker credentials. An error message travelling service to service is an
     * internal detail moving between components that already trust each other,
     * not a disclosure. Suppressing it by default would silently degrade every
     * consumer's error reporting to buy very little.
     *
     * Set PROTOBUS_EXPOSE_INTERNAL_ERRORS=false where that assumption does not
     * hold — chiefly a service that forwards protobus errors onward to an
     * untrusted client. A gateway should map errors deliberately rather than
     * relaying them, but this makes the safe behaviour available in one
     * setting. Callers then get a generic message plus the correlationId, and
     * the real error still goes to the service's own log.
     *
     * `HandledError` is unaffected either way: raising one is an explicit
     * decision to tell the caller something, so its message always crosses.
     */
    static get exposeInternalErrors() {
        return envBool('PROTOBUS_EXPOSE_INTERNAL_ERRORS', true);
    }

    static get busExchangeName() {
        return process.env.BUS_EXCHANGE_NAME || 'proto.bus';
    }

    static get callbacksExchangeName() {
        return process.env.CALLBACKS_EXCHANGE_NAME || 'proto.bus.callback';
    }

    /**
     * Fanout exchange carrying stream-cancellation notices.
     *
     * Fanout, not topic: a cancel has to reach the one process holding that
     * correlationId, and the caller has no way to know which replica that is.
     * Every service instance binds its own exclusive queue, hears every cancel,
     * and ignores the ones it does not own. Cancels are rare, so the broadcast
     * costs nothing worth measuring.
     */
    static get cancelExchangeName() {
        return process.env.CANCEL_EXCHANGE_NAME || 'proto.bus.cancel';
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

    /**
     * How long a publish waits for its broker confirm before rejecting with
     * PublishConfirmTimeoutError.
     *
     * A confirm timeout is an AMBIGUOUS outcome, not a failure: the broker may
     * have stored the message and lost only the confirm. Retrying can
     * duplicate, which is why publishes carry a stable messageId.
     */
    static get publishConfirmTimeoutMs() {
        return envInt('PUBLISH_CONFIRM_TIMEOUT_MS', 30000);
    }

    /**
     * AMQP heartbeat interval, in seconds.
     *
     * amqplib closes a connection after two missed intervals, so this is half
     * the worst-case time to notice a peer that vanished without closing its
     * socket — a crashed broker, a partition, a NAT that dropped the flow.
     * Left unset, the interval is whatever the broker proposes, and RabbitMQ
     * proposes 60, which is two minutes of publishing into a dead socket while
     * the connection still reports itself healthy.
     *
     * A caller-supplied URL that already carries `?heartbeat=` wins, which is
     * also how heartbeats are turned off: `?heartbeat=0`.
     */
    static get heartbeatSeconds() {
        return envInt('AMQP_HEARTBEAT_SECONDS', 30);
    }

    /**
     * How long a publisher parked on a reconnection waits for the connection to
     * carry traffic again before giving up with NotReadyError.
     *
     * Bounded because the alternative is holding the caller for as long as the
     * broker stays away, which for an unreachable broker is forever.
     */
    static get connectionReadyTimeoutMs() {
        return envInt('CONNECTION_READY_TIMEOUT_MS', 30000);
    }

    /**
     * Maximum publishes awaiting a broker confirm on one channel at a time.
     * Further publishes park until a slot frees, which is what stops a fast
     * producer from queueing unbounded unconfirmed work in memory.
     */
    static get maxOutstandingConfirms() {
        return envInt('MAX_OUTSTANDING_CONFIRMS', 256);
    }

    /**
     * Upper bound on chunks buffered for a single streaming call that the
     * caller has not consumed yet.
     *
     * The dispatcher buffers whatever the server publishes, so a producer
     * faster than its consumer would grow this array without limit. Exceeding
     * the bound fails the stream with StreamBackpressureError.
     */
    static get streamMaxBufferedChunks() {
        return envInt('STREAM_MAX_BUFFERED_CHUNKS', 1024);
    }

    /**
     * Upper bound on total buffered bytes for a single streaming call. Chunk
     * count alone is a poor proxy for memory when chunk sizes vary widely.
     * Defaults to 64 MiB.
     */
    static get streamMaxBufferedBytes() {
        return envInt('STREAM_MAX_BUFFERED_BYTES', 64 * 1024 * 1024);
    }

    /**
     * Upper bound on buffered bytes across **all** streaming calls on one
     * dispatcher.
     *
     * The per-call bound says nothing about a process holding many calls at
     * once: at the defaults, five concurrent streams are within their limits
     * and 320 MiB into the heap. Defaults to 256 MiB.
     */
    static get streamMaxTotalBufferedBytes() {
        return envInt('STREAM_MAX_TOTAL_BUFFERED_BYTES', 256 * 1024 * 1024);
    }

    /**
     * Named message-priority levels, matching protobus-py.
     *
     * `PRIORITY_NORMAL` is 0 because that is what RabbitMQ assigns a message
     * that carries no priority property at all — so an old publisher and a new
     * one that passes PRIORITY_NORMAL sort identically, which is what makes the
     * two interoperable on the same queue.
     */
    static readonly PRIORITY_NORMAL = 0;
    static readonly PRIORITY_HIGH = 1;
    static readonly PRIORITY_CONTROL = 2;

    /**
     * The `maxPriority` to declare a priority queue with, for the levels above.
     *
     * Deliberately tiny. RabbitMQ maintains internal structures per priority
     * level, so a large range costs memory and throughput for nothing; the
     * broker's own guidance is a handful of levels. 255 is legal and a waste.
     */
    static readonly RECOMMENDED_MAX_PRIORITY = 2;

    // Headers used by the streaming wire protocol. See docs/advanced/streaming.md.
    static readonly HEADER_FINAL = 'x-protobus-final';
    static readonly HEADER_SEQ = 'x-protobus-seq';
}
