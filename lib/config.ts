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
        const c = process.env.MESSAGE_PROCESSING_TIMEOUT;
        return c ? parseInt(c) : 600000;
    }

    /**
     * Idle timeout for streaming RPC calls in milliseconds. A streaming call
     * raises StreamTimeoutError if no chunk arrives within this window.
     * The standard messageProcessingTimeout does NOT apply to streams.
     */
    static get streamIdleTimeoutMs() {
        const c = process.env.STREAM_IDLE_TIMEOUT_MS;
        return c ? parseInt(c) : 60000;
    }

    // Headers used by the streaming wire protocol. See docs/advanced/streaming.md.
    static readonly HEADER_FINAL = 'x-protobus-final';
    static readonly HEADER_SEQ = 'x-protobus-seq';
}