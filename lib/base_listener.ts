import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import { IConnection, Channel, ConsumeOptions, ConsumeRetryOptions, MessageHandler } from './connection';
import { Logger } from './logger';

export class ConnectionError extends Error {}
export class NotConnectedError extends Error {}
export class NotInitializedError extends Error {}
export class AlreadyStartedError extends Error {}
export class MissingExchangeError extends Error {}

export abstract class BaseListener extends EventEmitter {
    protected connection: IConnection;

    protected queueName: string;
    protected configuredQueueName: string; // Original queue name for reconnection
    protected exchangeName: string;
    protected exchangeType: string;
    protected channel: Channel;
    protected consumerTag: string;
    protected handler: MessageHandler;
    protected isAnonymous: boolean;
    protected lateAck: boolean;
    protected maxConcurrent: number;
    protected messageTtlMs: number | undefined;
    protected defaultHandler: MessageHandler;
    protected bindings: string[] = []; // Track bound routing keys for reconnection
    private _isInitialized: boolean = false;
    private _wasStarted: boolean = false;

    constructor(connection: IConnection) {
        super();

        this.connection = connection;
        this.queueName = '';
        this.configuredQueueName = '';
        this.exchangeName = '';
        this.exchangeType = '';
        this.consumerTag = '';
        this.handler = undefined;
        this.isAnonymous = true;
        this.lateAck = false;
        this.maxConcurrent = undefined; // only used for late ack workers.
        this.messageTtlMs = undefined;
        this.bindings = [];
        this.defaultHandler = async (message: Buffer/*, correlationId: string*/) => {
            Logger.warn(`unhandled message by default handler ${JSON.stringify(message)}`);
        };

        // Listen for reconnection events
        this.connection.on('reconnected', this._onReconnected.bind(this));
        this.connection.on('disconnected', this._onDisconnected.bind(this));
    }

    get isConnected() { return this.connection.isConnected; }
    get isInitialized() { return this._isInitialized; }

    /**
     * Called when connection is lost
     */
    protected _onDisconnected(): void {
        Logger.debug(`${this.constructor.name}: connection lost, clearing channel state`);
        this.channel = undefined;
        this.consumerTag = '';
        this.emit('disconnected');
    }

    /**
     * Called when connection is re-established - re-initializes the listener
     */
    protected async _onReconnected(): Promise<void> {
        if (!this._isInitialized) {
            // Was never initialized, nothing to restore
            return;
        }

        Logger.info(`${this.constructor.name}: reconnected, re-initializing...`);

        try {
            // Re-initialize channel and queues
            await this._reinitialize();

            // Re-bind all routing keys
            for (const routingKey of this.bindings) {
                await this.connection.bindQueue(this.channel, this.queueName, this.exchangeName, routingKey, {});
                Logger.debug(`${this.constructor.name}: re-bound ${routingKey}`);
            }

            // Restart consuming if we were consuming before
            if (this._wasStarted) {
                await this._startConsuming();
            }

            Logger.info(`${this.constructor.name}: successfully re-initialized after reconnection`);
            this.emit('reconnected');
        } catch (err) {
            Logger.error(`${this.constructor.name}: failed to re-initialize after reconnection: ${err.message}`);
            this.emit('error', err);
        }
    }

    /**
     * Re-initialize channel, exchange and queue without changing configuration
     */
    protected async _reinitialize(): Promise<void> {
        this.channel = await this.connection.openChannel();

        if (this.lateAck) {
            await this.channel.prefetch(this.maxConcurrent, false);
        }

        await this.connection.declareExchange(this.channel, this.exchangeName, this.exchangeType, {
            autoDelete: false,
            durable: true,
            internal: false,
            arguments: {}
        });

        // For anonymous queues, we need to create a new queue (old one is gone)
        // For named queues, we can re-use the same name
        const queueNameToUse = this.isAnonymous ? '' : this.configuredQueueName;

        const queueArguments: Record<string, unknown> = {};
        if (this.messageTtlMs !== undefined) {
            queueArguments['x-message-ttl'] = this.messageTtlMs;
        }
        this.queueName = await this.connection.declareQueue(this.channel, queueNameToUse, {
            autoDelete: this.isAnonymous,
            durable: !this.isAnonymous,
            exclusive: this.isAnonymous,
            arguments: queueArguments
        });

        // For direct exchange, bind queue to itself
        if (this.exchangeType === 'direct') {
            await this.connection.bindQueue(this.channel, this.queueName, this.exchangeName, this.queueName, {});
        }
    }

