import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import { IConnection, Channel, ConsumeOptions, ConsumeRetryOptions, MessageHandler, attachRestorer } from './connection';
import Config from './config';
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
    protected processingTimeoutMs: number | undefined;
    protected defaultHandler: MessageHandler;
    protected bindings: string[] = []; // Track bound routing keys for reconnection
    private _isInitialized: boolean = false;
    private _wasStarted: boolean = false;
    private _detachRestorer: () => void = () => undefined;
    private _restorerAttached: boolean = false;
    private _boundOnDisconnected: () => void;

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
        this.defaultHandler = async (message: Buffer, correlationId?: string) => {
            // Size and correlationId only. Never the body: JSON.stringify
            // renders a Buffer as {"type":"Buffer","data":[...]}, which is
            // payload disclosure with an extra decoding step.
            Logger.warn(
                'unhandled message by default handler ' +
                `(${message?.length ?? 0} bytes, correlationId ${correlationId ?? 'none'})`,
            );
        };

        // Restoration is coordinated by the connection, which waits for it
        // before reporting itself reconnected. Disconnection stays an event:
        // there is nothing to wait for when the socket has already gone.
        this._attachRestorer();
        this._boundOnDisconnected = this._onDisconnected.bind(this);
        this.connection.on('disconnected', this._boundOnDisconnected);
    }

    /**
     * Take part in the connection's restoration.
     *
     * Paired with `_detachRestorer`, and both are idempotent, because the two
     * are not called the same number of times: a listener attaches on
     * construction and again on every `start()`, and detaches on
     * `stopConsuming()` and on `close()`. Re-attaching in `start()` is what
     * keeps stop/start reversible — a listener that resumed consuming but had
     * been dropped from restoration would go quiet for good on the next
     * reconnection, behind a connection reporting itself healthy.
     */
    private _attachRestorer(): void {
        if (this._restorerAttached) return;
        const detach = attachRestorer(
            this.connection, () => this._restore(), this.constructor.name,
        );
        this._restorerAttached = true;
        this._detachRestorer = () => {
            if (!this._restorerAttached) return;
            this._restorerAttached = false;
            detach();
        };
    }

    get isConnected() { return this.connection.isConnected; }
    get isInitialized() { return this._isInitialized; }

    /**
     * Called when connection is lost
     */
    protected _onDisconnected(): void {
        Logger.debug(`${this.constructor.name}: connection lost, clearing channel state`);
        // Try to cancel consumer before clearing channel (in case connection is still valid)
        if (this.consumerTag && this.channel) {
            this.connection.cancel(this.channel, this.consumerTag).catch((error) => {
                Logger.debug(
                    `${this.constructor.name}: failed to cancel consumer '${this.consumerTag}' on disconnect (channel may already be closed): ${error instanceof Error ? error.message : String(error)}`
                );
            });
        }
        this.channel = undefined;
        this.consumerTag = '';
        this.emit('disconnected');
    }

    /**
     * Put this listener's channel, queue, bindings and consumer back.
     *
     * A failure propagates to the connection, which treats the whole
     * generation as unusable and retries. Reporting it here instead would
     * leave a half-restored listener sitting beside a connection that believes
     * it is healthy — and on an 'error' event nothing subscribes to, so the
     * rejection would surface as an unhandled one rather than as anything an
     * operator can act on.
     */
    protected async _restore(): Promise<void> {
        if (!this._isInitialized) {
            // Was never initialized, nothing to restore
            return;
        }

        Logger.info(`${this.constructor.name}: reconnected, re-initializing...`);

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
    }

    /**
     * Re-initialize channel, exchange and queue without changing configuration
     */
    protected async _reinitialize(): Promise<void> {
        this.channel = await this.connection.openChannel();

        if (this.lateAck) {
            await this.channel.prefetch(this.effectivePrefetch(), false);
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
        await this.connection.consume(
            this.channel, this.queueName, this.handler, options,
            this.lateAck, retryOptions, this.processingTimeoutMs,
        );
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
            await this.channel.prefetch(this.effectivePrefetch(), false);
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

        // Restored again from here on: stopConsuming() drops out of
        // restoration, and resuming has to undo that.
        this._attachRestorer();

        // No try//catch for AlreadyStartedError here: it can only be thrown by
        // the guard above, which runs before this point.
        await this._startConsuming();
        this._wasStarted = true;
        this.emit('started', {});
    }

    /**
     * Stop accepting NEW deliveries while leaving the channel open.
     *
     * This is the missing first step of a graceful shutdown. `close()` cancels
     * the consumer and closes the channel in one go, which is too blunt during
     * a drain: handlers still running need the channel to ack and to publish
     * their replies. Cancelling alone lets the broker stop pushing work while
     * everything already in hand can still finish.
     *
     * Safe to call more than once, and safe when already disconnected.
     */
    async stopConsuming(): Promise<void> {
        if (!this.consumerTag) return;

        const tag = this.consumerTag;
        this.consumerTag = '';
        // Cleared too, or a reconnection landing mid-drain restores the
        // consumer and the shutdown starts taking new work again.
        this._wasStarted = false;
        // And stop taking part in restoration at all: a reconnection between
        // here and close() would otherwise open a fresh channel for a listener
        // that is being shut down.
        this._detachRestorer();

        if (!this.connection.isConnected || !this.channel) return;

        try {
            await this.connection.cancel(this.channel, tag);
            Logger.debug(`${this.constructor.name}: stopped consuming (${tag})`);
        } catch (err: any) {
            // The channel may already be gone; nothing left to cancel.
            Logger.debug(
                `${this.constructor.name}: failed to cancel consumer '${tag}' during drain: ${err?.message || err}`,
            );
        }
    }

    async close() {
        if (!this._isInitialized) throw new NotInitializedError();

        // Remove reconnection listeners
        this._detachRestorer();
        this.connection.removeListener('disconnected', this._boundOnDisconnected);

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
     * Prefetch to apply for late-ack consumers.
     *
     * amqplib maps `undefined` (and 0) to prefetchCount 0, which RabbitMQ reads
     * as *unlimited* — with late ack that lets the broker push an entire queue
     * backlog into process memory before anything is acked. Subclasses that
     * enable lateAck without setting maxConcurrent (EventListener) rely on this
     * bounded fallback.
     */
    protected effectivePrefetch(): number {
        const configured = this.maxConcurrent;
        if (typeof configured === 'number' && Number.isInteger(configured) && configured > 0) {
            return configured;
        }
        return Config.defaultPrefetch;
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
