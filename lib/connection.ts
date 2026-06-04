import * as amqplib from 'amqplib';
import { EventEmitter } from 'events';

import Config from './config';
import { Logger } from './logger';

export class AlreadyConnectedError extends Error {}
export class TimeoutError extends Error {}
export class ReconnectionError extends Error {}

export type Channel = amqplib.Channel;
export type ConsumeOptions = amqplib.Options.Consume;
export type PublishOptions = amqplib.Options.Publish;
export type AssertQueueOptions = amqplib.Options.AssertQueue;
export type AssertExchangeOptions = amqplib.Options.AssertExchange;

/**
 * Result a {@link MessageHandler} can return:
 *  - `Buffer`                          → a single unary reply is published
 *  - `void` / `undefined`              → no reply (one-way event or suppressed)
 *  - `AsyncIterable<Buffer>`           → streaming reply; each yielded chunk
 *                                        is published with x-protobus-final=false,
 *                                        the last one with x-protobus-final=true.
 *
 * See `docs/advanced/streaming.md` for the protocol contract.
 */
export type MessageHandlerResult = Buffer | void | AsyncIterable<Buffer>;

export type MessageHandler = (
    content: Buffer,
    correlationId: string,
    headers?: Record<string, any>,
) => Promise<MessageHandlerResult>;

export interface ConsumeRetryOptions {
    maxRetries: number;
    retryQueueName: string;
    /**
     * Topic exchange the retry queue is bound to with `#`. We publish to
     * this exchange (not sendToQueue) so the message's routing key stays
     * set to the original `REQUEST.<service>.<method>`. That's what makes
     * the post-TTL DLX redelivery route correctly to the main queue.
     * When absent we fall back to sendToQueue() — which works for unary
     * tests not relying on redelivery, but redelivery WILL silently drop.
     */
    retryExchangeName?: string;
    dlqName: string;
    isHandledError?: (error: unknown) => boolean;
}

export interface ReconnectionOptions {
    maxRetries?: number;          // Max reconnection attempts (default: 10, 0 = infinite)
    initialDelayMs?: number;      // Initial delay before first retry (default: 1000)
    maxDelayMs?: number;          // Maximum delay between retries (default: 30000)
    backoffMultiplier?: number;   // Multiplier for exponential backoff (default: 2)
}

const DEFAULT_RECONNECTION_OPTIONS: Required<ReconnectionOptions> = {
    maxRetries: 10,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
};

export interface IConnection extends EventEmitter {
    isConnected: boolean;
    isReconnecting: boolean;

    connect(url: string, reconnectionOptions?: ReconnectionOptions): Promise<amqplib.ChannelModel>;
    disconnect(): Promise<any>;
    openChannel(): Promise<Channel>;
    closeChannel(channel: Channel): Promise<any>;
    declareExchange(channel: Channel, exchange: string, type: string, options: AssertExchangeOptions): Promise<any>;
    declareQueue(channel: Channel, queueName: string, options: AssertQueueOptions): Promise<any>;
    bindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any>;
    unbindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any>;
    deleteQueue(channel: Channel, queueName: string): Promise<any>;
    ack(channel: Channel, message: amqplib.Message, upTo?: boolean): Promise<any>;
    reject(channel: Channel, message: amqplib.Message, requeue?: boolean): Promise<any>;
    consume(channel: Channel, queueName: string, messageHandler: MessageHandler, options: ConsumeOptions, lateAck: boolean, retryOptions?: ConsumeRetryOptions): Promise<any>;
    cancel(channel: Channel, consumerTag: string): Promise<any>;
    purgeQueue(channel: Channel, queueName: string): Promise<any>;
    publish(channel: Channel, exchangeName: string, routingKey: string, content: Buffer, properties: PublishOptions): Promise<any>;

    // Events: 'reconnecting', 'reconnected', 'disconnected', 'error'
}

export default class Connection extends EventEmitter implements IConnection {
    private handle: amqplib.ChannelModel;
    private url: string;
    private reconnectionOptions: Required<ReconnectionOptions>;
    private reconnectAttempts: number = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private manualDisconnect: boolean = false;

    private _isConnected: boolean = false;
    public get isConnected() {
        return this._isConnected;
    }

