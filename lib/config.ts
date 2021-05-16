export default class Config {
    static get busExchangeName() {
        return process.env.BUS_EXCHANGE_NAME || 'remarkable.bus';
    }

    static get callbacksExchangeName() {
        return process.env.CALLBACKS_EXCHANGE_NAME || 'remarkable.bus.callback';
    }

    static get eventsExchangeName() {
        return process.env.EVENTS_EXCHANGE_NAME || 'remarkable.events';
    }

    static get messageProcessingTimeout() {
        const c = process.env.MESSAGE_PROCESSING_TIMEOUT;
        return c ? parseInt(c) : 600000;
    }
}