    /**
     * Start consuming messages
     * Override getRetryOptions() in subclasses to enable retry support
     */
    protected async _startConsuming(): Promise<void> {
        this.consumerTag = randomUUID();
        const options: ConsumeOptions = {
            consumerTag: this.consumerTag,
            noAck: false,
            exclusive: this.isAnonymous,
            noLocal: false,
            arguments: {}
        };
        const retryOptions = this.getRetryOptions();
        await this.connection.consume(this.channel, this.queueName, this.handler, options, this.lateAck, retryOptions);
        Logger.debug(`${this.constructor.name}: started consuming from ${this.queueName}`);
    }

    /**
     * Get retry options for consume. Override in subclasses to enable retry.
     */
    protected getRetryOptions(): ConsumeRetryOptions | undefined {
        return undefined;
    }

    async init(messageHandler: MessageHandler, queueName?: string) {
        if (this._isInitialized) return;
        if (!this.exchangeName) throw new MissingExchangeError();
        if (!this.connection.isConnected) throw new ConnectionError();

        this.handler = messageHandler || this.defaultHandler.bind(this);
        this.isAnonymous = !queueName;
        this.configuredQueueName = queueName || '';

        this.channel = await this.connection.openChannel();
        if (this.lateAck) { // support late ack worker services.
            await this.channel.prefetch(this.maxConcurrent, false);
        }
        await this.connection.declareExchange(this.channel, this.exchangeName, this.exchangeType, {
            autoDelete: false,
            durable: true,
            internal: false,
            arguments: {}
        });
        const queueArguments: Record<string, unknown> = {};
        if (this.messageTtlMs !== undefined) {
            queueArguments['x-message-ttl'] = this.messageTtlMs;
        }
        this.queueName = await this.connection.declareQueue(this.channel, queueName, {
            autoDelete: this.isAnonymous,
            durable: !this.isAnonymous,
            exclusive: this.isAnonymous,
            arguments: queueArguments
        });
        // for direct exchange listeners we can go ahead and bind the queue.
        if (this.exchangeType === 'direct') {
            await this.connection.bindQueue(this.channel, this.queueName, this.exchangeName, this.queueName, {});
        }

        this._isInitialized = true;
        this.emit('initialized', {});
    }

    async start() {
        if (!this._isInitialized) throw new NotInitializedError();
        if (this._wasStarted && this.consumerTag) throw new AlreadyStartedError();
        if (!this.connection.isConnected) throw new NotConnectedError();

        try {
            await this._startConsuming();
            this._wasStarted = true;
            this.emit('started', {});
        } catch (error) {
            if (error instanceof AlreadyStartedError) {
                Logger.warn('service already running. ignoring call to start.');
                return;
            }
            throw error;
        }
    }

    async close() {
        if (!this._isInitialized) throw new NotInitializedError();

        // Remove reconnection listeners
        this.connection.removeListener('reconnected', this._onReconnected.bind(this));
        this.connection.removeListener('disconnected', this._onDisconnected.bind(this));

        if (this.connection.isConnected && this.channel) {
            try {
                if (this.consumerTag) {
                    await this.connection.cancel(this.channel, this.consumerTag);
                }
                await this.connection.closeChannel(this.channel);
            } catch (err) {
                // Channel may already be closed due to connection loss
                Logger.debug(`${this.constructor.name}: error during close (may be expected): ${err.message}`);
            }
        }

        // cleanup
        this.consumerTag = '';
        this.channel = undefined;
        this._isInitialized = false;
        this._wasStarted = false;
        this.bindings = [];
    }

    /**
     * Add a binding to track for reconnection
     */
    protected trackBinding(routingKey: string): void {
        if (!this.bindings.includes(routingKey)) {
            this.bindings.push(routingKey);
        }
    }
}
