import MessageDispatcher from './message_dispatcher';
import EventDispatcher from './event_dispatcher';
import Connection from './connection';
import MessageFactory from './message_factory';

export interface IContext {
    init(amqpConnectionString: string, protoLocations: string[]): Promise<void>;
    publishMessage(content: any, routingKey: string, rpc?: boolean): Promise<Buffer>;
    publishEvent(type: string, content: any, topic: string): Promise<void>;

    factory: MessageFactory;
    connection: Connection;
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
    }

    async init(amqpConnectionString: string, protoLocations: string[]): Promise<void> {
        this.messageFactory.init(protoLocations);
        await this.connection.connect(amqpConnectionString);
        await this.messageDispatcher.init();
        await this.eventDispatcher.init();
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