    private _isReconnecting: boolean = false;
    public get isReconnecting() {
        return this._isReconnecting;
    }

    async connect(url: string, reconnectionOptions?: ReconnectionOptions): Promise<amqplib.ChannelModel> {
        if (this.isConnected) throw new AlreadyConnectedError();

        this.url = url;
        this.reconnectionOptions = { ...DEFAULT_RECONNECTION_OPTIONS, ...reconnectionOptions };
        this.manualDisconnect = false;

        return this._connect();
    }

    private async _connect(): Promise<amqplib.ChannelModel> {
        Logger.info('connecting to bus - ' + this.url);

        try {
            this.handle = await amqplib.connect(this.url);
            this._isConnected = true;
            this._isReconnecting = false;
            this.reconnectAttempts = 0;

            // Set up connection event handlers
            this.handle.on('error', (err) => {
                Logger.error(`connection error: ${err.message}`);
                this.emit('error', err);
            });

            this.handle.on('close', () => {
                if (this.manualDisconnect) {
                    Logger.info('connection closed (manual disconnect)');
                    return;
                }

                Logger.warn('connection closed unexpectedly');
                this._isConnected = false;
                this.emit('disconnected');
                this._scheduleReconnect();
            });

            Logger.info('connected to message bus');
            return this.handle;
        } catch (err) {
            Logger.error(`failed to connect: ${err.message}`);
            this._isConnected = false;
            throw err;
        }
    }

