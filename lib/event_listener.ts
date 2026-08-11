import { BaseListener } from './base_listener';
import Config from './config';
import MessageFactory from './message_factory';
import { Logger } from './logger';
import { IConnection } from './connection';
import Trie from './trie';

export type EventHandler = (event: any, type: string, topic: string) => Promise<void>;

export default class EventListener extends BaseListener {
    private messageFactory: MessageFactory;
    private allHandler: EventHandler;
    private router: Trie<EventHandler>;

    constructor(connection: IConnection, messageFactory: MessageFactory) {
        super(connection);

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
