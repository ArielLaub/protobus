import { BaseListener } from './base_listener';
import Config from './config';
import MessageFactory from './message_factory';
import { Logger } from './logger';
import { IConnection, ConsumeRetryOptions, MessageHandler } from './connection';
import { isHandledError } from './errors';
import { RetryQueueMismatchError } from './message_listener';
import Trie from './trie';

export type EventHandler = (event: any, type: string, topic: string) => Promise<void>;

/**
 * Opt-in retry for event handlers. Left unset, a handler that throws loses its
 * event — the historical default, kept because rejecting the delivery is what
 * stops one permanently-failing event from stalling the subscriber behind its
 * own prefetch.
 *
 * Enabling it gives events the ladder RPC requests already climb: park, wait,
 * redeliver, and dead-letter once the attempts are spent.
 */
export interface EventRetryOptions {
    /** Retry hops before the DLQ. 0 (the default) keeps the drop-on-failure behaviour. */
    maxRetries?: number;
    /** Delay between hops, as the retry queue's `x-message-ttl`. Defaults to 5000. */
    retryDelayMs?: number;
}

export default class EventListener extends BaseListener {
    private messageFactory: MessageFactory;
    private allHandler: EventHandler;
    private router: Trie<EventHandler>;
    private retryConfig: Required<EventRetryOptions>;
    private retryQueueName = '';
    private retryExchangeName = '';
    private redeliveryExchangeName = '';
    private dlqName = '';

    constructor(
        connection: IConnection,
        messageFactory: MessageFactory,
        retry: EventRetryOptions = {},
    ) {
        super(connection);

        this.retryConfig = {
            maxRetries: retry.maxRetries ?? 0,
            retryDelayMs: retry.retryDelayMs ?? 5000,
        };

        this.router = new Trie();
        this.exchangeName = Config.eventsExchangeName;
        this.exchangeType = 'topic';
        this.lateAck = true;
        this.allHandler = undefined;
        this.messageFactory = messageFactory;
        this.defaultHandler = (async (
            encodedEvent: Buffer,
            _correlationId?: string,
            _headers?: Record<string, any>,
            context?: { routingKey?: string },
        ) => {
            const event = this.messageFactory.decodeEvent(encodedEvent);
            if (this.allHandler) {
                await this.allHandler(event.data, event.type, event.topic);
            }
            // Prefer the routing key the broker actually delivered on over the
            // topic carried in the body. They agree for anything published by
            // EventDispatcher, but the body is publisher-controlled, so trusting
            // it would let a publisher target handlers its routing key was never
            // permitted to reach. Falls back to the body topic when no routing
            // key is available (older connection layers, direct handler calls).
            const matchTopic = context?.routingKey || event.topic;
            if (event && matchTopic) {
                const handlers = this.router.match(matchTopic);
                if (handlers && handlers.length > 0) {
                    for (const handler of handlers) {
                        await handler(event.data, event.type, event.topic);
                    }
                }
            } else {
                // Type only — `event.data` is application payload and must not
                // reach the log. The type is what tells an operator which
                // publisher is emitting events nothing is subscribed to.
                Logger.warn(
                    `ignoring unhandled event of type '${event?.type ?? 'unknown'}' (no topic to route on)`,
                );
            }
        });
    }

