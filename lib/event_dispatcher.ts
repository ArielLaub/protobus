import { randomUUID } from 'crypto';
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
    private _boundOnReconnected: () => void;
    private _boundOnDisconnected: () => void;

    constructor(connection: IConnection, messageFactory: MessageFactory) {
        this.connection = connection;
        this.messageFactory = messageFactory;

        // Listen for connection events (store bound refs for proper cleanup)
        this._boundOnReconnected = this._onReconnected.bind(this);
        this._boundOnDisconnected = this._onDisconnected.bind(this);
        this.connection.on('disconnected', this._boundOnDisconnected);
        this.connection.on('reconnected', this._boundOnReconnected);
    }

    /**
     * Called when connection is lost
     */
    private _onDisconnected(): void {
        Logger.debug('EventDispatcher: connection lost, clearing channel');
        this.channel = undefined;
    }

    /**
     * Called when connection is re-established
     */
    private async _onReconnected(): Promise<void> {
        if (!this._isInitialized) return;

        Logger.info('EventDispatcher: reconnected, re-initializing channel');

        try {
            this.channel = await this.connection.openChannel();
            Logger.info('EventDispatcher: successfully re-initialized after reconnection');
        } catch (err) {
            Logger.error(`EventDispatcher: failed to re-initialize after reconnection: ${err.message}`);
        }
    }

    public async init() {
        if (this._isInitialized) return;
        this.channel = await this.connection.openChannel();
        this._isInitialized = true;
    }

    public async publish(type: string, content: any, topic: string) {
        if (!this.connection.isConnected) throw new NotConnectedError();
        if (!topic) {
            topic = `EVENT.${type}`;
        }
        const id = randomUUID();
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

    async close(): Promise<void> {
        this.connection.removeListener('disconnected', this._boundOnDisconnected);
        this.connection.removeListener('reconnected', this._boundOnReconnected);
    }
}
