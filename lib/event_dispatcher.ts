import { randomUUID } from 'crypto';
import MessageFactory from './message_factory';
import { IConnection, Channel, PublishOptions, attachRestorer } from './connection';
import { Logger } from './logger';
import Config from './config';

export class NotConnectedError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'NotConnectedError';
    }
}
export class InvalidMessageError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'InvalidMessageError';
    }
}

export default class EventDispatcher {
    private messageFactory: MessageFactory;
    private connection: IConnection;
    private channel: Channel;

    private _isInitialized: boolean = false;
    public get isInitialized() { return this._isInitialized; }
    private _detachRestorer: () => void;
    private _boundOnDisconnected: () => void;

    constructor(connection: IConnection, messageFactory: MessageFactory) {
        this.connection = connection;
        this.messageFactory = messageFactory;

        this._boundOnDisconnected = this._onDisconnected.bind(this);
        this.connection.on('disconnected', this._boundOnDisconnected);
        this._detachRestorer = attachRestorer(
            this.connection, () => this._restore(), 'EventDispatcher',
        );
    }

    /**
     * Called when connection is lost
     */
    private _onDisconnected(): void {
        Logger.debug('EventDispatcher: connection lost, clearing channel');
        this.channel = undefined;
    }

    /**
     * Reopen the publishing channel.
     *
     * A failure propagates so the connection retries the generation: an event
     * dispatcher with no channel silently drops every event published through
     * it.
     */
    private async _restore(): Promise<void> {
        if (!this._isInitialized) return;

        Logger.info('EventDispatcher: reconnected, re-initializing channel');
        this.channel = await this.connection.openChannel();
        Logger.info('EventDispatcher: successfully re-initialized after reconnection');
    }

    public async init() {
        if (this._isInitialized) return;
        this.channel = await this.connection.openChannel();
        this._isInitialized = true;
    }

    public async publish(type: string, content: any, topic: string) {
        // A reconnection is waited through rather than failed on: the channel
        // is being replaced and will be there shortly. Anything else with no
        // connection is reported at once.
        if (!this.connection.isConnected && !this.connection.isReconnecting) {
            throw new NotConnectedError();
        }
        await this.connection.whenReady?.();
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
            // Via Logger (not console) so it honours the level and any custom
            // sink, and without the payload — events carry PII too.
            Logger.error(`failed building event '${type}': ${(error as any)?.message ?? error}`);
            throw new InvalidMessageError();
        }
        return this.connection.publish(this.channel, Config.eventsExchangeName, topic,
            event, properties);
    }

    async close(): Promise<void> {
        this.connection.removeListener('disconnected', this._boundOnDisconnected);
        this._detachRestorer();
    }
}