    private _scheduleReconnect(): void {
        if (this.manualDisconnect) return;
        if (this._isReconnecting) return;

        const { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier } = this.reconnectionOptions;

        if (maxRetries > 0 && this.reconnectAttempts >= maxRetries) {
            const error = new ReconnectionError(`max reconnection attempts (${maxRetries}) exceeded`);
            Logger.error(error.message);
            this.emit('error', error);
            return;
        }

        this._isReconnecting = true;
        this.reconnectAttempts++;

        // Exponential backoff with jitter
        const baseDelay = Math.min(
            initialDelayMs * Math.pow(backoffMultiplier, this.reconnectAttempts - 1),
            maxDelayMs
        );
        const jitter = Math.random() * 0.3 * baseDelay; // Up to 30% jitter
        const delay = Math.floor(baseDelay + jitter);

        Logger.info(`scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
        this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

        this.reconnectTimer = setTimeout(async () => {
            try {
                await this._connect();
                Logger.info(`reconnection successful after ${this.reconnectAttempts} attempts`);
                this.emit('reconnected');
            } catch (err) {
                Logger.error(`reconnection attempt ${this.reconnectAttempts} failed: ${err.message}`);
                this._isReconnecting = false;
                this._scheduleReconnect();
            }
        }, delay);

        // Don't block Node from exiting if this is the only pending timer
        if (this.reconnectTimer.unref) {
            this.reconnectTimer.unref();
        }
    }

    async disconnect(): Promise<any> {
        this.manualDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this._isReconnecting = false;

        if (this.handle) {
            await this.handle.close();
        }
        this._isConnected = false;
        return;
    }

    async openChannel(): Promise<Channel> {
        return this.handle.createChannel();
    }

    async closeChannel(channel: Channel): Promise<any> {
        return channel.close();
    }

    async declareExchange(channel: Channel, exchange: string, type: string, options: AssertExchangeOptions): Promise<any> {
        return channel.assertExchange(exchange, type, options);
    }

    async declareQueue(channel: Channel, queueName: string, options: AssertQueueOptions): Promise<any> {
        const result = await channel.assertQueue(queueName, options);
        return result.queue;
    }

    async bindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any> {
        return channel.bindQueue(queue, exchange, routingKey, args);
    }

    async unbindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any> {
        return channel.unbindQueue(queue, exchange, routingKey, args);
    }

    async deleteQueue(channel: Channel, queueName: string): Promise<any> {
        return channel.deleteQueue(queueName);
    }

    async ack(channel: Channel, message: amqplib.Message, upTo?: boolean): Promise<any> {
        return channel.ack(message, upTo);
    }

    async reject(channel: Channel, message: amqplib.Message, requeue?: boolean): Promise<any> {
        return channel.reject(message, requeue);
    }

    async consume(channel: Channel, queueName: string, messageHandler: MessageHandler, options: ConsumeOptions, lateAck: boolean, retryOptions?: ConsumeRetryOptions): Promise<any> {
        const onMessage = async (msg: amqplib.Message) => {
            const replyTo = msg.properties.replyTo;
            const correlationId = msg.properties.correlationId;
            const headers = msg.properties.headers || {};
            const retryCount = (headers['x-retry-count'] as number) || 0;
            const originalRoutingKey = (headers['x-original-routing-key'] as string) || msg.fields.routingKey;

            Logger.debug(`incoming message: ${JSON.stringify(msg.fields)}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);

            if (!options.noAck && !lateAck) { // early ackers never reject and immidiately ack
                await this.ack(channel, msg);
            }

            // NOTE: do NOT use `new Promise(async (resolve, reject) => {...})`
            // — async-executor rejections are invisible to the outer Promise
            // constructor, which silently swallowed handler errors and kept
            // the retry/DLQ path below as dead code. A plain try/catch makes
            // errors actually propagate to the catch arm.
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let timedOut = false;
            try {
                timeout = setTimeout(() => {
                    timedOut = true;
                }, Config.messageProcessingTimeout);

                const result = await messageHandler(msg.content, correlationId, headers);
                clearTimeout(timeout);

                if (timedOut) {
                    throw new TimeoutError(`message ${correlationId} timed out`);
                }

                if (!options.noAck && lateAck) { // late ackers ack when processing is done
                    await this.ack(channel, msg);
                }
                if (replyTo) {
                    // Streaming reply: handler returned an AsyncIterable<Buffer>.
                    // Each chunk is published to replyTo with x-protobus-final
                    // headers; see docs/advanced/streaming.md.
                    if (result && !Buffer.isBuffer(result) && typeof (result as any)[Symbol.asyncIterator] === 'function') {
                        await this._publishStreamReply(channel, replyTo, correlationId, result as AsyncIterable<Buffer>);
                    } else if (Buffer.isBuffer(result)) {
                        // Unary reply (current behavior)
                        const p = {
                            contentType: 'application/octet-stream',
                            correlationId,
                        };
                        await this.publish(channel, Config.callbacksExchangeName, replyTo, result, p);
                    }
                }
            } catch (err: any) {
                // clear timeout so we don't get 2 errors for the same message
                clearTimeout(timeout);
                Logger.error(`unhandled error consuming bus message - ${err.message || err}:\n${err.stack}`);

                // If MessageService pre-encoded the error as a ResponseContainer
                // (via the __PROTOBUS_RESPONSE_BUFFER symbol), we use it to
                // reply to the caller on terminal paths (DLQ / no-retry-config).
                // See message_service.ts handleUnaryError for the contract.
                const errorReplyBuffer: Buffer | undefined = (err as any)?.__PROTOBUS_RESPONSE_BUFFER;
                const publishErrorReply = async () => {
                    if (replyTo && errorReplyBuffer) {
                        await this.publish(channel, Config.callbacksExchangeName, replyTo, errorReplyBuffer, {
                            contentType: 'application/octet-stream',
                            correlationId,
                        });
                    }
                };

                if (!options.noAck && lateAck) {
                    // Check if retry is configured and error is retryable
                    const isHandled = retryOptions?.isHandledError?.(err) ?? false;

                    if (retryOptions && !isHandled && retryOptions.maxRetries > 0) {
                        // Retry logic for unhandled errors
                        if (retryCount < retryOptions.maxRetries) {
                            // Park the message on the retry queue for delayed
                            // redelivery. We publish to the retry EXCHANGE with
                            // the original routing key so the message's
                            // routing key is preserved across the queue → TTL
                            // expiry → DLX → main exchange round-trip. Without
                            // that, the redelivery's routing key would be the
                            // retry queue name and the main queue's binding
                            // wouldn't match — see message_listener.ts.
                            //
                            // The caller stays parked: no reply published here.
                            const newRetryCount = retryCount + 1;
                            Logger.warn(`retrying message ${correlationId} (attempt ${newRetryCount}/${retryOptions.maxRetries})`);

                            const retryHeaders = {
                                ...headers,
                                'x-retry-count': newRetryCount,
                                'x-original-routing-key': originalRoutingKey,
                                'x-first-failure-time': headers['x-first-failure-time'] || Date.now(),
                                'x-last-error': err.message || String(err),
                            };

                            if (retryOptions.retryExchangeName) {
                                // Preferred path: routing-key-preserving publish.
                                await this.publish(
                                    channel,
                                    retryOptions.retryExchangeName,
                                    originalRoutingKey,
                                    msg.content,
                                    {
                                        persistent: true,
                                        correlationId,
                                        replyTo,
                                        headers: retryHeaders,
                                    },
                                );
                            } else {
                                // Fallback for legacy callers that didn't wire
                                // a retry exchange. Works for the immediate
                                // first hop; the DLX redelivery will drop.
                                await channel.sendToQueue(retryOptions.retryQueueName, msg.content, {
                                    persistent: true,
                                    correlationId,
                                    replyTo,
                                    headers: retryHeaders,
                                });
                            }
                            await this.ack(channel, msg);
                        } else {
                            // Max retries exceeded — terminal failure. Reply to
                            // the caller with the encoded error so they get a
                            // thrown exception instead of timing out, THEN send
                            // the message to the DLQ for ops investigation.
                            Logger.error(`message ${correlationId} exceeded max retries (${retryOptions.maxRetries}), sending to DLQ`);

                            await publishErrorReply();

                            const dlqHeaders = {
                                ...headers,
                                'x-retry-count': retryCount,
                                'x-original-routing-key': originalRoutingKey,
                                'x-original-queue': queueName,
                                'x-first-failure-time': headers['x-first-failure-time'] || Date.now(),
                                'x-dlq-time': Date.now(),
                                'x-last-error': err.message || String(err),
                            };

                            await channel.sendToQueue(retryOptions.dlqName, msg.content, {
                                persistent: true,
                                correlationId,
                                headers: dlqHeaders,
                            });
                            await this.ack(channel, msg);
                        }
                    } else {
                        // No retry configured (or retries disabled / handled
                        // error). Reply to the caller with the encoded error,
                        // then reject without requeue so we don't loop forever.
                        if (isHandled) {
                            Logger.warn(`handled error for message ${correlationId}, not retrying: ${err.message}`);
                        }
                        await publishErrorReply();
                        Logger.warn(`rejecting message ${correlationId}`);
                        await this.reject(channel, msg, false);
                    }
                }
            }
        };
        await channel.consume(queueName, onMessage, options);
    }

    async cancel(channel: Channel, consumerTag: string): Promise<any> {
        return channel.cancel(consumerTag);
    }

    async purgeQueue(channel: Channel, queueName: string): Promise<any> {
        return channel.purgeQueue(queueName);
    }

    async publish(channel: Channel, exchangeName: string,
      routingKey: string, content: Buffer, properties: PublishOptions): Promise<any> {
        channel.publish(exchangeName, routingKey, content, properties);
    }

    /**
     * Publish a streaming reply: each chunk gets the same correlationId; all
     * chunks but the last carry `x-protobus-final=false`, the last carries
     * `x-protobus-final=true`. If the iterable yields nothing, a single empty
     * terminal message is published so the client iterator ends cleanly.
     *
     * Look-ahead-by-one keeps us from needing an extra empty terminal in the
     * common case where the user's generator yields its final-data chunk last.
     */
    private async _publishStreamReply(
        channel: Channel,
        replyTo: string,
        correlationId: string,
        chunks: AsyncIterable<Buffer>,
    ): Promise<void> {
        const publishOne = async (body: Buffer, seq: number, final: boolean): Promise<void> => {
            await this.publish(channel, Config.callbacksExchangeName, replyTo, body, {
                contentType: 'application/octet-stream',
                correlationId,
                headers: {
                    [Config.HEADER_FINAL]: final,
                    [Config.HEADER_SEQ]: seq,
                },
            });
        };

        let seq = 0;
        let buffered: Buffer | undefined = undefined;

        for await (const chunk of chunks) {
            if (buffered !== undefined) {
                await publishOne(buffered, seq, false);
                seq++;
            }
            buffered = chunk;
        }

        if (buffered !== undefined) {
            await publishOne(buffered, seq, true);
        } else {
            // Empty stream — terminal-only marker so the client iterator can stop.
            await publishOne(Buffer.alloc(0), 0, true);
        }
    }
}