    /**
     * Declare the retry ladder, after the queue this listener consumes exists.
     *
     * The shape differs from MessageListener's on one point that matters.
     * A request's retry queue dead-letters back to `proto.bus`, which routes
     * to exactly one service queue. Events fan out: dead-lettering back to
     * `proto.bus.events` would redeliver to every subscriber bound to the
     * topic, including the ones that handled it successfully. So the expired
     * message goes to a per-subscriber topic exchange bound only to this
     * listener's own queue, which confines the redelivery while still
     * preserving the routing key the handlers match on.
     */
    private async setupRetryTopology(): Promise<void> {
        // An anonymous queue disappears with the connection, so a retry
        // parked against it has nowhere to come back to.
        if (this.retryConfig.maxRetries <= 0 || this.isAnonymous) { return; }

        const base = this.configuredQueueName;
        this.dlqName = `${base}.DLQ`;
        this.retryQueueName = `${base}.Retry`;
        this.retryExchangeName = `${base}.Retry.Exchange`;
        this.redeliveryExchangeName = `${base}.Redelivery`;

        await this.connection.declareQueue(this.channel, this.dlqName, {
            durable: true, autoDelete: false, exclusive: false, arguments: {},
        });

        await this.connection.declareExchange(
            this.channel, this.redeliveryExchangeName, 'topic',
            { durable: true, autoDelete: false, internal: false, arguments: {} },
        );
        await this.connection.bindQueue(
            this.channel, this.queueName, this.redeliveryExchangeName, '#', {},
        );

        try {
            await this.connection.declareQueue(this.channel, this.retryQueueName, {
                durable: true,
                autoDelete: false,
                exclusive: false,
                arguments: {
                    'x-message-ttl': this.retryConfig.retryDelayMs,
                    'x-dead-letter-exchange': this.redeliveryExchangeName,
                },
            });
        } catch (error) {
            if (/PRECONDITION[_-]FAILED/i.test((error as any)?.message ?? '')) {
                throw new RetryQueueMismatchError(
                    `event retry queue '${this.retryQueueName}' already exists with different ` +
                    `arguments (most likely a different retryDelayMs — now ` +
                    `${this.retryConfig.retryDelayMs}ms). RabbitMQ cannot change a queue's ` +
                    `x-message-ttl in place: drain and delete the queue, or keep the original ` +
                    `retryDelayMs. Original error: ${(error as any).message}`,
                );
            }
            throw error;
        }

        await this.connection.declareExchange(
            this.channel, this.retryExchangeName, 'topic',
            { durable: true, autoDelete: false, internal: false, arguments: {} },
        );
        await this.connection.bindQueue(
            this.channel, this.retryQueueName, this.retryExchangeName, '#', {},
        );
    }

    protected getRetryOptions(): ConsumeRetryOptions | undefined {
        if (this.retryConfig.maxRetries <= 0 || !this.retryQueueName || !this.dlqName) {
            return undefined;
        }
        return {
            maxRetries: this.retryConfig.maxRetries,
            retryQueueName: this.retryQueueName,
            retryExchangeName: this.retryExchangeName,
            dlqName: this.dlqName,
            isHandledError,
        };
    }

    async init(messageHandler: MessageHandler, queueName?: string) {
        if (this.isInitialized) { return; }
        await super.init(messageHandler, queueName);
        // Before start(), so the first delivery already has somewhere to fail to.
        await this.setupRetryTopology();
    }

    subscribe(type: string, handler: EventHandler, topic?: string) {
        if (!topic) {
            topic = `EVENT.${type}`;
        }
        this.router.add(topic, handler.bind(this));
        this.trackBinding(topic); // Track for reconnection

        return this.connection.bindQueue(
            this.channel,
            this.queueName,
            this.exchangeName,
            topic, {});
    }

    subscribeAll(handler: EventHandler) {
        this.allHandler = handler;
        this.trackBinding('#'); // Track for reconnection

        return this.connection.bindQueue(
            this.channel,
            this.queueName,
            this.exchangeName,
            '#', {});
    }

    /** Names of the retry objects, for tests and operators. `undefined` when retry is off. */
    public get retryTopology(): { retryQueue: string; dlq: string } | undefined {
        if (!this.retryQueueName) { return undefined; }
        return { retryQueue: this.retryQueueName, dlq: this.dlqName };
    }

    // TODO: trie implementation doesn't support unsubscribing yet...
    /* unsubscribe(type: string, handler: any) {
        if (!this.handlers.has(type)) { this.handlers.set(type, [handler.bind(this)]); } else { this.handlers.get(type).push(handler.bind(this)); }

        return this.connection.unbindQueue(
            this.channel,
            this.queueName,
            this.exchangeName,
            `EVENT.${type}`, {});
    } */
}
