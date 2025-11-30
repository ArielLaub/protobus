import MessageDispatcher from './message_dispatcher';
import EventDispatcher from './event_dispatcher';
import Connection, { ReconnectionOptions } from './connection';
import MessageFactory from './message_factory';
import { Logger } from './logger';

export interface ContextOptions {
    reconnection?: ReconnectionOptions;
}

export interface IContext {
    init(amqpConnectionString: string, protoLocations: string[], options?: ContextOptions): Promise<void>;
    publishMessage(content: any, routingKey: string, rpc?: boolean): Promise<Buffer>;
    publishEvent(type: string, content: any, topic: string): Promise<void>;

    factory: MessageFactory;
    connection: Connection;

    // Connection state
    isConnected: boolean;
    isReconnecting: boolean;
}

export default class Context implements IContext {
    private messageDispatcher: MessageDispatcher;
    private eventDispatcher: EventDispatcher;
    private _connection: Connection;
    private messageFactory: MessageFactory;

    constructor() {
        this._connection = new Connection();
        this.messageFactory = new MessageFactory();
        this.messageDispatcher = new MessageDispatcher(this.connection);
        this.eventDispatcher = new EventDispatcher(this.connection, this.messageFactory);

        // Forward connection events
        this._connection.on('reconnecting', (info) => {
            Logger.info(`Context: reconnecting (attempt ${info.attempt}, delay ${info.delay}ms)`);
        });
        this._connection.on('reconnected', () => {
            Logger.info('Context: reconnected successfully');
        });
        this._connection.on('disconnected', () => {
            Logger.warn('Context: connection lost');
        });
        this._connection.on('error', (err) => {
            Logger.error(`Context: connection error - ${err.message}`);
        });
    }

    async init(amqpConnectionString: string, protoLocations: string[], options?: ContextOptions): Promise<void> {
        this.messageFactory.init(protoLocations);
        await this.connection.connect(amqpConnectionString, options?.reconnection);
        await this.messageDispatcher.init();
        await this.eventDispatcher.init();
    }

    get isConnected(): boolean {
        return this._connection.isConnected;
    }

    get isReconnecting(): boolean {
        return this._connection.isReconnecting;
    }

    async publishMessage(content: any, routingKey: string, rpc?: boolean): Promise<Buffer> {
        return this.messageDispatcher.publish(content, routingKey, rpc !== false);
    }

    async publishEvent(type: string, content: any, topic: string): Promise<void> {
        return this.eventDispatcher.publish(type, content, topic);
    }

    get factory(): MessageFactory {
        return this.messageFactory;
    }

    get connection() {
        return this._connection;
    }
}
