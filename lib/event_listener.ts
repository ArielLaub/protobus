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
        this.defaultHandler = (async (encodedEvent: Buffer) => {
            const event = this.messageFactory.decodeEvent(encodedEvent);
            if (this.allHandler) {
                await this.allHandler(event.data, event.type, event.topic);
            }
            if (event && event.topic) {
                const handlers = this.router.match(event.topic);
                if (handlers && handlers.length > 0) {
                    for (const handler of handlers) {
                        await handler(event.data, event.type, event.topic);
                    }
                }
            } else {
                Logger.warn(`ignoring unhandled event ${JSON.stringify(event)}`);
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
