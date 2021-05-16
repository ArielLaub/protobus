import * as cuid from 'cuid';
import MessageFactory from './message_factory';
import { IConnection, Channel, PublishOptions } from './connection';
import { Logger } from './logger';
import Config from './config';

export class NotConnectedError extends Error {}
export class InvalidMessageError extends Error {}

export default class EventDispatcher {
    private messageFactory: MessageFactory;
    private connection: IConnection;
    private channel: Channel;

    private _isInitialized: boolean = false;
    public get isInitialized() { return this._isInitialized; }

    constructor(connection: IConnection, messageFactory: MessageFactory) {
        this.connection = connection;
        this.messageFactory = messageFactory;
    }

    public async init() {
        this.channel = await this.connection.openChannel();
        this._isInitialized = true;
    }

    public async publish(type: string, content: any, topic: string) {
        if (!this.connection.isConnected) throw new NotConnectedError();
        if (!topic) {
            topic = `EVENT.${type}`;
        }
        const id = cuid();
        const properties: PublishOptions = {
            correlationId: id,
            contentType: 'application/octet-stream',
            deliveryMode: 2, // persistent
        };
        let event;
        try {
            event = this.messageFactory.buildEvent(type, content, topic);
        } catch (error) {
            console.error(`failed building event '${type}' from ${JSON.stringify(content)}\n${error}`);
            throw new InvalidMessageError();
        }
        return this.connection.publish(this.channel, Config.eventsExchangeName, topic,
            event, properties);
    }
}
